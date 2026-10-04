'use strict';

const db = require('../config/db');
const AppError = require('../utils/AppError');
const { asyncHandler, sendSuccess } = require('../utils/asyncHandler');
const { audit } = require('../utils/audit');
const cron = require('node-cron');
const { requireFields, parseId, parseString, validateDateRange } = require('../utils/validators');
const { MANUAL_ITEMS_SQL } = require('../utils/manualLedger');

const { callOoredooApi } = require('../services/ooredooService');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const internalSyncPool = async (userId, notes) => {
  const initReq = await callOoredooApi({ app_id: "ussd_app", service_code: "*BalancePDV", msg: "", session_id: "", session_continue: "1", cache_enable: false });
  const initRes = initReq.data;
  if (initRes.code !== 0) throw new Error('Failed to initiate *BalancePDV.');
  
  const pinReq = await callOoredooApi({ app_id: "ussd_app", service_code: "", msg: "0000", session_id: initRes.data.nb_session_id.toString(), session_continue: "1", cache_enable: false });
  const pinRes = pinReq.data;
  if (pinRes.code !== 0) throw new Error('Failed to retrieve balances with PIN.');

  const fullText = pinRes.data && pinRes.data.text ? pinRes.data.text.map(t => t[1]).join('\n') : "";
  const stormMatch = fullText.match(/Compte Storm\s*:\s*([\d.]+)/i);
  const fideliteMatch = fullText.match(/Fid.lit.\s*:\s*([\d.]+)/i);
  const bonusMatch = fullText.match(/Bonus\s*:\s*([\d.]+)/i);

  if (!stormMatch) throw new Error('Could not parse Storm balance.');

  const balance = parseFloat(stormMatch[1]) || 0;
  const points = bonusMatch ? parseFloat(bonusMatch[1]) : 0;
  const bonus = fideliteMatch ? parseFloat(fideliteMatch[1]) : 0;

  const { rows } = await db.query(
    `INSERT INTO global_pool_state (available_balance, available_bonus, available_points, updated_by, notes)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [balance, bonus, points, userId, notes]
  );
  return rows[0];
};

cron.schedule('0 6 * * *', async () => {
  console.log('[CRON] Executing 6:00 AM Daily Tasks...');
  
  let snapshotSuccess = false;
  let attempt = 1;

  while (!snapshotSuccess) {
    try {
      await internalSyncPool(1, '[SNAPSHOT] Daily Opening Balance');
      console.log(`[CRON] Ooredoo snapshot saved successfully on attempt ${attempt}.`);
      snapshotSuccess = true;
    } catch (err) {
      console.error(`[CRON ERROR] Ooredoo snapshot failed on attempt ${attempt}:`, err.message);
      console.log('[CRON] Waiting 2 minutes before retrying...');
      attempt++;
      await delay(2 * 60 * 1000); 
    }
  }

  try {
    const { rows: stores } = await db.query(`SELECT id, name FROM stores WHERE is_active = TRUE`);
    for (const store of stores) {
      await db.withTransaction(async (client) => {
        const { rows: regRows } = await client.query(
          `SELECT id, cash_amount FROM store_register_state WHERE store_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [store.id]
        );
        const currentCash = regRows[0] ? parseFloat(regRows[0].cash_amount) : 0;

        if (currentCash > 0) {
          const { rows: expRows } = await client.query(
            `INSERT INTO register_expenses (store_id, session_id, amount, expense_date, description, category, created_by)
             VALUES ($1, NULL, $2, CURRENT_DATE, $3, 'other', 1) RETURNING id`,
            [store.id, currentCash, `Automatic Daily Cash Collection (${store.name})`]
          );
          await client.query(
            `INSERT INTO store_register_state (store_id, cash_amount, updated_by, notes)
             VALUES ($1, 0, 1, $2)`,
            [store.id, `Auto-swept to expense #${expRows[0].id}`]
          );
          console.log(`[CRON] Swept ${currentCash} DZD from ${store.name} register to expenses.`);
        }
      });
    }
  } catch (err) {
    console.error('[CRON ERROR] Failed to auto-sweep physical registers:', err.message);
  }
});

const loadCurrentPool = async () => {
  const { rows } = await db.query(`SELECT available_balance, available_bonus, available_points FROM global_pool_state ORDER BY id DESC LIMIT 1`);
  return rows[0] || { available_balance: 0, available_bonus: 0, available_points: 0 };
};

const getPool = asyncHandler(async (req, res) => {
  const pool = await loadCurrentPool();
  sendSuccess(res, { balance: parseFloat(pool.available_balance) || 0, bonus: parseFloat(pool.available_bonus) || 0, points: parseFloat(pool.available_points) || 0 });
});

const syncPoolWithOoredoo = asyncHandler(async (req, res) => {
  const result = await internalSyncPool(req.user.id, '[SYNC] Manual Sync via Ooredoo USSD');
  sendSuccess(res, { balance: parseFloat(result.available_balance), bonus: parseFloat(result.available_bonus), points: parseFloat(result.available_points) }, 200, 'Pool synced.');
});

const autoConvertPoints = asyncHandler(async (req, res) => {
  const beforeState = await internalSyncPool(req.user.id, '[PRE-CONVERSION] Snapshot');

  if (parseFloat(beforeState.available_points) <= 0) {
    throw AppError.badRequest('You have 0 loyalty points. Nothing to convert.', 'INSUFFICIENT_POINTS');
  }

  const initReq = await callOoredooApi({ app_id: "ussd_app", service_code: "*582#", msg: "", session_id: "", session_continue: "1", cache_enable: false });
  const initRes = initReq.data;
  if (initRes.code !== 0) throw AppError.internal('Failed to initiate *582#.');
  
  const initText = initRes.data && initRes.data.text ? initRes.data.text.map(t => t[1]).join(' ') : '';
  if (initRes.data.session_continue === 0 || initText.toLowerCase().includes('annulé')) {
    throw AppError.badRequest('Ooredoo rejected the conversion: Not enough points.', 'INSUFFICIENT_POINTS');
  }

  const confirmReq = await callOoredooApi({ app_id: "ussd_app", service_code: "", msg: "1", session_id: initRes.data.nb_session_id.toString(), session_continue: "1", cache_enable: false });
  const confirmRes = confirmReq.data;
  if (confirmRes.code !== 0) throw AppError.internal('Failed to execute point conversion.');

  const confirmText = confirmRes.data && confirmRes.data.text ? confirmRes.data.text.map(t => t[1]).join(' ') : '';
  if (confirmText.toLowerCase().includes('annulé')) {
    throw AppError.badRequest('Ooredoo cancelled the conversion: Not enough points.', 'INSUFFICIENT_POINTS');
  }

  const afterState = await internalSyncPool(req.user.id, '[POST-CONVERSION] Auto-Synced via *582#');

  const pointsDeducted = parseFloat(beforeState.available_points) - parseFloat(afterState.available_points);
  const balanceAdded = (parseFloat(afterState.available_balance) + parseFloat(afterState.available_bonus)) - 
                       (parseFloat(beforeState.available_balance) + parseFloat(beforeState.available_bonus));

  if (pointsDeducted <= 0) {
     throw AppError.badRequest('No points were converted. Ooredoo response: ' + (confirmText || 'Unknown'), 'CONVERSION_FAILED');
  }

  await db.query(
    `INSERT INTO global_pool_state (available_balance, available_bonus, available_points, updated_by, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    [afterState.available_balance, afterState.available_bonus, afterState.available_points, req.user.id, `[CONVERSION] Converted ${pointsDeducted} pts into ${balanceAdded.toFixed(2)} DZD.`]
  );

  sendSuccess(res, { 
    balance: parseFloat(afterState.available_balance), bonus: parseFloat(afterState.available_bonus), points: parseFloat(afterState.available_points),
    pointsConverted: pointsDeducted, dzdAdded: balanceAdded.toFixed(2) 
  }, 200, `Successfully converted ${pointsDeducted} points!`);
});

const updatePool = asyncHandler(async (req, res) => {
  requireFields(req.body, ['amount', 'actionType']);
  
  // FIX: Unlocked to allow negative numbers 
  const amount = parseFloat(req.body.amount);
  if (isNaN(amount) || amount === 0) throw AppError.badRequest('Amount must be a non-zero number.', 'VALIDATION_ERROR');
  
  const note = `[${req.body.actionType}] ${amount} | ${req.body.note || ''}`;

  const current = await loadCurrentPool();
  const { rows } = await db.query(
    `INSERT INTO global_pool_state (available_balance, available_bonus, available_points, updated_by, notes)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [current.available_balance, current.available_bonus, current.available_points, req.user.id, note]
  );

  sendSuccess(res, { balance: parseFloat(rows[0].available_balance), bonus: parseFloat(rows[0].available_bonus), points: parseFloat(rows[0].available_points) }, 200, 'Manual entry safely logged.');
});

const getDailyReconciliation = asyncHandler(async (req, res) => {
  try {
    const logicalStart = new Date();
    if (logicalStart.getHours() < 6) logicalStart.setDate(logicalStart.getDate() - 1);
    logicalStart.setHours(6, 0, 0, 0);

    const { rows: historyDesc } = await db.query(`SELECT * FROM global_pool_state ORDER BY id DESC LIMIT 500`);
    const historyAsc = historyDesc.reverse();

    let openingState = historyAsc.find(h => {
      if (!h.notes) return false;
      const isSnap = h.notes.includes('[SNAPSHOT]');
      const ts = new Date(h.created_at || h.updated_at || new Date());
      return isSnap && ts >= logicalStart;
    });
    
    if (!openingState) {
        openingState = historyAsc.find(h => {
            const ts = new Date(h.created_at || h.updated_at || new Date());
            return ts >= logicalStart;
        });
    }

    if (!openingState) {
        openingState = { available_balance: 0, available_bonus: 0, available_points: 0 };
    }

    const openingTotal = (parseFloat(openingState.available_balance) || 0) + (parseFloat(openingState.available_bonus) || 0);
    const openingPoints = parseFloat(openingState.available_points) || 0;

    const [{ rows: simRows }, { rows: stormRows }] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(commission_points_snapshot), 0) AS total_points, COALESCE(SUM(real_price_snapshot), 0) AS total_cost 
                FROM session_sim_sales WHERE sold_at >= $1 AND is_voided = FALSE`, [logicalStart]).catch((err) => { console.error(err); return {rows:[{}]} }),
      db.query(`SELECT COALESCE(SUM(amount), 0) AS total_amount 
                FROM session_storm_entries WHERE entered_at >= $1 AND is_voided = FALSE`, [logicalStart]).catch((err) => { console.error(err); return {rows:[{}]} })
    ]);
    
    const simPoints = parseFloat(simRows[0]?.total_points || 0) || 0;
    const simCost = parseFloat(simRows[0]?.total_cost || 0) || 0;
    const stormAmount = parseFloat(stormRows[0]?.total_amount || 0) || 0;

    let manualRecharges = 0, manualRewards = 0, pointsConverted = 0, dzdConverted = 0;

    historyAsc.forEach(h => {
      if (!h.notes) return;
      const ts = new Date(h.created_at || h.updated_at || new Date());
      if (ts < logicalStart) return;

      const convMatch = h.notes.match(/\[CONVERSION\] Converted ([\d.]+) pts into ([\d.]+) DZD/);
      if (convMatch) { pointsConverted += parseFloat(convMatch[1]) || 0; dzdConverted += parseFloat(convMatch[2]) || 0; }
      
      // FIX: Regex unlocked to safely read negative numbers `[-]?`
      const rechMatch = h.notes.match(/\[RECHARGE\] ([-]?[\d.]+)/);
      if (rechMatch) manualRecharges += parseFloat(rechMatch[1]) || 0;
      const rewMatch = h.notes.match(/\[REWARD\] ([-]?[\d.]+)/);
      if (rewMatch) manualRewards += parseFloat(rewMatch[1]) || 0;
    });

    const current = historyAsc.length > 0 ? historyAsc[historyAsc.length - 1] : { available_balance: 0, available_bonus: 0, available_points: 0 };
    const actualTotal = (parseFloat(current.available_balance) || 0) + (parseFloat(current.available_bonus) || 0);
    const actualPoints = parseFloat(current.available_points) || 0;

    const expectedPoints = openingPoints + simPoints + manualRewards - pointsConverted;
    const expectedTotal = openingTotal + manualRecharges + dzdConverted - simCost - stormAmount;

    sendSuccess(res, {
      timeline: { start: logicalStart.toISOString() },
      opening: { solde_total: openingTotal, points: openingPoints },
      activity: { sim_points_earned: simPoints, sim_buying_cost: simCost, storm_sold: stormAmount, manual_recharges: manualRecharges, manual_rewards: manualRewards, points_converted: pointsConverted, dzd_converted: dzdConverted },
      audit: {
        points: { expected: expectedPoints, actual: actualPoints, discrepancy: actualPoints - expectedPoints },
        balance: { expected: expectedTotal, actual: actualTotal, discrepancy: actualTotal - expectedTotal }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: `Reconciliation Crash: ${error.message}` });
  }
});

const getRegisters = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT s.id, s.name, s.location, COALESCE(r.cash_amount, 0) AS current_cash
     FROM stores s LEFT JOIN LATERAL (SELECT cash_amount FROM store_register_state WHERE store_id = s.id ORDER BY id DESC LIMIT 1) r ON TRUE
     WHERE s.is_active = TRUE ORDER BY s.id`
  );
  sendSuccess(res, rows.map((r) => ({ id: r.id, name: r.name, location: r.location, current_cash: parseFloat(r.current_cash) || 0 })));
});

const updateRegister = asyncHandler(async (req, res) => {
  requireFields(req.body, ['amount', 'type']);
  const storeId = parseId(req.params.id, 'store_id');
  const type = ['add', 'subtract'].includes(req.body.type) ? req.body.type : null;
  const amount = parseFloat(req.body.amount);
  if (isNaN(amount)) throw AppError.badRequest('Invalid amount.');
  const note = req.body.note ? parseString(req.body.note, 'note', 500) : null;
  
  const applyAdjustment = (current, amount, type) => {
    const next = Number(current) + (type === 'subtract' ? -amount : amount);
    if (next < 0) throw AppError.badRequest('Adjustment results in a negative value.', 'NEGATIVE_RESULT');
    return next;
  };

  const result = await db.withTransaction(async (client) => {
    const { rows: r } = await client.query(`SELECT cash_amount FROM store_register_state WHERE store_id = $1 ORDER BY id DESC LIMIT 1`, [storeId]);
    const current = r[0] ? parseFloat(r[0].cash_amount) : 0;
    const next = applyAdjustment(current, amount, type);
    const { rows } = await client.query(
      `INSERT INTO store_register_state (store_id, cash_amount, updated_by, notes) VALUES ($1, $2, $3, $4) RETURNING *`,
      [storeId, next, req.user.id, note]
    );
    return rows[0];
  });
  sendSuccess(res, { store_id: result.store_id, current_cash: parseFloat(result.cash_amount) }, 200, `Register updated.`);
});

// GET /api/finances/manual-ledger?from=YYYY-MM-DD&to=YYYY-MM-DD
// History of every manually added Side-Ledger item (recharges + rewards) in a period.
const getManualLedger = asyncHandler(async (req, res) => {
  const { from, to } = validateDateRange(req.query.from, req.query.to);

  const [{ rows: items }, { rows: sums }] = await Promise.all([
    db.query(
      `SELECT m.id, m.type, m.amount, m.note, m.created_at, u.full_name AS added_by
         FROM (${MANUAL_ITEMS_SQL}) m
         LEFT JOIN users u ON u.id = m.updated_by
        WHERE m.created_at::date BETWEEN $1 AND $2
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 1000`,
      [from, to]
    ),
    db.query(
      `SELECT COALESCE(SUM(m.amount) FILTER (WHERE m.type = 'RECHARGE'), 0) AS recharges,
              COALESCE(SUM(m.amount) FILTER (WHERE m.type = 'REWARD'), 0)   AS rewards,
              COUNT(*)::int                                                 AS count
         FROM (${MANUAL_ITEMS_SQL}) m
        WHERE m.created_at::date BETWEEN $1 AND $2`,
      [from, to]
    ),
  ]);

  const count = sums[0]?.count || 0;
  sendSuccess(res, {
    from,
    to,
    totals: {
      recharges: parseFloat(sums[0]?.recharges) || 0,
      rewards: parseFloat(sums[0]?.rewards) || 0,
      count,
    },
    truncated: count > items.length,
    items: items.map((r) => ({
      id: r.id,
      type: r.type,
      amount: parseFloat(r.amount) || 0,
      note: r.note || '',
      added_by: r.added_by || null,
      created_at: r.created_at,
    })),
  });
});

module.exports = { getPool, getRegisters, syncPoolWithOoredoo, autoConvertPoints, updatePool, getDailyReconciliation, updateRegister, getManualLedger };