'use strict';

const db = require('../config/db');
const AppError = require('../utils/AppError');
const { asyncHandler, sendSuccess, sendCreated } = require('../utils/asyncHandler');
const { audit } = require('../utils/audit');
const { requireFields, parseId, parseString, parsePagination } = require('../utils/validators');
const xlsx = require('xlsx');

const normalisePhone = (raw) => {
  const s = String(raw || '').trim();
  const cleaned = s.startsWith('+') ? '+' + s.slice(1).replace(/\D/g, '') : s.replace(/\D/g, '');
  if (cleaned.length < 6 || cleaned.length > 20) throw AppError.badRequest('Phone number looks invalid (6-20 digits required).', 'VALIDATION_ERROR');
  return cleaned;
};

const getLoyaltySettings = async (client) => {
  try {
    const { rows } = await client.query('SELECT key, value FROM loyalty_settings');
    return rows.reduce((acc, row) => ({ ...acc, [row.key]: parseFloat(row.value) }), {});
  } catch (e) { return {}; }
};

const assignTier = (lifetimePoints, settings) => {
  if (lifetimePoints >= (settings.tier_vvip || 1500)) return 'VVIP';
  if (lifetimePoints >= (settings.tier_vip || 1000)) return 'VIP';
  if (lifetimePoints >= (settings.tier_gold || 750)) return 'Gold';
  if (lifetimePoints >= (settings.tier_silver || 500)) return 'Silver';
  if (lifetimePoints >= (settings.tier_bronze || 250)) return 'Bronze';
  return 'Regular';
};

const determineReward = (simCount) => {
  if (!simCount || simCount === 0) return 'None';
  const rem = simCount % 6;
  if (rem === 0) return '50% Off Next SIM';
  if (rem >= 3) return 'Eligible for Gift';
  return 'None';
};

const stats = async (client, customerId, lifetimePoints = 0, settings = {}) => {
  const ptVal = settings.point_to_dzd_value || 1;
  const [{ rows: simRows }, { rows: stormRows }, { rows: accRows }] = await Promise.all([
    client.query(`SELECT COUNT(*) FILTER (WHERE is_voided = FALSE) AS sim_count, COALESCE(SUM(selling_price_snapshot) FILTER (WHERE is_voided = FALSE), 0) AS sim_total, COALESCE(SUM(loyalty_redeemed_snapshot) FILTER (WHERE is_voided = FALSE), 0) AS sim_pts, MAX(sold_at) AS sim_last FROM session_sim_sales WHERE customer_id = $1`, [customerId]),
    client.query(`SELECT COUNT(*) FILTER (WHERE is_voided = FALSE) AS storm_count, COALESCE(SUM(amount) FILTER (WHERE is_voided = FALSE), 0) AS storm_total, COALESCE(SUM(loyalty_redeemed_snapshot) FILTER (WHERE is_voided = FALSE), 0) AS storm_pts, MAX(entered_at) AS storm_last FROM session_storm_entries WHERE customer_id = $1`, [customerId]),
    client.query(`SELECT COUNT(*) FILTER (WHERE is_voided = FALSE) AS acc_count, COALESCE(SUM(price_snapshot) FILTER (WHERE is_voided = FALSE), 0) AS acc_total, COALESCE(SUM(price_snapshot - real_price_snapshot) FILTER (WHERE is_voided = FALSE), 0) AS acc_profit, COALESCE(SUM(loyalty_redeemed_snapshot) FILTER (WHERE is_voided = FALSE), 0) AS acc_pts, MAX(sold_at) AS acc_last FROM session_accessory_sales WHERE customer_id = $1`, [customerId])
  ]);

  const sim_count   = parseInt(simRows[0].sim_count, 10);
  const storm_count = parseInt(stormRows[0].storm_count, 10);
  const acc_count   = parseInt(accRows[0].acc_count, 10);
  
  const sim_total   = parseFloat(simRows[0].sim_total) - (parseFloat(simRows[0].sim_pts) * ptVal);
  const storm_total = parseFloat(stormRows[0].storm_total) - (parseFloat(stormRows[0].storm_pts) * ptVal);
  const acc_total   = parseFloat(accRows[0].acc_total) - (parseFloat(accRows[0].acc_pts) * ptVal);
  
  const acc_profit  = parseFloat(accRows[0].acc_profit);
  const total_spent = sim_total + storm_total + acc_total;
  const lasts = [simRows[0].sim_last, stormRows[0].storm_last, accRows[0].acc_last].filter(Boolean).map((d) => new Date(d).getTime());

  return {
    sim_count, storm_count, accessory_count: acc_count, sim_total, storm_total, accessory_total: acc_total, accessory_profit: acc_profit,
    total_spent, tier: assignTier(lifetimePoints, settings), reward: determineReward(sim_count), last_purchase_at: lasts.length ? new Date(Math.max(...lasts)).toISOString() : null,
  };
};

const lookupByPhone = asyncHandler(async (req, res) => {
  if (!req.query.phone) throw AppError.badRequest('phone is required.', 'VALIDATION_ERROR');
  const { rows } = await db.query(`SELECT id, phone_number, first_name, last_name, address, profession, notes, created_at, available_points, lifetime_points, is_pop, pop_cycle, client_type, cust_code FROM customers WHERE phone_number = $1`, [normalisePhone(req.query.phone)]);
  if (!rows[0]) return sendSuccess(res, null);
  const settings = await getLoyaltySettings(db);
  const s = await stats(db, rows[0].id, parseFloat(rows[0].lifetime_points) || 0, settings);
  sendSuccess(res, { ...rows[0], available_points: parseFloat(rows[0].available_points) || 0, lifetime_points: parseFloat(rows[0].lifetime_points) || 0, stats: s });
});

const listCustomers = asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query);
  const params = [];
  let dSim = '', dStorm = '', dAcc = '';

  if (req.query.from) { params.push(req.query.from + ' 00:00:00'); dSim += ` AND sold_at >= $${params.length}`; dStorm += ` AND entered_at >= $${params.length}`; dAcc += ` AND sold_at >= $${params.length}`; }
  if (req.query.to) { params.push(req.query.to + ' 23:59:59'); dSim += ` AND sold_at <= $${params.length}`; dStorm += ` AND entered_at <= $${params.length}`; dAcc += ` AND sold_at <= $${params.length}`; }

  const conditions = [];
  if (req.query.q) { params.push(`%${req.query.q}%`); conditions.push(`(c.phone_number ILIKE $${params.length} OR (c.first_name || ' ' || c.last_name) ILIKE $${params.length})`); }
  if (req.query.type === 'sim') conditions.push('sim_stats.sim_count > 0');
  if (req.query.type === 'storm') conditions.push('storm_stats.storm_count > 0');
  if (req.query.type === 'accessory') conditions.push('acc_stats.acc_count > 0');
  if (req.query.offer_id) { params.push(String(req.query.offer_id)); conditions.push(`$${params.length} = ANY(sim_stats.purchased_offers::text[])`); }
  if (req.query.created_by) { params.push(parseInt(req.query.created_by, 10)); conditions.push(`c.created_by = $${params.length}`); }
  if (req.query.validation === 'invalid') conditions.push(`v.status = 'invalid'`);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);
  
  const settings = await getLoyaltySettings(db);
  const ptVal = settings.point_to_dzd_value || 1;

  // Added c.created_by to the SELECT query here
  const { rows } = await db.query(
    `SELECT c.id, c.phone_number, c.first_name, c.last_name, c.address, c.profession, c.notes, c.created_by, c.created_at, c.updated_at, c.available_points, c.lifetime_points, c.is_pop, c.pop_cycle, c.client_type, c.cust_code,
       v.status AS validation_status, v.review_note AS validation_note,
       (SELECT COUNT(*) FROM customer_corrections cc WHERE cc.customer_id = c.id AND cc.status = 'pending')::int AS pending_corrections,
       COALESCE(sim_stats.sim_count, 0) AS sim_count, 
       (COALESCE(sim_stats.sim_base, 0) - (COALESCE(sim_stats.sim_pts, 0) * ${ptVal})) AS sim_total, 
       sim_stats.purchased_offers,
       COALESCE(storm_stats.storm_count, 0) AS storm_count, 
       (COALESCE(storm_stats.storm_base, 0) - (COALESCE(storm_stats.storm_pts, 0) * ${ptVal})) AS storm_total,
       COALESCE(acc_stats.acc_count, 0) AS accessory_count, 
       (COALESCE(acc_stats.acc_base, 0) - (COALESCE(acc_stats.acc_pts, 0) * ${ptVal})) AS accessory_total, 
       COALESCE(acc_stats.acc_profit, 0) AS accessory_profit,
       GREATEST(sim_stats.sim_last, storm_stats.storm_last, acc_stats.acc_last) AS last_purchase_at
     FROM customers c
     LEFT JOIN customer_validations v ON v.customer_id = c.id
     LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE is_voided = FALSE) AS sim_count, COALESCE(SUM(selling_price_snapshot) FILTER (WHERE is_voided = FALSE), 0) AS sim_base, COALESCE(SUM(loyalty_redeemed_snapshot) FILTER (WHERE is_voided = FALSE), 0) AS sim_pts, MAX(sold_at) AS sim_last, array_agg(DISTINCT offer_id) FILTER (WHERE is_voided = FALSE) AS purchased_offers FROM session_sim_sales WHERE customer_id = c.id ${dSim}) sim_stats ON TRUE
     LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE is_voided = FALSE) AS storm_count, COALESCE(SUM(amount) FILTER (WHERE is_voided = FALSE), 0) AS storm_base, COALESCE(SUM(loyalty_redeemed_snapshot) FILTER (WHERE is_voided = FALSE), 0) AS storm_pts, MAX(entered_at) AS storm_last FROM session_storm_entries WHERE customer_id = c.id ${dStorm}) storm_stats ON TRUE
     LEFT JOIN LATERAL (SELECT COUNT(*) FILTER (WHERE is_voided = FALSE) AS acc_count, COALESCE(SUM(price_snapshot) FILTER (WHERE is_voided = FALSE), 0) AS acc_base, COALESCE(SUM(price_snapshot - real_price_snapshot) FILTER (WHERE is_voided = FALSE), 0) AS acc_profit, COALESCE(SUM(loyalty_redeemed_snapshot) FILTER (WHERE is_voided = FALSE), 0) AS acc_pts, MAX(sold_at) AS acc_last FROM session_accessory_sales WHERE customer_id = c.id ${dAcc}) acc_stats ON TRUE
     ${where} ${req.query.sort === 'name' ? 'ORDER BY c.last_name, c.first_name, c.id' : 'ORDER BY storm_total DESC, c.last_name, c.first_name'} LIMIT $${params.length - 1} OFFSET $${params.length}`, params
  );

  sendSuccess(res, rows.map((r) => {
    const sim_count = parseInt(r.sim_count, 10);
    const total_spent = parseFloat(r.sim_total) + parseFloat(r.storm_total) + parseFloat(r.accessory_total);
    const lifetime = parseFloat(r.lifetime_points) || 0;
    return {
      ...r, sim_count, available_points: parseFloat(r.available_points) || 0, lifetime_points: lifetime,
      purchased_offers: Array.isArray(r.purchased_offers) ? r.purchased_offers : [],
      storm_total: parseFloat(r.storm_total), accessory_profit: req.user.role === 'admin' ? parseFloat(r.accessory_profit) : undefined, total_spent,
      tier: assignTier(lifetime, settings), reward: determineReward(sim_count)
    };
  }));
});

const getCustomer = asyncHandler(async (req, res) => {
  const { rows } = await db.query(`SELECT id, phone_number, first_name, last_name, address, profession, notes, created_at, updated_at, available_points, lifetime_points, is_pop, pop_cycle FROM customers WHERE id = $1`, [parseId(req.params.id)]);
  if (!rows[0]) throw AppError.notFound('Customer not found.');
  const settings = await getLoyaltySettings(db);
  const customerStats = await stats(db, rows[0].id, parseFloat(rows[0].lifetime_points) || 0, settings);
  sendSuccess(res, { ...rows[0], available_points: parseFloat(rows[0].available_points) || 0, lifetime_points: parseFloat(rows[0].lifetime_points) || 0, stats: customerStats });
});

const getCustomerPurchases = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const type = req.query.type;
  if (!['sim', 'storm', 'accessory'].includes(type)) throw AppError.badRequest('type must be "sim", "storm", or "accessory".', 'VALIDATION_ERROR');

  const settings = await getLoyaltySettings(db);
  const ptVal = settings.point_to_dzd_value || 1;

  let query;
  if (type === 'sim') {
    query = `SELECT s.id, s.sold_at AS at, NULL AS serial, s.offer_name_snapshot AS label, (s.selling_price_snapshot - (COALESCE(s.loyalty_redeemed_snapshot, 0) * ${ptVal})) AS amount, s.loyalty_earned_snapshot AS points, s.is_voided, s.void_reason, u.full_name AS cashier_name, st.name AS store_name FROM session_sim_sales s JOIN cashier_sessions cs ON cs.id = s.session_id JOIN users u ON u.id = cs.cashier_id JOIN stores st ON st.id = cs.store_id WHERE s.customer_id = $1 ORDER BY s.sold_at DESC LIMIT 200`;
  } else if (type === 'storm') {
    query = `SELECT e.id, e.entered_at AS at, e.note AS label, (e.amount - (COALESCE(e.loyalty_redeemed_snapshot, 0) * ${ptVal})) AS amount, e.loyalty_earned_snapshot AS points, e.is_voided, e.void_reason, u.full_name AS cashier_name, st.name AS store_name FROM session_storm_entries e JOIN cashier_sessions cs ON cs.id = e.session_id JOIN users u ON u.id = cs.cashier_id JOIN stores st ON st.id = cs.store_id WHERE e.customer_id = $1 ORDER BY e.entered_at DESC LIMIT 200`;
  } else {
    query = `SELECT a.id, a.sold_at AS at, a.product_name_snapshot AS label, a.category_name_snapshot AS category, (a.price_snapshot - (COALESCE(a.loyalty_redeemed_snapshot, 0) * ${ptVal})) AS amount, a.loyalty_earned_snapshot AS points, a.real_price_snapshot AS real_price, a.is_voided, a.void_reason, u.full_name AS cashier_name, st.name AS store_name FROM session_accessory_sales a JOIN cashier_sessions cs ON cs.id = a.session_id JOIN users u ON u.id = cs.cashier_id JOIN stores st ON st.id = cs.store_id WHERE a.customer_id = $1 ORDER BY a.sold_at DESC LIMIT 200`;
  }
  const { rows } = await db.query(query, [id]);
  sendSuccess(res, rows);
});

const createCustomer = asyncHandler(async (req, res) => {
  requireFields(req.body, ['phone_number', 'first_name', 'last_name', 'address', 'profession']);
  const phone = normalisePhone(req.body.phone_number);
  const firstName = parseString(req.body.first_name, 'first_name', 100);
  const lastName = parseString(req.body.last_name, 'last_name', 100);
  const address = parseString(req.body.address, 'address', 500);
  const profession = parseString(req.body.profession, 'profession', 100);
  const notes = req.body.notes ? parseString(req.body.notes, 'notes', 1000) : null;

  // NEW: Referral Logic
  let referredById = null;
  if (req.body.referred_by_phone) {
    const veteranPhone = normalisePhone(req.body.referred_by_phone);
    const { rows } = await db.query(
      'SELECT id FROM customers WHERE phone_number = $1', 
      [veteranPhone]
    );
    if (rows[0]) {
      referredById = rows[0].id;
    }
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO customers (phone_number, first_name, last_name, address, profession, notes, created_by, referred_by) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, 
      [phone, firstName, lastName, address, profession, notes, req.user.id, referredById]
    );
    sendCreated(res, rows[0], 'Customer created.');
  } catch (err) {
    if (err.code === '23505') throw AppError.conflict(`A customer with phone ${phone} already exists.`, 'CUSTOMER_PHONE_EXISTS');
    throw err;
  }
});

const updateCustomer = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const updates = {};
  if (req.body.phone_number !== undefined) updates.phone_number = normalisePhone(req.body.phone_number);
  if (req.body.first_name !== undefined) updates.first_name = parseString(req.body.first_name, 'first_name', 100);
  if (req.body.last_name !== undefined) updates.last_name = parseString(req.body.last_name, 'last_name', 100);
  if (req.body.address !== undefined) updates.address = parseString(req.body.address, 'address', 500);
  if (req.body.profession !== undefined) updates.profession = parseString(req.body.profession, 'profession', 100);
  if (req.body.notes !== undefined) updates.notes = req.body.notes ? parseString(req.body.notes, 'notes', 1000) : null;
  if (req.body.is_pop !== undefined) {
    updates.is_pop = req.body.is_pop === true || req.body.is_pop === 'true';
    updates.pop_marked_at = updates.is_pop ? new Date() : null;
  }
  if (req.body.pop_cycle !== undefined) {
  const cyc = req.body.pop_cycle === null ? null : parseInt(req.body.pop_cycle, 10);
  if (cyc !== null && ![1, 8, 15, 22].includes(cyc)) {
    throw AppError.badRequest('pop_cycle must be 1, 8, 15 or 22.', 'VALIDATION_ERROR');
  }
  updates.pop_cycle = cyc;
}

if (req.body.client_type !== undefined) {
    const ct = req.body.client_type === null || req.body.client_type === '' ? null : req.body.client_type;
    if (ct !== null && !['regular', 'corporate'].includes(ct)) {
      throw AppError.badRequest('client_type must be "regular", "corporate" or null.', 'VALIDATION_ERROR');
    }
    updates.client_type = ct;
    if (ct === 'corporate') {
      const code = String(req.body.cust_code || '').trim();
      if (!/^[A-Za-z0-9._\-\/]{1,30}$/.test(code)) {
        throw AppError.badRequest('A valid cust_code is required for corporate clients.', 'VALIDATION_ERROR');
      }
      updates.cust_code = code;
    } else {
      updates.cust_code = null;
    }
  }
  
  if (Object.keys(updates).length === 0) throw AppError.badRequest('No updateable fields provided.', 'VALIDATION_ERROR');

  const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`);
  try {
    const { rows } = await db.query(`UPDATE customers SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, ...Object.values(updates)]);
    sendSuccess(res, rows[0], 200, 'Customer updated.');
  } catch (err) {
    if (err.code === '23505') throw AppError.conflict('Phone number already used by another customer.', 'CUSTOMER_PHONE_EXISTS');
    throw err;
  }
});

const deleteCustomer = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows: countRows } = await db.query(`SELECT COUNT(*)::int AS sale_count FROM session_sim_sales WHERE customer_id = $1`, [id]);
  await db.query(`DELETE FROM customers WHERE id = $1`, [id]);
  sendSuccess(res, { unlinked_sales: countRows[0].sale_count }, 200, `Customer deleted.`);
});

const getPopReminders = asyncHandler(async (req, res) => {
  const today = new Date();
  const currentDay = today.getDate();
  const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

  let targetCycleDay = null;
  if (currentDay === lastDayOfMonth) targetCycleDay = 1;  
  else if (currentDay === 7) targetCycleDay = 8;  
  else if (currentDay === 14) targetCycleDay = 15; 
  else if (currentDay === 21) targetCycleDay = 22; 

  const cycleToQuery = req.query.cycle ? parseInt(req.query.cycle, 10) : targetCycleDay;
  if (!cycleToQuery) return sendSuccess(res, { is_reminder_day: false, cycle_due: null, customers: [] });

  let dayFrom = 1; let dayTo = 7;
  if (cycleToQuery === 8) { dayFrom = 8; dayTo = 14; } 
  else if (cycleToQuery === 15) { dayFrom = 15; dayTo = 21; } 
  else if (cycleToQuery === 22) { dayFrom = 22; dayTo = 31; }

  const { rows } = await db.query(
    `SELECT DISTINCT ON (ev.id) ev.id, ev.first_name, ev.last_name, ev.phone_number, ev.profession, ev.address,
        ev.sold_at, ev.offer_name_snapshot, ev.purchase_day, ev.source, $1::int AS cycle_day
 FROM (
   SELECT c.id, c.first_name, c.last_name, c.phone_number, c.profession, c.address,
          s.sold_at, s.offer_name_snapshot, EXTRACT(DAY FROM s.sold_at)::int AS purchase_day, 'sim' AS source
   FROM session_sim_sales s JOIN customers c ON c.id = s.customer_id
   WHERE s.is_voided = FALSE AND (s.offer_name_snapshot ILIKE '%pop%' OR s.offer_name_snapshot ILIKE '%ooredoo pop%')
     AND EXTRACT(DAY FROM s.sold_at) BETWEEN $2 AND $3
   UNION ALL
   SELECT c.id, c.first_name, c.last_name, c.phone_number, c.profession, c.address,
          e.entered_at AS sold_at, 'POP (Storm)' AS offer_name_snapshot, e.pop_cycle::int AS purchase_day, 'storm' AS source
   FROM session_storm_entries e JOIN customers c ON c.id = e.customer_id
   WHERE e.is_voided = FALSE AND e.is_pop_number = TRUE AND e.pop_cycle = $1::int
     AND NOT EXISTS (
       SELECT 1 FROM session_storm_entries e2
        WHERE e2.customer_id = e.customer_id AND e2.is_voided = FALSE
          AND e2.is_pop_number = TRUE AND e2.entered_at > e.entered_at
     )
 ) ev
 ORDER BY ev.id, ev.sold_at DESC`,
    [cycleToQuery, dayFrom, dayTo]
  );
  sendSuccess(res, { is_reminder_day: targetCycleDay !== null, cycle_due: cycleToQuery, customers: rows });
});

// ─── GET /api/customers/:id/loyalty-ledger ───────────────────────────────────

const getCustomerLoyaltyLedger = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  
  const { rows } = await db.query(`
    SELECT 
      'sale' AS record_type,
      s.id, s.sold_at AS created_at, 
      s.offer_name_snapshot AS description, 
      s.selling_price_snapshot AS amount, 
      COALESCE(s.loyalty_earned_snapshot, 0) AS points_earned,
      COALESCE(s.loyalty_redeemed_snapshot, 0) AS points_redeemed,
      st.name AS store_name,
      u.full_name AS cashier_name
    FROM session_sim_sales s
    JOIN cashier_sessions cs ON cs.id = s.session_id
    JOIN users u ON u.id = cs.cashier_id
    JOIN stores st ON st.id = cs.store_id
    WHERE s.customer_id = $1 AND s.is_voided = FALSE
    
    UNION ALL
    
    SELECT 
      'sale' AS record_type,
      e.id, e.entered_at AS created_at, 
      COALESCE(e.note, 'Storm / Bundle') AS description, 
      e.amount AS amount, 
      COALESCE(e.loyalty_earned_snapshot, 0) AS points_earned,
      COALESCE(e.loyalty_redeemed_snapshot, 0) AS points_redeemed,
      st.name AS store_name,
      u.full_name AS cashier_name
    FROM session_storm_entries e
    JOIN cashier_sessions cs ON cs.id = e.session_id
    JOIN users u ON u.id = cs.cashier_id
    JOIN stores st ON st.id = cs.store_id
    WHERE e.customer_id = $1 AND e.is_voided = FALSE
    
    UNION ALL
    
    SELECT 
      'sale' AS record_type,
      a.id, a.sold_at AS created_at, 
      a.product_name_snapshot AS description, 
      a.price_snapshot AS amount, 
      COALESCE(a.loyalty_earned_snapshot, 0) AS points_earned,
      COALESCE(a.loyalty_redeemed_snapshot, 0) AS points_redeemed,
      st.name AS store_name,
      u.full_name AS cashier_name
    FROM session_accessory_sales a
    JOIN cashier_sessions cs ON cs.id = a.session_id
    JOIN users u ON u.id = cs.cashier_id
    JOIN stores st ON st.id = cs.store_id
    WHERE a.customer_id = $1 AND a.is_voided = FALSE
    
    UNION ALL
    
    SELECT 
      'manual' AS record_type,
      l.id, l.created_at,
      l.description,
      0 AS amount,
      CASE WHEN l.points > 0 THEN l.points ELSE 0 END AS points_earned,
      CASE WHEN l.points < 0 THEN ABS(l.points) ELSE 0 END AS points_redeemed,
      'System' AS store_name,
      'System' AS cashier_name
    FROM loyalty_ledger l
    WHERE l.customer_id = $1 AND l.transaction_type NOT IN ('earn', 'spend')
    
    ORDER BY created_at DESC
    LIMIT 150
  `, [id]);
  
  sendSuccess(res, rows);
});

// ─── POST /api/customers/:id/adjust-points (Admin Only) ──────────────────────

const adjustCustomerPoints = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  requireFields(req.body, ['points', 'reason']);
  
  const pointsDelta = parseFloat(req.body.points);
  if (isNaN(pointsDelta) || pointsDelta === 0) throw AppError.badRequest('Points adjustment must be a non-zero number.');
  
  const reason = String(req.body.reason).trim();
  if (!reason) throw AppError.badRequest('A reason is required for manual adjustments.');

  const result = await db.withTransaction(async (client) => {
    const { rows } = await client.query('SELECT available_points, lifetime_points FROM customers WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw AppError.notFound('Customer not found.');
    
    const currentAvailable = parseFloat(rows[0].available_points || 0);
    
    // Protect against negative balances
    if (pointsDelta < 0 && Math.abs(pointsDelta) > currentAvailable) {
       throw AppError.badRequest(`Cannot deduct more points than the customer has (${currentAvailable} pts).`);
    }

    if (pointsDelta > 0) {
      await client.query(`UPDATE customers SET available_points = available_points + $1, lifetime_points = lifetime_points + $1 WHERE id = $2`, [pointsDelta, id]);
    } else {
      await client.query(`UPDATE customers SET available_points = available_points + $1 WHERE id = $2`, [pointsDelta, id]);
    }

    // Securely log it into the ledger
    await client.query(
      `INSERT INTO loyalty_ledger (customer_id, points, transaction_type, description) VALUES ($1, $2, 'manual_adjustment', $3)`,
      [id, pointsDelta, `Manual Adjustment: ${reason}`]
    );

    const { rows: updated } = await client.query('SELECT * FROM customers WHERE id = $1', [id]);
    return updated[0];
  });

  audit({ 
    userId: req.user.id, action: 'UPDATE', table: 'customers', recordId: id, 
    description: `Adjusted points by ${pointsDelta}. Reason: ${reason}`, ip: req.clientIp 
  });

  sendSuccess(res, result, 200, `Successfully adjusted points by ${pointsDelta}.`);
});

const bulkUpload = asyncHandler(async (req, res) => {
  if (!req.file) throw AppError.badRequest('No Excel file provided.');

  let rows = [];

  // Robust parsing: If CSV, handle it manually to perfectly support semicolons (;)
  if (req.file.originalname.toLowerCase().endsWith('.csv')) {
    const csvString = req.file.buffer.toString('utf-8');
    const lines = csvString.split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length > 0) {
      const sep = lines[0].includes(';') ? ';' : ',';
      const headers = lines[0].split(sep).map(h => h.replace(/^\uFEFF/, '').trim());
      
      const parseCSVLine = (line, sep) => {
         const result = [];
         let start = 0, inQuotes = false;
         for (let j = 0; j < line.length; j++) {
             if (line[j] === '"') inQuotes = !inQuotes;
             else if (line[j] === sep && !inQuotes) {
                 result.push(line.substring(start, j).replace(/^"|"$/g, '').replace(/""/g, '"').trim());
                 start = j + 1;
             }
         }
         result.push(line.substring(start).replace(/^"|"$/g, '').replace(/""/g, '"').trim());
         return result;
      };

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i], sep);
        const rowObj = {};
        headers.forEach((h, idx) => { rowObj[h] = values[idx]; });
        rows.push(rowObj);
      }
    }
  } else {
    // For standard .xlsx / .xls files
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
  }

  if (rows.length === 0) throw AppError.badRequest('File is empty or invalid.');

  let imported = 0;

  await db.withTransaction(async (client) => {
    const { rows: users } = await client.query('SELECT id, full_name, username FROM users');

    for (const row of rows) {
      // SMART NORMALIZATION: Ignores spaces, symbols, and caps (e.g. 'Points Balance' -> 'pointsbalance')
      const normalizeKey = (k) => (k || '').toString().toLowerCase().replace(/[\W_]+/g, '');
      const nRow = {};
      for (let key in row) { nRow[normalizeKey(key)] = row[key]; }

      const rawPhone = nRow['phone'] || nRow['phonenumber'] || nRow['téléphone'] || nRow['رقمالهاتف'];
      if (!rawPhone) continue;

      let phone;
      try { phone = normalisePhone(rawPhone); } catch (e) { continue; }

      const firstName = String(nRow['firstname'] || nRow['prénom'] || nRow['الاسم'] || '').trim();
      const lastName = String(nRow['lastname'] || nRow['nom'] || nRow['اللقب'] || '').trim();
      const address = String(nRow['address'] || nRow['adresse'] || nRow['العنوان'] || '').trim();
      const profession = String(nRow['profession'] || nRow['المهنة'] || '').trim();
      const notes = String(nRow['notes'] || nRow['ملاحظات'] || '').trim();
      
      // Accurately pulls points no matter how the header is translated
      const points = parseFloat(nRow['points'] || nRow['pointsbalance'] || nRow['availablepoints'] || nRow['النقاط']) || 0;

      // Match cashier by name
      const cashierName = String(nRow['cashier'] || nRow['createdby'] || nRow['créépar'] || '').trim().toLowerCase();
      let createdBy = req.user.id;
      if (cashierName && cashierName !== 'system') {
        const matchedUser = users.find(u => (u.full_name && u.full_name.toLowerCase() === cashierName) || (u.username && u.username.toLowerCase() === cashierName));
        if (matchedUser) createdBy = matchedUser.id;
      }

      if (!firstName) continue;

      const { rowCount } = await client.query(
        `INSERT INTO customers (phone_number, first_name, last_name, address, profession, notes, created_by, available_points, lifetime_points) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         ON CONFLICT (phone_number) DO UPDATE SET 
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            address = COALESCE(NULLIF(EXCLUDED.address, ''), customers.address),
            profession = COALESCE(NULLIF(EXCLUDED.profession, ''), customers.profession),
            notes = COALESCE(NULLIF(EXCLUDED.notes, ''), customers.notes),
            created_by = EXCLUDED.created_by,
            available_points = EXCLUDED.available_points,
            lifetime_points = EXCLUDED.lifetime_points,
            updated_at = NOW()`,
        [phone, firstName.substring(0, 100), lastName.substring(0, 100), address.substring(0, 500), profession.substring(0, 100), notes.substring(0, 1000), createdBy, points]
      );
      if (rowCount > 0) imported++;
    }
  });

  sendSuccess(res, null, 200, `Successfully imported/updated ${imported} customers.`);
});

module.exports = { lookupByPhone, listCustomers, getCustomer, getCustomerPurchases, createCustomer, updateCustomer, deleteCustomer, getPopReminders, getCustomerLoyaltyLedger, adjustCustomerPoints, bulkUpload };