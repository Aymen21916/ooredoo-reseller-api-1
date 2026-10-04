'use strict';

const db = require('../config/db');
const AppError = require('../utils/AppError');
const { asyncHandler, sendCreated, sendSuccess } = require('../utils/asyncHandler');
const { audit } = require('../utils/audit');
const { requireFields, parseId, parsePositiveNumber, validateAmount, validateVoidReason } = require('../utils/validators');
const { callOoredooApi } = require('../services/ooredooService');

const resolveActiveSession = async (sessionId, cashierId, client = db) => {
  const { rows } = await client.query(`SELECT cs.*, u.store_id FROM cashier_sessions cs JOIN users u ON u.id = cs.cashier_id WHERE cs.id = $1`, [sessionId]);
  if (!rows[0]) throw AppError.notFound('Session not found.');
  if (rows[0].cashier_id !== cashierId) throw AppError.forbidden('You do not own this session.');
  if (rows[0].status !== 'open') throw AppError.conflict('Cannot add sales to a closed session.', 'SESSION_CLOSED');
  return rows[0];
};

const applyLoyaltyRules = async (client, customerId, type, amountSpent, itemLoyaltyPoints = 0, requestedPointsToRedeem = 0) => {
  if (!customerId) return { discountValue: 0, pointsEarned: 0, pointsRedeemed: 0, newBalance: 0 };

  const { rows: sRows } = await client.query('SELECT key, value FROM loyalty_settings');
  const settings = sRows.reduce((acc, row) => ({ ...acc, [row.key]: parseFloat(row.value) }), {});

  const { rows: cRows } = await client.query(`SELECT * FROM customers WHERE id = $1 FOR UPDATE`, [customerId]);
  const customer = cRows[0];
  if (!customer) return { discountValue: 0, pointsEarned: 0, pointsRedeemed: 0, newBalance: 0 };

  let discountValue = 0; let actualRedeemed = 0;
  if (requestedPointsToRedeem > 0) {
    if (customer.available_points < requestedPointsToRedeem) throw AppError.badRequest('Customer does not have enough points.');
    if (customer.available_points < (settings.min_points_to_redeem || 600)) throw AppError.badRequest(`Need at least ${settings.min_points_to_redeem || 600} points to spend.`);
    
    actualRedeemed = requestedPointsToRedeem;
    discountValue = actualRedeemed * (settings.point_to_dzd_value || 1);
    if (discountValue > amountSpent) { discountValue = amountSpent; actualRedeemed = discountValue / (settings.point_to_dzd_value || 1); }

    await client.query(`UPDATE customers SET available_points = available_points - $1 WHERE id = $2`, [actualRedeemed, customer.id]);
    await client.query(`INSERT INTO loyalty_ledger (customer_id, points, transaction_type, description) VALUES ($1, $2, 'spend', 'Redeemed points')`, [customer.id, -actualRedeemed]);
  }

  let earned = type === 'storm' ? amountSpent * ((settings.storm_earn_percent || 1.0) / 100) : itemLoyaltyPoints;
  const ledgerEntries = [];
  if (earned > 0) ledgerEntries.push([earned, 'earn', `Earned from ${type} purchase`]);

  if (amountSpent >= (settings.visit_bonus_min_spend || 500)) {
    const today = new Date();
    const lastVisit = customer.last_purchase_at ? new Date(customer.last_purchase_at) : null;
    if (lastVisit && lastVisit.getMonth() === today.getMonth() && lastVisit.getFullYear() === today.getFullYear() && lastVisit.getDate() !== today.getDate()) {
      const bonus = settings.visit_bonus_points || 25;
      earned += bonus;
      ledgerEntries.push([bonus, 'bonus_visit', 'Same month returning visit bonus']);
    }
  }

  if (customer.referred_by && !customer.referral_rewarded && amountSpent > 0) {
    const refBonus = settings.referral_bonus_points || 25;
    await client.query(`UPDATE customers SET available_points = available_points + $1, lifetime_points = lifetime_points + $1 WHERE id = $2`, [refBonus, customer.referred_by]);
    await client.query(`INSERT INTO loyalty_ledger (customer_id, points, transaction_type, description) VALUES ($1, $2, 'bonus_referral', 'Referral bonus unlocked')`, [customer.referred_by, refBonus]);
    await client.query(`UPDATE customers SET referral_rewarded = TRUE WHERE id = $1`, [customer.id]);
  }

  if (earned > 0) {
    await client.query(`UPDATE customers SET available_points = available_points + $1, lifetime_points = lifetime_points + $1 WHERE id = $2`, [earned, customer.id]);
    for (const [pts, tType, desc] of ledgerEntries) await client.query(`INSERT INTO loyalty_ledger (customer_id, points, transaction_type, description) VALUES ($1, $2, $3, $4)`, [customer.id, pts, tType, desc]);
  }
  if (amountSpent > 0) await client.query(`UPDATE customers SET last_purchase_at = NOW() WHERE id = $1`, [customer.id]);

  const { rows: finalCust } = await client.query(`SELECT available_points FROM customers WHERE id = $1`, [customer.id]);
  const newBalance = finalCust[0] ? parseFloat(finalCust[0].available_points) : 0;

  return { discountValue, pointsEarned: earned, pointsRedeemed: actualRedeemed, newBalance };
};

const recordSimSale = asyncHandler(async (req, res) => {
  requireFields(req.body, ['session_id', 'offer_id']);
  const sessionId = parseId(req.body.session_id, 'session_id');
  const offerId = parseId(req.body.offer_id, 'offer_id');
  const appInstalled = req.body.my_ooredoo_app_installed === true || req.body.my_ooredoo_app_installed === 'true';
  const customerId = req.body.customer_id ? parseId(req.body.customer_id, 'customer_id') : null;
  const discountAmount = req.body.discount_amount ? parseFloat(req.body.discount_amount) : 0;
  const requestedPointsToRedeem = req.body.points_redeemed ? parseFloat(req.body.points_redeemed) : 0;
  
  if (discountAmount < 0) throw AppError.badRequest('Discount cannot be negative.');

  const result = await db.withTransaction(async (client) => {
    const session = await resolveActiveSession(sessionId, req.user.id, client);
    
    const { rows: stockRows } = await client.query(
      `UPDATE sim_balances 
       SET quantity = quantity - 1
       WHERE owner_type = 'store' AND owner_id = $1 AND quantity > 0
       RETURNING quantity`,
      [session.store_id]
    );

    if (!stockRows[0]) {
      throw AppError.conflict('Out of stock. You do not have any SIM cards assigned to you.', 'OUT_OF_STOCK');
    }

    let customerName = 'Walk-in Customer';
    if (customerId) {
      const { rows: cRows } = await client.query(`SELECT id, first_name, last_name FROM customers WHERE id = $1`, [customerId]);
      if (!cRows[0]) throw AppError.notFound('Customer not found.');
      customerName = `${cRows[0].first_name} ${cRows[0].last_name}`;
    }

    const { rows: offerRows } = await client.query(`SELECT name, real_price, selling_price, commission_points, loyalty_points, commission_amount, is_active FROM offers WHERE id = $1 FOR SHARE`, [offerId]);
    if (!offerRows[0]) throw AppError.notFound('Offer not found.');

    const offer = offerRows[0];
    
    const maxDiscountAllowed = Number(offer.selling_price) + Number(offer.commission_points) - Number(offer.real_price);
    
    if (discountAmount > maxDiscountAllowed) {
      throw AppError.badRequest(`Discount too large! The maximum manual discount allowed is ${maxDiscountAllowed} DA to avoid selling at a loss.`, 'EXCESSIVE_DISCOUNT');
    }

    const baseSellingPrice = offer.selling_price - discountAmount;
    const { discountValue, pointsEarned, pointsRedeemed, newBalance } = customerId ? await applyLoyaltyRules(client, customerId, 'sim', baseSellingPrice, offer.loyalty_points, requestedPointsToRedeem) : { discountValue: 0, pointsEarned: 0, pointsRedeemed: 0, newBalance: 0 };
    const finalPaidCash = baseSellingPrice - discountValue;
    
    let appCommission = 0;
    if (appInstalled) {
      const { rows: pRows } = await client.query(`SELECT value FROM payroll_settings WHERE key = 'app_install_commission'`);
      appCommission = pRows[0] ? parseFloat(pRows[0].value) || 0 : 0;
    }

    const { rows } = await client.query(
      `INSERT INTO session_sim_sales (session_id, offer_id, customer_id, offer_name_snapshot, real_price_snapshot, selling_price_snapshot, discount_snapshot, commission_points_snapshot, commission_snapshot, loyalty_earned_snapshot, loyalty_redeemed_snapshot, my_ooredoo_app_installed, app_commission_snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [sessionId, offerId, customerId, offer.name, offer.real_price, baseSellingPrice, discountAmount, offer.commission_points, offer.commission_amount, pointsEarned, pointsRedeemed, appInstalled, appCommission]
    );

    const descExtra = pointsRedeemed > 0 ? ' (Loyalty Discount)' : '';
    
    return { 
      ...rows[0], type: 'sim', description: offer.name + descExtra, 
      created_at: rows[0].sold_at, 
      amount: finalPaidCash, 
      customer_name: customerName,
      points_earned: pointsEarned, points_redeemed: pointsRedeemed, new_points_balance: newBalance 
    };
  });

  sendCreated(res, result, 'SIM sale recorded successfully.');
});

const recordStormEntry = asyncHandler(async (req, res) => {
  requireFields(req.body, ['session_id', 'amount']);
  const sessionId = parseId(req.body.session_id, 'session_id');
  const amount = parsePositiveNumber(req.body.amount, 'amount');
  const requestedPointsToRedeem = req.body.points_redeemed ? parseFloat(req.body.points_redeemed) : 0;
  const customerId = req.body.customer_id ? parseId(req.body.customer_id, 'customer_id') : null;
  const note = req.body.note ? String(req.body.note).trim().slice(0, 500) : (req.body.phone_number ? req.body.phone_number : null);
  const isPopNumber = req.body.is_pop_number === true || req.body.is_pop_number === 'true';
  const popCycle = isPopNumber ? parseInt(req.body.pop_cycle, 10) : null;
if (isPopNumber && !customerId) throw AppError.badRequest('A customer phone number is required to flag a POP number.', 'CUSTOMER_REQUIRED');
if (isPopNumber && ![1, 8, 15, 22].includes(popCycle)) throw AppError.badRequest('Choose a POP cycle (1, 8, 15 or 22).', 'INVALID_POP_CYCLE');

  // Client type (optional): regular | corporate (+ the client's custcode)
  const clientType = ['regular', 'corporate'].includes(req.body.client_type) ? req.body.client_type : null;
  const custCode = clientType === 'corporate' ? String(req.body.cust_code || '').trim() : null;
  if (req.body.client_type && !clientType) throw AppError.badRequest('client_type must be "regular" or "corporate".', 'INVALID_CLIENT_TYPE');
  if (clientType && !customerId) throw AppError.badRequest('A customer phone number is required to set the client type.', 'CUSTOMER_REQUIRED');
  if (clientType === 'corporate' && !/^[A-Za-z0-9._\-\/]{1,30}$/.test(custCode)) throw AppError.badRequest('Enter the corporate client custcode (letters, digits, - _ . / only, max 30 characters).', 'INVALID_CUST_CODE');
  if (isPopNumber && !customerId) throw AppError.badRequest('A customer phone number is required to flag a POP number.', 'CUSTOMER_REQUIRED');  

  const discountAmount = req.body.discount_amount ? parseFloat(req.body.discount_amount) : 0;
  if (discountAmount < 0) throw AppError.badRequest('Discount cannot be negative.');

  const result = await db.withTransaction(async (client) => {
    const session = await resolveActiveSession(sessionId, req.user.id, client);
    
    const baseSellingPrice = amount - discountAmount;
    if (baseSellingPrice < 0) throw AppError.badRequest('Discount cannot exceed the storm amount.');

    const { discountValue, pointsEarned, pointsRedeemed, newBalance } = customerId ? await applyLoyaltyRules(client, customerId, 'storm', baseSellingPrice, 0, requestedPointsToRedeem) : { discountValue: 0, pointsEarned: 0, pointsRedeemed: 0, newBalance: 0 };
    
    const { rows } = await client.query(
      `INSERT INTO session_storm_entries (session_id, customer_id, amount, note, loyalty_earned_snapshot, loyalty_redeemed_snapshot, is_pop_number, pop_cycle, client_type, cust_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [sessionId, customerId, baseSellingPrice, note ? note + ` (Orig: ${amount})` : `Orig: ${amount}`, pointsEarned, pointsRedeemed, isPopNumber, popCycle, clientType, custCode]
    );

    const finalPaidCash = baseSellingPrice - discountValue;

    if (isPopNumber) {
  await client.query(
    `UPDATE customers
        SET is_pop = TRUE, pop_cycle = $2, pop_marked_at = COALESCE(pop_marked_at, NOW())
      WHERE id = $1`,
    [customerId, popCycle]
  );
}
    
    if (clientType) {
      await client.query(
        `UPDATE customers SET client_type = $2, cust_code = $3 WHERE id = $1`,
        [customerId, clientType, custCode]
      );
    }

    const baseDesc = rows[0].note || 'Storm / Bundle';
    const descExtra = pointsRedeemed > 0 ? ' (Loyalty Discount)' : '';
    
    return { 
      ...rows[0], type: 'storm', description: baseDesc + descExtra, 
      created_at: rows[0].entered_at, 
      amount: finalPaidCash, 
      points_earned: pointsEarned, points_redeemed: pointsRedeemed, new_points_balance: newBalance 
    };
  });

  sendCreated(res, result, 'Storm entry recorded.');
});

const recordAccessorySale = asyncHandler(async (req, res) => {
  requireFields(req.body, ['session_id', 'product_id']);
  const sessionId = parseId(req.body.session_id, 'session_id');
  const productId = parseId(req.body.product_id, 'product_id');
  const customerId = req.body.customer_id ? parseId(req.body.customer_id, 'customer_id') : null;
  const requestedPointsToRedeem = req.body.points_redeemed ? parseFloat(req.body.points_redeemed) : 0;
  
  const discountAmount = req.body.discount_amount ? parseFloat(req.body.discount_amount) : 0;
  if (discountAmount < 0) throw AppError.badRequest('Discount cannot be negative.');

  const result = await db.withTransaction(async (client) => {
    const session = await resolveActiveSession(sessionId, req.user.id, client);
    const { rows: prodRows } = await client.query(`SELECT p.name as product_name, p.price, p.real_price, COALESCE(p.loyalty_points, 0) as loyalty_points, p.commission_amount, pc.name as category_name FROM products p JOIN product_categories pc ON pc.id = p.category_id WHERE p.id = $1`, [productId]);
    if (!prodRows[0]) throw AppError.notFound('Product not found.');

    const product = prodRows[0];

    const maxDiscountAllowed = Number(product.price) - Number(product.real_price);
    
    if (discountAmount > maxDiscountAllowed) {
      throw AppError.badRequest(`Discount too large! The maximum manual discount allowed is ${maxDiscountAllowed} DA to avoid selling at a loss.`, 'EXCESSIVE_DISCOUNT');
    }

    const baseSellingPrice = product.price - discountAmount;

    const { discountValue, pointsEarned, pointsRedeemed, newBalance } = customerId ? await applyLoyaltyRules(client, customerId, 'accessory', baseSellingPrice, product.loyalty_points, requestedPointsToRedeem) : { discountValue: 0, pointsEarned: 0, pointsRedeemed: 0, newBalance: 0 };
    
    const { rows } = await client.query(
      `INSERT INTO session_accessory_sales (session_id, product_id, customer_id, product_name_snapshot, category_name_snapshot, price_snapshot, real_price_snapshot, commission_snapshot, loyalty_earned_snapshot, loyalty_redeemed_snapshot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [sessionId, productId, customerId, product.product_name, product.category_name, baseSellingPrice, product.real_price, product.commission_amount, pointsEarned, pointsRedeemed]
    );

    const finalPaidCash = baseSellingPrice - discountValue;
    
    const descExtra = pointsRedeemed > 0 ? ' (Loyalty Discount)' : '';
    
    return { 
      ...rows[0], type: 'accessory', description: product.product_name + descExtra, 
      created_at: rows[0].sold_at, 
      amount: finalPaidCash,
      points_earned: pointsEarned, points_redeemed: pointsRedeemed, new_points_balance: newBalance 
    };
  });

  sendCreated(res, result, 'Accessory sale recorded.');
});

const recordDebt = asyncHandler(async (req, res) => {
  requireFields(req.body, ['session_id', 'amount']);
  const sessionId = parseId(req.body.session_id, 'session_id');
  const rawCustomerId = req.body.customer_id;
  const rawPhoneNumber = req.body.phone_number;

  if (!rawCustomerId && !rawPhoneNumber) throw AppError.badRequest('A linked customer is required for every debt.', 'CUSTOMER_REQUIRED');
  const amount = validateAmount(req.body.amount, { min: 0.01, max: 9999999999.99, decimals_allowed: 2, fieldName: 'amount' });
  let description = req.body.description ? String(req.body.description).trim().slice(0, 1000) : null;

  const result = await db.withTransaction(async (client) => {
    const session = await resolveActiveSession(sessionId, req.user.id, client);
    let customer = null;
    if (rawCustomerId) {
      const { rows } = await client.query(`SELECT id, first_name, last_name FROM customers WHERE id = $1`, [parseId(rawCustomerId, 'customer_id')]);
      customer = rows[0] || null;
    } else {
      const { rows } = await client.query(`SELECT id, first_name, last_name FROM customers WHERE phone_number = $1`, [rawPhoneNumber.trim()]);
      customer = rows[0] || null;
    }
    if (!customer) throw AppError.notFound('Customer not found.', 'CUSTOMER_NOT_FOUND');

    const { rows: insertRows } = await client.query(`INSERT INTO session_debts (session_id, customer_id, amount, description) VALUES ($1, $2, $3, $4) RETURNING *`, [session.id, customer.id, amount, description]);
    return { ...insertRows[0], type: 'debt', description: insertRows[0].description || 'Client Debt', created_at: insertRows[0].entered_at, customer_name: `${customer.first_name} ${customer.last_name}` };
  });

  sendCreated(res, result, 'Debt recorded.');
});

const getSessionHistory = asyncHandler(async (req, res) => {
  const sessionId = req.params.sessionId;
  
  const { rows: sRows } = await db.query("SELECT value FROM loyalty_settings WHERE key = 'point_to_dzd_value'");
  const ptVal = sRows[0] ? parseFloat(sRows[0].value) : 1;

  const { rows } = await db.query(`
    SELECT 'sim' as type, id, 
           offer_name_snapshot as description, 
           (selling_price_snapshot - (COALESCE(loyalty_redeemed_snapshot, 0) * $2)) as amount,
           COALESCE(loyalty_earned_snapshot, 0) as points_earned,
           COALESCE(loyalty_redeemed_snapshot, 0) as points_redeemed, 
           sold_at AS created_at, is_voided 
    FROM session_sim_sales WHERE session_id = $1
    
    UNION ALL 
    
    SELECT 'storm' as type, id, 
           COALESCE(note, 'Storm / Bundle') as description, 
           (amount - (COALESCE(loyalty_redeemed_snapshot, 0) * $2)) as amount,
           COALESCE(loyalty_earned_snapshot, 0) as points_earned,
           COALESCE(loyalty_redeemed_snapshot, 0) as points_redeemed, 
           entered_at AS created_at, is_voided 
    FROM session_storm_entries WHERE session_id = $1
    
    UNION ALL 
    
    SELECT 'accessory' as type, id, 
           product_name_snapshot as description, 
           (price_snapshot - (COALESCE(loyalty_redeemed_snapshot, 0) * $2)) as amount,
           COALESCE(loyalty_earned_snapshot, 0) as points_earned,
           COALESCE(loyalty_redeemed_snapshot, 0) as points_redeemed, 
           sold_at AS created_at, is_voided 
    FROM session_accessory_sales WHERE session_id = $1
    
    UNION ALL 
    
    SELECT 'debt' as type, id, COALESCE(description, 'Client Debt') as description, amount, 0 as points_earned, 0 as points_redeemed, entered_at AS created_at, is_voided 
    FROM session_debts WHERE session_id = $1
    ORDER BY created_at DESC
  `, [sessionId, ptVal]);
  res.json({ success: true, data: rows });
});

const voidTransaction = asyncHandler(async (req, res) => {
  const { type, id } = req.params;
  const tableMap = { sim: 'session_sim_sales', storm: 'session_storm_entries', accessory: 'session_accessory_sales', debt: 'session_debts' };
  const table = tableMap[type];
  if (!table) throw AppError.badRequest('Invalid transaction type.', 'VALIDATION_ERROR');
  const transactionId = parseId(id, 'id');
  const reason = validateVoidReason(req.body && req.body.reason);

  const { rows: sRows } = await db.query("SELECT value FROM loyalty_settings WHERE key = 'point_to_dzd_value'");
  const ptVal = sRows[0] ? parseFloat(sRows[0].value) : 1;

  await db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT t.*, cs.cashier_id, u.store_id FROM ${table} t JOIN cashier_sessions cs ON cs.id = t.session_id JOIN users u ON u.id = cs.cashier_id WHERE t.id = $1 FOR UPDATE`, [transactionId]);
    const row = rows[0];
    if (!row) throw AppError.notFound('Transaction not found.');
    if (row.is_voided) throw AppError.conflict('Transaction is already voided.', 'ALREADY_VOIDED');

    await client.query(`UPDATE ${table} SET is_voided = TRUE, voided_at = NOW(), voided_by = $1, void_reason = $2 WHERE id = $3`, [req.user.id, reason, transactionId]);

    if (type !== 'debt' && row.customer_id) {
      const earned = parseFloat(row.loyalty_earned_snapshot || 0);
      const redeemed = parseFloat(row.loyalty_redeemed_snapshot || 0);
      if (earned > 0 || redeemed > 0) {
        await client.query(`UPDATE customers SET available_points = available_points - $1 + $2 WHERE id = $3`, [earned, redeemed, row.customer_id]);
        if (earned > 0) await client.query(`UPDATE customers SET lifetime_points = GREATEST(lifetime_points - $1, 0) WHERE id = $2`, [earned, row.customer_id]);
        await client.query(`INSERT INTO loyalty_ledger (customer_id, points, transaction_type, description) VALUES ($1, $2, 'void_reversal', 'Reversal for voided transaction')`, [row.customer_id, redeemed - earned]);
      }
    }
  });

  sendSuccess(res, null, 200, 'Transaction voided.');
});

const proxyNbservice = asyncHandler(async (req, res) => {
  try {
    const response = await callOoredooApi(req.body);
    res.status(response.status).json(response.data);
  } catch (error) { throw AppError.internal('Failed to reach Ooredoo USSD service: ' + error.message); }
});

module.exports = { recordSimSale, recordStormEntry, recordAccessorySale, recordDebt, getSessionHistory, voidTransaction, proxyNbservice };