'use strict';

const db       = require('../config/db');
const AppError = require('../utils/AppError');
const logger   = require('../utils/logger');
const { asyncHandler, sendSuccess, sendCreated } = require('../utils/asyncHandler');
const { audit } = require('../utils/audit');
const { parseDate, parseId, validateDateRange } = require('../utils/validators');
const { manualRechargesByMonth, monthKey } = require('../utils/manualLedger');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getPtVal = async () => {
  const { rows } = await db.query("SELECT value FROM loyalty_settings WHERE key = 'point_to_dzd_value'");
  return rows[0] ? parseFloat(rows[0].value) : 1;
};

const todayStr = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const daysBetween = (from, to) => {
  if (!from || !to) return 1;
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 1;
  return Math.round((b - a) / (1000 * 60 * 60 * 24)) + 1;
};

const validateReportDate = (raw) => {
  const date = parseDate(raw, 'date');
  if (date > todayStr()) {
    throw AppError.badRequest('Cannot generate a report for a future date.', 'FUTURE_DATE');
  }
  return date;
};

const calculatePrelevement = (amount) => {
  if (amount <= 700000) return amount * 0.025;
  if (amount <= 1200000) return 17500 + (amount - 700000) * 0.03;
  if (amount <= 1800000) return 32500 + (amount - 1200000) * 0.035;
  return 52500 + (amount - 1800000) * 0.04;
};

const mapSession = (row) => ({
  session_id:                     row.session_id,
  cashier_id:                     row.cashier_id,
  cashier_name:                   row.cashier_name,
  store_id:                       row.store_id,
  store_name:                     row.store_name,
  session_date:                   row.session_date,
  opening_cash:                   parseFloat(row.opening_cash) || 0,
  sim_units_sold:                 parseInt(row.sim_units_sold, 10) || 0,
  sim_total_real_price:           parseFloat(row.sim_total_real_price) || 0,
  sim_total_selling_price:        parseFloat(row.sim_total_selling_price) || 0,
  sim_total_points:               parseInt(row.sim_total_points, 10) || 0,
  sim_total_commission:           parseFloat(row.sim_total_commission) || 0,
  sim_total_profit:               parseFloat(row.sim_total_profit) || 0,
  storm_total:                    parseFloat(row.storm_total) || 0,
  accessories_total:              parseFloat(row.accessories_total) || 0,
  accessories_total_real_price:   parseFloat(row.accessories_total_real_price) || 0,
  accessories_total_commission:   parseFloat(row.accessories_total_commission) || 0,
  accessories_total_profit:       parseFloat(row.accessories_total_profit) || 0,
  debt_total:                     parseFloat(row.debt_total) || 0,
  expected_register_cash:         parseFloat(row.expected_register_cash) || 0,
  total_cashier_benefit:          parseFloat(row.total_cashier_benefit) || 0,
  loyalty_points_redeemed:        parseFloat(row.loyalty_points_redeemed) || 0,
  loyalty_driven_revenue:         parseFloat(row.loyalty_driven_revenue) || 0,
});

const decorate = (row, ptVal = 1) => {
  if (!row) return row;
  const sellingPrice = parseFloat(row.total_selling_price) || 0;
  const storm        = parseFloat(row.total_storm) || 0;
  const accessories  = parseFloat(row.total_accessories) || 0;
  const realPrice    = parseFloat(row.total_real_price) || 0;
  const commissions  = parseFloat(row.total_commissions) || 0;
  const profit       = parseFloat(row.gross_profit) || 0;
  const loyaltyPts   = parseFloat(row.loyalty_points_redeemed) || 0;

  const total_revenue = sellingPrice + storm + accessories;
  const margin_pct    = total_revenue > 0 ? (profit / total_revenue) * 100 : 0;

  return {
    ...row,
    total_real_price:    realPrice,
    total_selling_price: sellingPrice,
    total_storm:         storm,
    total_accessories:   accessories,
    total_commissions:   commissions,
    total_debts:         parseFloat(row.total_debts) || 0,
    gross_profit:        profit,
    total_revenue,
    margin_pct,
    loyalty_points_redeemed: loyaltyPts,
    loyalty_discount_dzd: loyaltyPts * ptVal,
    loyalty_driven_revenue: parseFloat(row.loyalty_driven_revenue) || 0,
  };
};

// ─── GET /api/reports/preview?date=YYYY-MM-DD ───────────────────────────────

const previewDailyReport = asyncHandler(async (req, res) => {
  const date = validateReportDate(req.query.date || todayStr());
  const ptVal = await getPtVal();

  const { rows: allSessions } = await db.query(
    `SELECT cs.id AS session_id, cs.status, cs.cashier_id, cs.store_id, cs.session_date,
            cs.opening_cash, cs.closed_at, u.full_name AS cashier_name, s.name AS store_name
     FROM cashier_sessions cs JOIN users u ON u.id = cs.cashier_id JOIN stores s ON s.id = cs.store_id
     WHERE cs.session_date = $1 ORDER BY cs.store_id, u.full_name`, [date]
  );

  const { rows: closedSessionTotals } = await db.query(
    `SELECT v.* FROM v_session_live_totals v JOIN cashier_sessions cs ON cs.id = v.session_id WHERE cs.session_date = $1 AND cs.status = 'closed'`, [date]
  );

  const { rows: existingReports } = await db.query(`SELECT store_id FROM daily_reports WHERE report_date = $1`, [date]);
  const existingByStore = new Set(existingReports.map((r) => r.store_id));

  const storeMap = new Map();
  for (const t of closedSessionTotals) {
    if (!storeMap.has(t.store_id)) {
      storeMap.set(t.store_id, {
        store_id: t.store_id, store_name: t.store_name, already_generated: existingByStore.has(t.store_id),
        sessions_included: 0, total_sim_units: 0, total_real_price: 0, total_selling_price: 0,
        total_storm: 0, total_accessories: 0, total_debts: 0, total_commissions: 0, 
        total_sim_profit: 0, total_accessories_profit: 0,
        loyalty_points_redeemed: 0, loyalty_driven_revenue: 0,
      });
    }
    const s = storeMap.get(t.store_id);
    s.sessions_included        += 1;
    s.total_sim_units          += parseInt(t.sim_units_sold, 10) || 0;
    s.total_real_price         += parseFloat(t.sim_total_real_price) || 0;
    s.total_selling_price      += parseFloat(t.sim_total_selling_price) || 0;
    s.total_storm              += parseFloat(t.storm_total) || 0;
    s.total_accessories        += parseFloat(t.accessories_total) || 0;
    s.total_debts              += parseFloat(t.debt_total) || 0;
    s.total_commissions        += parseFloat(t.total_cashier_benefit) || 0;
    s.total_sim_profit         += parseFloat(t.sim_total_profit) || 0;
    s.total_accessories_profit += parseFloat(t.accessories_total_profit) || 0;
    s.loyalty_points_redeemed  += parseFloat(t.loyalty_points_redeemed) || 0;
    s.loyalty_driven_revenue   += parseFloat(t.loyalty_driven_revenue) || 0;
  }

  const { rows: stores } = await db.query(`SELECT id, name FROM stores WHERE is_active = TRUE ORDER BY id`);
  for (const s of stores) {
    if (!storeMap.has(s.id) && existingByStore.has(s.id)) {
      storeMap.set(s.id, {
        store_id: s.id, store_name: s.name, already_generated: true, sessions_included: 0, total_sim_units: 0, total_real_price: 0, total_selling_price: 0,
        total_storm: 0, total_accessories: 0, total_debts: 0, total_commissions: 0, total_sim_profit: 0, total_accessories_profit: 0, loyalty_points_redeemed: 0, loyalty_driven_revenue: 0,
      });
    }
  }

  const stores_summary = Array.from(storeMap.values()).map((s) => {
    const prelevement = (s.total_real_price + s.total_storm) * 0.025; 
    return {
      ...s,
      loyalty_discount_dzd: s.loyalty_points_redeemed * ptVal,
      total_revenue: s.total_selling_price + s.total_storm + s.total_accessories,
      // PURE GROSS PROFIT MATH: No expenses subtracted
      gross_profit: s.total_sim_profit + s.total_accessories_profit + prelevement,
    };
  });

  const open_sessions    = allSessions.filter((s) => s.status === 'open');
  const closed_sessions  = allSessions.filter((s) => s.status === 'closed');
  const generatable_stores = stores_summary.filter((s) => !s.already_generated && s.sessions_included > 0);

  sendSuccess(res, {
    date, today: todayStr(), open_sessions, closed_sessions: closed_sessions.length, blocking_open_sessions: open_sessions.length,
    stores_summary, can_generate: generatable_stores.length > 0, generatable_count: generatable_stores.length,
    already_generated_count: stores_summary.filter((s) => s.already_generated).length,
  });
});

// ─── POST /api/reports/generate ──────────────────────────────────────────────

const generateDailyReport = asyncHandler(async (req, res) => {
  const date = validateReportDate(req.body.date || todayStr());
  const ptVal = await getPtVal();

  const result = await db.withTransaction(async (client) => {
    const { rows: openSessions } = await client.query(`SELECT cs.id, u.full_name AS cashier_name, s.name AS store_name FROM cashier_sessions cs JOIN users u ON u.id = cs.cashier_id JOIN stores s ON s.id = cs.store_id WHERE cs.session_date = $1 AND cs.status = 'open'`, [date]);

    if (openSessions.length > 0) {
      if (!req.body.force_close_open_sessions) {
        const list = openSessions.map((s) => `${s.cashier_name} (${s.store_name})`).join(', ');
        throw AppError.conflict(`Cannot generate report: ${openSessions.length} session(s) still open — ${list}.`, 'OPEN_SESSIONS_BLOCKING');
      }
      await client.query(`UPDATE cashier_sessions SET status = 'closed', closed_at = NOW() WHERE session_date = $1 AND status = 'open'`, [date]);
      for (const s of openSessions) audit({ userId: req.user.id, action: 'SESSION_CLOSE', table: 'cashier_sessions', recordId: s.id, description: `Force-closed during report generation for ${date}`, ip: req.clientIp });
    }

    const { rows: sessionTotals } = await client.query(`SELECT v.* FROM v_session_live_totals v JOIN cashier_sessions cs ON cs.id = v.session_id WHERE cs.session_date = $1 AND cs.status = 'closed'`, [date]);
    if (sessionTotals.length === 0) throw AppError.badRequest(`No closed sessions exist for ${date}. Nothing to report.`, 'NO_SESSIONS');

    const { rows: poolRows } = await client.query(`SELECT available_balance, available_bonus, available_points, updated_at FROM global_pool_state ORDER BY id DESC LIMIT 1`);
    const globalPool = poolRows[0] || { available_balance: 0, available_bonus: 0, available_points: 0 };
    const sessionIds = sessionTotals.map((s) => s.session_id);

    const [ { rows: simSales }, { rows: stormEntries }, { rows: accessorySales }, { rows: debts } ] = await Promise.all([
      client.query(`SELECT id, session_id, offer_id, offer_name_snapshot, real_price_snapshot, selling_price_snapshot, commission_points_snapshot, commission_snapshot, customer_id, loyalty_earned_snapshot, loyalty_redeemed_snapshot, is_voided, void_reason, sold_at FROM session_sim_sales WHERE session_id = ANY($1::int[]) ORDER BY sold_at`, [sessionIds]),
      client.query(`SELECT id, session_id, amount, note, is_voided, void_reason, customer_id, loyalty_earned_snapshot, loyalty_redeemed_snapshot, entered_at FROM session_storm_entries WHERE session_id = ANY($1::int[]) ORDER BY entered_at`, [sessionIds]),
      client.query(`SELECT id, session_id, product_id, product_name_snapshot, category_name_snapshot, price_snapshot, real_price_snapshot, commission_snapshot, customer_id, loyalty_earned_snapshot, loyalty_redeemed_snapshot, is_voided, void_reason, sold_at FROM session_accessory_sales WHERE session_id = ANY($1::int[]) ORDER BY sold_at`, [sessionIds]),
      client.query(`SELECT id, session_id, amount, description, is_voided, void_reason, entered_at FROM session_debts WHERE session_id = ANY($1::int[]) ORDER BY entered_at`, [sessionIds]),
    ]);

    const groupBy = (rows) => { const map = new Map(); for (const r of rows) { if (!map.has(r.session_id)) map.set(r.session_id, []); map.get(r.session_id).push(r); } return map; };
    const simBySession = groupBy(simSales); const stormBySession = groupBy(stormEntries); const accBySession = groupBy(accessorySales); const debtBySession = groupBy(debts);

    const sessionsByStore = new Map();
    for (const s of sessionTotals) { if (!sessionsByStore.has(s.store_id)) sessionsByStore.set(s.store_id, []); sessionsByStore.get(s.store_id).push(s); }

    const generated = []; const skipped = [];

    for (const [storeId, sList] of sessionsByStore) {
      const { rows: existing } = await client.query(`SELECT id FROM daily_reports WHERE report_date = $1 AND store_id = $2`, [date, storeId]);
      if (existing[0]) { skipped.push({ store_id: storeId, reason: 'already_generated' }); continue; }

      let total_sim_units = 0, total_real_price = 0, total_selling_price = 0, total_points = 0, total_storm = 0, total_accessories = 0;
      let total_accessories_real = 0, total_debts = 0, total_commissions = 0, total_sim_profit = 0, total_accessory_profit = 0;
      let total_loyalty_pts = 0, total_loyalty_rev = 0;

      const enrichedSessions = sList.map((s) => {
        total_sim_units        += parseInt(s.sim_units_sold, 10) || 0;
        total_real_price       += parseFloat(s.sim_total_real_price) || 0;
        total_selling_price    += parseFloat(s.sim_total_selling_price) || 0;
        total_points           += parseInt(s.sim_total_points, 10) || 0;
        total_storm            += parseFloat(s.storm_total) || 0;
        total_accessories      += parseFloat(s.accessories_total) || 0;
        total_accessories_real += parseFloat(s.accessories_total_real_price) || 0;
        total_debts            += parseFloat(s.debt_total) || 0;
        total_commissions      += parseFloat(s.total_cashier_benefit) || 0;
        total_sim_profit       += parseFloat(s.sim_total_profit) || 0;
        total_accessory_profit += parseFloat(s.accessories_total_profit) || 0;
        total_loyalty_pts      += parseFloat(s.loyalty_points_redeemed) || 0;
        total_loyalty_rev      += parseFloat(s.loyalty_driven_revenue) || 0;

        return { ...mapSession(s), sim_sales: simBySession.get(s.session_id) || [], storm_entries: stormBySession.get(s.session_id) || [], accessory_sales: accBySession.get(s.session_id) || [], debts: debtBySession.get(s.session_id) || [] };
      });

      const prelevement = (total_real_price + total_storm) * 0.025; 
      // PURE GROSS PROFIT MATH
      const gross_profit = total_sim_profit + total_accessory_profit + prelevement;

      const { rows: registerRows } = await client.query(`SELECT cash_amount, updated_at FROM store_register_state WHERE store_id = $1 ORDER BY id DESC LIMIT 1`, [storeId]);
      const register = registerRows[0] || { cash_amount: 0 };
      const snapshot = { sessions: enrichedSessions, global_pool: globalPool, register };

      const { rows: reportRows } = await client.query(
        `INSERT INTO daily_reports
           (report_date, store_id, created_by, total_sim_units, total_real_price, total_selling_price, total_points, total_storm, total_accessories, total_debts, total_commissions, gross_profit, loyalty_points_redeemed, loyalty_driven_revenue, snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
        [ date, storeId, req.user.id, total_sim_units, total_real_price, total_selling_price, total_points, total_storm, total_accessories, total_debts, total_commissions, gross_profit, total_loyalty_pts, total_loyalty_rev, JSON.stringify(snapshot) ]
      );

      audit({ userId: req.user.id, action: 'REPORT_GENERATE', table: 'daily_reports', recordId: reportRows[0].id, newValues: { date, store_id: storeId, gross_profit }, ip: req.clientIp });
      generated.push(reportRows[0]);
    }

    if (generated.length === 0) throw AppError.conflict('Reports for this date have already been generated.', 'ALREADY_GENERATED');
    return { date, generated: generated.map(r => decorate(r, ptVal)), skipped };
  });

  sendCreated(res, result, 'Daily reports generated successfully.');
});

// ─── GET /api/reports ────────────────────────────────────────────────────────

const getReports = asyncHandler(async (req, res) => {
  const conditions = []; const params = [];
  if (req.query.from) { params.push(parseDate(req.query.from, 'from')); conditions.push(`d.report_date >= $${params.length}`); }
  if (req.query.to) { params.push(parseDate(req.query.to, 'to')); conditions.push(`d.report_date <= $${params.length}`); }
  if (req.query.store_id) { params.push(parseId(req.query.store_id, 'store_id')); conditions.push(`d.store_id = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const limit  = Math.min(Math.max(parseInt(req.query.limit  || '100', 10), 1), 500);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
  params.push(limit, offset);

  const ptVal = await getPtVal();
  const { rows } = await db.query(
    `SELECT d.*, s.name AS store_name, u.username AS generated_by, u.full_name AS generated_by_name
     FROM daily_reports d JOIN stores s ON s.id = d.store_id JOIN users u ON u.id = d.created_by
     ${where} ORDER BY d.report_date DESC, d.store_id ASC LIMIT $${params.length - 1} OFFSET $${params.length}`, params
  );
  sendSuccess(res, rows.map(r => decorate(r, ptVal)));
});

// ─── GET /api/reports/:id ────────────────────────────────────────────────────

const getReportById = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const ptVal = await getPtVal();
  const { rows } = await db.query(`SELECT d.*, s.name AS store_name, u.username AS generated_by, u.full_name AS generated_by_name FROM daily_reports d JOIN stores s ON s.id = d.store_id JOIN users u ON u.id = d.created_by WHERE d.id = $1`, [id]);
  if (!rows[0]) throw AppError.notFound('Report not found.');
  sendSuccess(res, decorate(rows[0], ptVal));
});

// ─── GET /api/reports/range ──────────────────────────────────────────────────

const ZERO_METRICS = () => ({
  sim_units_sold: 0, sim_total_real_price: 0, sim_total_selling_price: 0, sim_total_points: 0, sim_total_commission: 0,
  storm_total: 0, prelevement: 0, accessories_total_selling: 0, accessories_total_real: 0, accessories_total_commission: 0,
  debt_total: 0, cashier_advance_total: 0, cashier_repayment_total: 0, register_expense_total: 0,
  register_expense_by_category: { utility: 0, inventory: 0, other: 0 },
  sim_profit: 0, accessory_profit: 0, gross_profit: 0, loyalty_points_redeemed: 0, loyalty_discount_dzd: 0, loyalty_driven_revenue: 0,
});

const accumulate = (dst, src) => {
  dst.sim_units_sold += src.sim_units_sold; dst.sim_total_real_price += src.sim_total_real_price; dst.sim_total_selling_price += src.sim_total_selling_price;
  dst.sim_total_points += src.sim_total_points; dst.sim_total_commission += src.sim_total_commission; dst.storm_total += src.storm_total;
  dst.accessories_total_selling += src.accessories_total_selling; dst.accessories_total_real += src.accessories_total_real; dst.accessories_total_commission += src.accessories_total_commission;
  dst.debt_total += src.debt_total; dst.cashier_advance_total += src.cashier_advance_total; dst.cashier_repayment_total += src.cashier_repayment_total;
  dst.register_expense_total += src.register_expense_total; dst.register_expense_by_category.utility += src.register_expense_by_category.utility;
  dst.register_expense_by_category.inventory += src.register_expense_by_category.inventory; dst.register_expense_by_category.other += src.register_expense_by_category.other;
  dst.loyalty_points_redeemed += src.loyalty_points_redeemed; dst.loyalty_discount_dzd += src.loyalty_discount_dzd; dst.loyalty_driven_revenue += src.loyalty_driven_revenue;
};

const finalizeProfit = (m) => {
  m.sim_profit = m.sim_total_points + m.sim_total_selling_price - m.sim_total_real_price;
  m.accessory_profit = m.accessories_total_selling - m.accessories_total_real;
  // PURE GROSS PROFIT MATH: No expenses subtracted
  m.gross_profit = m.sim_profit + m.accessory_profit + (m.prelevement || 0);
};

const getDateRangeReport = asyncHandler(async (req, res) => {
  const { from, to } = validateDateRange(req.query.from, req.query.to);
  const isAdmin   = req.user.role === 'admin';
  const cashierId = isAdmin ? null : req.user.id;
  const rangeDays = daysBetween(from, to);
  const ptVal = await getPtVal();

  const cellsSql = `
    WITH sim AS (
      SELECT cs.cashier_id, cs.store_id, COUNT(*)::int AS sim_units_sold, COALESCE(SUM(s.real_price_snapshot), 0) AS sim_total_real_price, COALESCE(SUM(s.selling_price_snapshot), 0) AS sim_total_selling_price, COALESCE(SUM(s.commission_points_snapshot)::int, 0) AS sim_total_points, COALESCE(SUM(s.commission_snapshot), 0) AS sim_total_commission, COALESCE(SUM(s.loyalty_redeemed_snapshot), 0) AS loyalty_pts, COALESCE(SUM(s.selling_price_snapshot) FILTER (WHERE s.customer_id IS NOT NULL), 0) AS loyalty_rev
      FROM session_sim_sales s JOIN cashier_sessions cs ON cs.id = s.session_id WHERE s.is_voided = FALSE AND s.sold_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR cs.cashier_id = $3) GROUP BY cs.cashier_id, cs.store_id
    ), storm AS (
      SELECT cs.cashier_id, cs.store_id, COALESCE(SUM(se.amount), 0) AS storm_total, COALESCE(SUM(se.loyalty_redeemed_snapshot), 0) AS loyalty_pts, COALESCE(SUM(se.amount) FILTER (WHERE se.customer_id IS NOT NULL), 0) AS loyalty_rev
      FROM session_storm_entries se JOIN cashier_sessions cs ON cs.id = se.session_id WHERE se.is_voided = FALSE AND se.entered_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR cs.cashier_id = $3) GROUP BY cs.cashier_id, cs.store_id
    ), acc AS (
      SELECT cs.cashier_id, cs.store_id, COALESCE(SUM(sa.price_snapshot), 0) AS accessories_total_selling, COALESCE(SUM(sa.real_price_snapshot), 0) AS accessories_total_real, COALESCE(SUM(sa.commission_snapshot), 0) AS accessories_total_commission, COALESCE(SUM(sa.loyalty_redeemed_snapshot), 0) AS loyalty_pts, COALESCE(SUM(sa.price_snapshot) FILTER (WHERE sa.customer_id IS NOT NULL), 0) AS loyalty_rev
      FROM session_accessory_sales sa JOIN cashier_sessions cs ON cs.id = sa.session_id WHERE sa.is_voided = FALSE AND sa.sold_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR cs.cashier_id = $3) GROUP BY cs.cashier_id, cs.store_id
    ), debts AS (
      SELECT cs.cashier_id, cs.store_id, COALESCE(SUM(sd.amount), 0) AS debt_total FROM session_debts sd JOIN cashier_sessions cs ON cs.id = sd.session_id WHERE sd.is_voided = FALSE AND sd.entered_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR cs.cashier_id = $3) GROUP BY cs.cashier_id, cs.store_id
    ), cashier_keys AS (
      SELECT cashier_id, store_id FROM sim UNION SELECT cashier_id, store_id FROM storm UNION SELECT cashier_id, store_id FROM acc UNION SELECT cashier_id, store_id FROM debts
    )
    SELECT ck.cashier_id, ck.store_id, u.full_name  AS cashier_full_name, st.name AS store_name,
           COALESCE(sim.sim_units_sold, 0) AS sim_units_sold, COALESCE(sim.sim_total_real_price, 0) AS sim_total_real_price, COALESCE(sim.sim_total_selling_price, 0) AS sim_total_selling_price, COALESCE(sim.sim_total_points, 0) AS sim_total_points, COALESCE(sim.sim_total_commission, 0) AS sim_total_commission,
           COALESCE(storm.storm_total, 0) AS storm_total, COALESCE(acc.accessories_total_selling, 0) AS accessories_total_selling, COALESCE(acc.accessories_total_real, 0) AS accessories_total_real, COALESCE(acc.accessories_total_commission, 0) AS accessories_total_commission, COALESCE(debts.debt_total, 0) AS debt_total,
           (COALESCE(sim.loyalty_pts, 0) + COALESCE(storm.loyalty_pts, 0) + COALESCE(acc.loyalty_pts, 0)) AS loyalty_points_redeemed,
           (COALESCE(sim.loyalty_rev, 0) + COALESCE(storm.loyalty_rev, 0) + COALESCE(acc.loyalty_rev, 0)) AS loyalty_driven_revenue
      FROM cashier_keys ck LEFT JOIN users  u  ON u.id  = ck.cashier_id LEFT JOIN stores st ON st.id = ck.store_id
      LEFT JOIN sim ON sim.cashier_id = ck.cashier_id AND sim.store_id = ck.store_id LEFT JOIN storm ON storm.cashier_id = ck.cashier_id AND storm.store_id = ck.store_id LEFT JOIN acc ON acc.cashier_id = ck.cashier_id AND acc.store_id = ck.store_id LEFT JOIN debts ON debts.cashier_id = ck.cashier_id AND debts.store_id = ck.store_id
     ORDER BY u.full_name NULLS LAST, st.name NULLS LAST
  `;

  const prelevementMonthlySql = `WITH combined AS (SELECT cs.cashier_id, cs.store_id, DATE_TRUNC('month', se.entered_at)::date AS month, se.amount AS base_amount FROM session_storm_entries se JOIN cashier_sessions cs ON cs.id = se.session_id WHERE se.is_voided = FALSE AND se.entered_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR cs.cashier_id = $3) UNION ALL SELECT cs.cashier_id, cs.store_id, DATE_TRUNC('month', ss.sold_at)::date AS month, ss.real_price_snapshot AS base_amount FROM session_sim_sales ss JOIN cashier_sessions cs ON cs.id = ss.session_id WHERE ss.is_voided = FALSE AND ss.sold_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR cs.cashier_id = $3)) SELECT cashier_id, store_id, month, SUM(base_amount) AS base_amount FROM combined GROUP BY cashier_id, store_id, month`;
  const advancesSql = `SELECT ca.cashier_id, u.full_name AS cashier_full_name, u.store_id AS user_store_id, COALESCE(SUM(ca.amount) FILTER (WHERE ca.direction = 'advance'), 0) AS cashier_advance_total, COALESCE(SUM(ca.amount) FILTER (WHERE ca.direction = 'repayment'), 0) AS cashier_repayment_total FROM cashier_advances ca JOIN users u ON u.id = ca.cashier_id WHERE ca.is_voided = FALSE AND ca.created_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR ca.cashier_id = $3) GROUP BY ca.cashier_id, u.full_name, u.store_id`;
  const expensesSql = `SELECT re.store_id, re.category, COALESCE(SUM(re.amount), 0) AS amt FROM register_expenses re WHERE re.is_voided = FALSE AND re.expense_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR re.store_id IN (SELECT DISTINCT cs.store_id FROM cashier_sessions cs WHERE cs.cashier_id = $3)) GROUP BY re.store_id, re.category`;
  const debtsSql = `SELECT sd.id, sd.session_id, sd.amount, sd.description, sd.entered_at, c.id AS customer_id, (c.first_name || ' ' || c.last_name) AS full_name, c.phone_number, c.profession FROM session_debts sd JOIN cashier_sessions cs ON cs.id = sd.session_id JOIN customers c ON c.id  = sd.customer_id WHERE sd.is_voided = FALSE AND sd.entered_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR cs.cashier_id = $3) ORDER BY sd.entered_at DESC, sd.id DESC`;

  const startedAt = Date.now();
  const [cellsRes, prelevementRes, advanceRes, expenseRes, debtRes, { rows: storesData }, manualRecharges] = await Promise.all([
    db.query(cellsSql, [from, to, cashierId]), db.query(prelevementMonthlySql, [from, to, cashierId]), db.query(advancesSql, [from, to, cashierId]), db.query(expensesSql, [from, to, cashierId]), db.query(debtsSql, [from, to, cashierId]), db.query(`SELECT id, name FROM stores`),
    isAdmin ? manualRechargesByMonth(from, to) : Promise.resolve({ byMonth: new Map(), total: 0 }),
  ]);
  const elapsed_ms = Date.now() - startedAt;
  const storeNameById = new Map(storesData.map((s) => [s.id, s.name]));

  // Manual Side-Ledger recharges (global pool, admin scope only) are part of the Prélèvement base.
  const manualRechargeTotal = manualRecharges.total;

  // Prélèvement base (Storm + SIM cost) per month over ALL cashiers/stores.
  // Used to share the manual recharges out to individual stores/cashiers.
  const baseByMonth = new Map();
  for (const row of prelevementRes.rows) {
    const k = monthKey(row.month);
    baseByMonth.set(k, (baseByMonth.get(k) || 0) + (parseFloat(row.base_amount) || 0));
  }
  const periodBase = Array.from(baseByMonth.values()).reduce((s, b) => s + b, 0);

  // A slice's share of the manual recharges in the flat (1-day) case.
  const flatManualShare = (sliceBase) => (periodBase > 0 ? manualRechargeTotal * (sliceBase / periodBase) : 0);

  // manualMode: 'none' | 'all' (full manual amount: global totals) | 'share' (proportional to the slice's base)
  const getTieredPrelevement = (targetCashierId, targetStoreId, manualMode = 'none') => {
    const monthlyTotals = new Map();
    for (const row of prelevementRes.rows) {
      if (targetCashierId && row.cashier_id !== targetCashierId) continue;
      if (targetStoreId && row.store_id !== targetStoreId) continue;
      const k = monthKey(row.month);
      monthlyTotals.set(k, (monthlyTotals.get(k) || 0) + (parseFloat(row.base_amount) || 0));
    }
    if (manualMode !== 'none') {
      for (const [k, manualAmt] of manualRecharges.byMonth) {
        const mine = monthlyTotals.get(k) || 0;
        const whole = baseByMonth.get(k) || 0;
        const extra = manualMode === 'all' ? manualAmt : (whole > 0 ? manualAmt * (mine / whole) : 0);
        monthlyTotals.set(k, mine + extra);
      }
    }
    let totalPrelevement = 0;
    for (const amt of monthlyTotals.values()) totalPrelevement += calculatePrelevement(amt);
    return totalPrelevement;
  };

  const expensesByStore = new Map();
  for (const e of expenseRes.rows) {
    if (!expensesByStore.has(e.store_id)) expensesByStore.set(e.store_id, { utility: 0, inventory: 0, other: 0, total: 0 });
    const bucket = expensesByStore.get(e.store_id); const amt = Number(e.amt) || 0; bucket[e.category] = (bucket[e.category] || 0) + amt; bucket.total += amt;
  }

  const advancesByCashier = new Map();
  for (const a of advanceRes.rows) {
    advancesByCashier.set(a.cashier_id, { cashier_id: a.cashier_id, cashier_full_name: a.cashier_full_name, user_store_id: a.user_store_id, advance_total: parseFloat(a.cashier_advance_total) || 0, repayment_total: parseFloat(a.cashier_repayment_total) || 0 });
  }

  const cells = cellsRes.rows.map((r) => {
    const m = ZERO_METRICS();
    m.sim_units_sold = parseInt(r.sim_units_sold, 10) || 0; m.sim_total_real_price = parseFloat(r.sim_total_real_price) || 0; m.sim_total_selling_price = parseFloat(r.sim_total_selling_price) || 0; m.sim_total_points = parseInt(r.sim_total_points, 10) || 0; m.sim_total_commission = parseFloat(r.sim_total_commission) || 0; m.storm_total = parseFloat(r.storm_total) || 0; m.accessories_total_selling = parseFloat(r.accessories_total_selling) || 0; m.accessories_total_real = parseFloat(r.accessories_total_real) || 0; m.accessories_total_commission = parseFloat(r.accessories_total_commission) || 0; m.debt_total = parseFloat(r.debt_total) || 0;
    m.loyalty_points_redeemed = parseFloat(r.loyalty_points_redeemed) || 0; m.loyalty_discount_dzd = m.loyalty_points_redeemed * ptVal; m.loyalty_driven_revenue = parseFloat(r.loyalty_driven_revenue) || 0;
    return { cashier_id: r.cashier_id, cashier_full_name: r.cashier_full_name || null, store_id: r.store_id, store_name: r.store_name || storeNameById.get(r.store_id) || null, metrics: m };
  });

  const cashierMap = new Map();
  const ensureCashier = (cid, fullName) => {
    if (!cashierMap.has(cid)) cashierMap.set(cid, { cashier_id: cid, cashier_full_name: fullName, store_id: null, store_name: null, cell_store_counts: new Map(), metrics: ZERO_METRICS() });
    return cashierMap.get(cid);
  };

  for (const cell of cells) {
    if (cell.cashier_id == null) continue;
    const c = ensureCashier(cell.cashier_id, cell.cashier_full_name); accumulate(c.metrics, cell.metrics);
    c.cell_store_counts.set(cell.store_id, (c.cell_store_counts.get(cell.store_id) || 0) + 1);
  }

  for (const a of advancesByCashier.values()) {
    const c = ensureCashier(a.cashier_id, a.cashier_full_name);
    c.metrics.cashier_advance_total += a.advance_total; c.metrics.cashier_repayment_total += a.repayment_total;
    if (c.store_id == null && a.user_store_id != null) c.store_id = a.user_store_id;
  }

  const per_cashier = Array.from(cashierMap.values()).map((c) => {
    let primaryStore = c.store_id;
    if (primaryStore == null && c.cell_store_counts.size > 0) {
      let best = null, bestCount = -1;
      for (const [sid, n] of c.cell_store_counts) { if (n > bestCount) { best = sid; bestCount = n; } }
      primaryStore = best;
    }
    c.metrics.prelevement = rangeDays === 1
      ? ((c.metrics.storm_total + c.metrics.sim_total_real_price) + flatManualShare(c.metrics.storm_total + c.metrics.sim_total_real_price)) * 0.025
      : getTieredPrelevement(c.cashier_id, null, 'share');
    finalizeProfit(c.metrics);
    return { cashier_id: c.cashier_id, cashier_full_name: c.cashier_full_name, store_id: primaryStore, store_name: primaryStore != null ? (storeNameById.get(primaryStore) || null) : null, ...c.metrics };
  });

  let per_store = [];
  if (isAdmin) {
    const storeMap = new Map();
    const ensureStore = (sid) => { if (!storeMap.has(sid)) storeMap.set(sid, { store_id: sid, store_name: storeNameById.get(sid) || null, metrics: ZERO_METRICS() }); return storeMap.get(sid); };
    for (const cell of cells) { if (cell.store_id == null) continue; accumulate(ensureStore(cell.store_id).metrics, cell.metrics); }
    for (const [sid, bucket] of expensesByStore) {
      const s = ensureStore(sid); s.metrics.register_expense_total += bucket.total; s.metrics.register_expense_by_category.utility += bucket.utility || 0; s.metrics.register_expense_by_category.inventory += bucket.inventory || 0; s.metrics.register_expense_by_category.other += bucket.other || 0;
    }
    per_store = Array.from(storeMap.values()).map((s) => {
        s.metrics.prelevement = rangeDays === 1
          ? ((s.metrics.storm_total + s.metrics.sim_total_real_price) + flatManualShare(s.metrics.storm_total + s.metrics.sim_total_real_price)) * 0.025
          : getTieredPrelevement(null, s.store_id, 'share');
        finalizeProfit(s.metrics);
        return { store_id: s.store_id, store_name: s.store_name, ...s.metrics };
    }).sort((a, b) => (a.store_id || 0) - (b.store_id || 0));
  }

  const totals = ZERO_METRICS();
  for (const cell of cells) accumulate(totals, cell.metrics);
  for (const a of advancesByCashier.values()) { totals.cashier_advance_total += a.advance_total; totals.cashier_repayment_total += a.repayment_total; }
  for (const bucket of expensesByStore.values()) { totals.register_expense_total += bucket.total; totals.register_expense_by_category.utility += bucket.utility || 0; totals.register_expense_by_category.inventory += bucket.inventory || 0; totals.register_expense_by_category.other += bucket.other || 0; }
  
  totals.manual_recharges = manualRechargeTotal;
  totals.prelevement = rangeDays === 1 ? (totals.storm_total + totals.sim_total_real_price + manualRechargeTotal) * 0.025 : getTieredPrelevement(null, null, 'all');
  finalizeProfit(totals);

  const debts = debtRes.rows.map((d) => ({ id: d.id, session_id: d.session_id, amount: parseFloat(d.amount) || 0, description: d.description, created_at: d.entered_at, customer: { id: d.customer_id, full_name: d.full_name, phone_number: d.phone_number, profession: d.profession } }));
  const advances = Array.from(advancesByCashier.values()).map((a) => ({ cashier_id: a.cashier_id, cashier_full_name: a.cashier_full_name, advance_total: a.advance_total, repayment_total: a.repayment_total, outstanding_balance: Math.max(0, a.advance_total - a.repayment_total) }));

  const payload = {
    from, to, scope: isAdmin ? 'admin' : 'cashier', elapsed_ms, totals, per_cashier, debts, advances,
    expenses_by_category: { utility: totals.register_expense_by_category.utility, inventory: totals.register_expense_by_category.inventory, other: totals.register_expense_by_category.other },
  };
  if (isAdmin) payload.per_store = per_store;

  sendSuccess(res, payload);
});

// ─── GET /api/reports/:id/export.csv ────────────────────────────────────────

const exportReportCsv = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const ptVal = await getPtVal();
  const { rows } = await db.query(
    `SELECT d.*, s.name AS store_name, u.username AS generated_by, u.full_name AS generated_by_name
       FROM daily_reports d JOIN stores s ON s.id = d.store_id JOIN users u ON u.id = d.created_by WHERE d.id = $1`, [id]
  );
  if (!rows[0]) throw AppError.notFound('Report not found.');

  const report = decorate(rows[0], ptVal);
  const snapshot = report.snapshot || {};
  const sessions = snapshot.sessions || [];
  const lines = [];

  const delimiter = ';'; 
  const csvCell = (val) => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r')) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const csvRow = (cells) => cells.map(csvCell).join(delimiter);
  const formatDateOnly = (d) => {
    if (!d) return '';
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  };
  const formatDateTime = (d) => {
    if (!d) return '';
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  };

  lines.push(csvRow(['Section', 'Field', 'Value']));
  lines.push(csvRow(['Header', 'Report ID',           report.id]));
  lines.push(csvRow(['Header', 'Date',                formatDateOnly(report.report_date)]));
  lines.push(csvRow(['Header', 'Store',               report.store_name]));
  lines.push(csvRow(['Header', 'Generated by',        report.generated_by_name || report.generated_by]));
  lines.push(csvRow(['Header', 'Generated at',        formatDateTime(report.created_at)]));
  lines.push(csvRow(['Header', 'Total revenue (DZD)', report.total_revenue.toFixed(2)]));
  lines.push(csvRow(['Header', 'Loyalty Discounts Given (DZD)', report.loyalty_discount_dzd.toFixed(2)]));
  lines.push(csvRow(['Header', 'Loyalty Driven Revenue (DZD)', report.loyalty_driven_revenue.toFixed(2)]));
  lines.push(csvRow(['Header', 'SIM revenue (DZD)',   report.total_selling_price.toFixed(2)]));
  lines.push(csvRow(['Header', 'SIM cost (DZD)',      report.total_real_price.toFixed(2)]));
  lines.push(csvRow(['Header', 'Storm revenue (DZD)', report.total_storm.toFixed(2)]));
  lines.push(csvRow(['Header', 'Accessories (DZD)',   report.total_accessories.toFixed(2)]));
  lines.push(csvRow(['Header', 'Total debts (DZD)',   report.total_debts.toFixed(2)]));
  lines.push(csvRow(['Header', 'Total commissions',   report.total_commissions.toFixed(2)]));
  lines.push(csvRow(['Header', 'Gross profit (DZD)',  report.gross_profit.toFixed(2)]));
  lines.push(csvRow(['Header', 'Margin %',            report.margin_pct.toFixed(2)]));
  lines.push('');

  lines.push(csvRow(['Section', 'Cashier', 'Opening cash', 'SIM units', 'SIM revenue', 'SIM cost', 'Storm', 'Accessories', 'Debts', 'Commissions', 'Expected register cash']));
  for (const s of sessions) {
    lines.push(csvRow(['Session', s.cashier_name, (s.opening_cash || 0).toFixed(2), s.sim_units_sold || 0, (s.sim_total_selling_price || 0).toFixed(2), (s.sim_total_real_price || 0).toFixed(2), (s.storm_total || 0).toFixed(2), (s.accessories_total || 0).toFixed(2), (s.debt_total || 0).toFixed(2), (s.total_cashier_benefit || 0).toFixed(2), (s.expected_register_cash || 0).toFixed(2)]));
  }
  lines.push('');

  lines.push(csvRow(['Section', 'Cashier', 'Type', 'Time', 'Identifier', 'Detail', 'Amount', 'Voided', 'Void reason']));
  for (const s of sessions) {
    for (const t of (s.sim_sales || [])) lines.push(csvRow(['Line', s.cashier_name, 'SIM', formatDateTime(t.sold_at), '', t.offer_name_snapshot || '', Number(t.selling_price_snapshot || 0).toFixed(2), t.is_voided ? 'YES' : '', t.is_voided ? (t.void_reason || '') : '']));
    for (const t of (s.storm_entries || [])) lines.push(csvRow(['Line', s.cashier_name, 'Storm', formatDateTime(t.entered_at), '', t.note || '', Number(t.amount || 0).toFixed(2), t.is_voided ? 'YES' : '', t.is_voided ? (t.void_reason || '') : '']));
    for (const t of (s.accessory_sales || [])) lines.push(csvRow(['Line', s.cashier_name, 'Accessory', formatDateTime(t.sold_at), t.product_name_snapshot || '', t.category_name_snapshot || '', Number(t.price_snapshot || 0).toFixed(2), t.is_voided ? 'YES' : '', t.is_voided ? (t.void_reason || '') : '']));
    for (const t of (s.debts || [])) lines.push(csvRow(['Line', s.cashier_name, 'Debt', formatDateTime(t.entered_at), '', t.description || '', Number(t.amount || 0).toFixed(2), t.is_voided ? 'YES' : '', t.is_voided ? (t.void_reason || '') : '']));
  }

  const d = new Date(report.report_date);
  const safeDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const safeStoreName = (report.store_name || 'store').replace(/[^a-zA-Z0-9]/g, '-');
  const filename = `report_${safeDate}_${safeStoreName}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\ufeff' + lines.join('\r\n') + '\r\n');
});

// ─── GET /api/reports/monthly ───────────────────────────────────────────────

const getMonthlySummary = asyncHandler(async (req, res) => {
  const ptVal = await getPtVal();

  const fromD = req.query.from ? parseDate(req.query.from, 'from') : null;
  const toD   = req.query.to   ? parseDate(req.query.to,   'to')   : null;

  // Month filters (shared by the rows query and the "whole base" query)
  const monthConds = [];
  const params = [];
  if (fromD) { params.push(fromD); monthConds.push(`month >= DATE_TRUNC('month', $${params.length}::date)::date`); }
  if (toD)   { params.push(toD);   monthConds.push(`month <= DATE_TRUNC('month', $${params.length}::date)::date`); }
  const monthWhere = monthConds.length ? `WHERE ${monthConds.join(' AND ')}` : '';

  // Rows query additionally honours the store filter
  const conditions = [...monthConds];
  const rowParams = [...params];
  if (req.query.store_id) { rowParams.push(parseId(req.query.store_id, 'store_id')); conditions.push(`store_id = $${rowParams.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [{ rows }, { rows: baseRows }, manualRecharges] = await Promise.all([
    db.query(
      `SELECT v.month, v.store_id, s.name AS store_name,
              v.total_sim_units, v.total_selling_price, v.total_real_price,
              v.total_storm, v.total_accessories, v.total_commissions,
              v.total_debts, v.gross_profit, v.days_with_activity,
              v.loyalty_points_redeemed, v.loyalty_driven_revenue
         FROM v_monthly_summary v
         JOIN stores s ON s.id = v.store_id
         ${where} ORDER BY v.month DESC, v.store_id ASC`, rowParams
    ),
    // Prélèvement base of ALL stores per month (ignores the store filter) to share the manual recharges out
    db.query(
      `SELECT month, SUM(total_storm + total_real_price) AS base
         FROM v_monthly_summary ${monthWhere} GROUP BY month`, params
    ),
    manualRechargesByMonth(fromD, toD, { wholeMonths: true }),
  ]);

  const wholeBaseByMonth = new Map(baseRows.map((b) => [monthKey(b.month), parseFloat(b.base) || 0]));

  const decorated = rows.map((r) => {
    const revenue = (parseFloat(r.total_selling_price) || 0) + (parseFloat(r.total_storm) || 0) + (parseFloat(r.total_accessories) || 0);
    const base_amount = (parseFloat(r.total_storm) || 0) + (parseFloat(r.total_real_price) || 0);

    // This store's share of the manual recharges added in that month
    const k = monthKey(r.month);
    const whole = wholeBaseByMonth.get(k) || 0;
    const manualMonth = manualRecharges.byMonth.get(k) || 0;
    const manualShare = whole > 0 ? manualMonth * (base_amount / whole) : 0;

    const tieredPrelevement = calculatePrelevement(base_amount + manualShare);

    // PURE GROSS PROFIT MATH for monthly
    const profit = (parseFloat(r.gross_profit) || 0) + tieredPrelevement;
    const loyaltyPts = parseFloat(r.loyalty_points_redeemed) || 0;

    return {
      ...r,
      loyalty_points_redeemed: loyaltyPts,
      loyalty_discount_dzd: loyaltyPts * ptVal,
      loyalty_driven_revenue: parseFloat(r.loyalty_driven_revenue) || 0,
      total_revenue: revenue,
      manual_recharges_share: manualShare,
      gross_profit:  profit,
      margin_pct:    revenue > 0 ? (profit / revenue) * 100 : 0,
    };
  });

  sendSuccess(res, decorated);
});

// ─── GET /api/reports/top ───────────────────────────────────────────────────

const getTopRollup = asyncHandler(async (req, res) => {
  const today = todayStr();
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = req.query.from ? parseDate(req.query.from, 'from') : monthStart;
  const to   = req.query.to   ? parseDate(req.query.to,   'to')   : today;
  if (from > to) throw AppError.badRequest('"to" must be on or after "from".', 'INVALID_DATE_RANGE');
  const limit = Math.min(Math.max(parseInt(req.query.limit || '5', 10), 1), 50);

  const { rows: topOffers } = await db.query(
    `SELECT s.offer_name_snapshot AS offer_name, COUNT(*)::int AS units_sold,
            COALESCE(SUM(s.selling_price_snapshot), 0) AS total_revenue,
            COALESCE(SUM(s.selling_price_snapshot - s.real_price_snapshot + s.commission_points_snapshot), 0) AS total_profit
       FROM session_sim_sales s
      WHERE s.is_voided = FALSE AND s.sold_at::date BETWEEN $1 AND $2
      GROUP BY s.offer_name_snapshot ORDER BY units_sold DESC, total_revenue DESC LIMIT $3`, [from, to, limit]
  );

  const { rows: topProducts } = await db.query(
    `SELECT a.product_name_snapshot AS product_name, a.category_name_snapshot AS category_name, COUNT(*)::int AS units_sold,
            COALESCE(SUM(a.price_snapshot), 0) AS total_revenue,
            COALESCE(SUM(a.price_snapshot - a.real_price_snapshot), 0) AS total_profit
       FROM session_accessory_sales a
      WHERE a.is_voided = FALSE AND a.sold_at::date BETWEEN $1 AND $2
      GROUP BY a.product_name_snapshot, a.category_name_snapshot ORDER BY units_sold DESC, total_revenue DESC LIMIT $3`, [from, to, limit]
  );

  const { rows: leaderboard } = await db.query(
    `WITH sim AS (
       SELECT cs.cashier_id, COUNT(*)::int AS sim_units, COALESCE(SUM(s.commission_snapshot), 0) AS sim_commission
         FROM session_sim_sales s JOIN cashier_sessions cs ON cs.id = s.session_id
        WHERE s.is_voided = FALSE AND s.sold_at::date BETWEEN $1 AND $2 GROUP BY cs.cashier_id
     ),
     acc AS (
       SELECT cs.cashier_id, COALESCE(SUM(a.commission_snapshot), 0) AS acc_commission
         FROM session_accessory_sales a JOIN cashier_sessions cs ON cs.id = a.session_id
        WHERE a.is_voided = FALSE AND a.sold_at::date BETWEEN $1 AND $2 GROUP BY cs.cashier_id
     )
     SELECT u.id AS cashier_id, u.full_name AS cashier_name, u.store_id AS store_id, st.name AS store_name,
            COALESCE(sim.sim_units, 0) AS sim_units, COALESCE(sim.sim_commission, 0) AS sim_commission,
            COALESCE(acc.acc_commission, 0) AS accessory_commission,
            COALESCE(sim.sim_commission, 0) + COALESCE(acc.acc_commission, 0) AS total_commission
       FROM users u LEFT JOIN stores st ON st.id = u.store_id LEFT JOIN sim ON sim.cashier_id = u.id LEFT JOIN acc ON acc.cashier_id = u.id
      WHERE u.role = 'cashier' AND u.is_active = TRUE ORDER BY total_commission DESC, u.full_name ASC`, [from, to]
  );

  sendSuccess(res, { from, to, top_offers: topOffers, top_products: topProducts, leaderboard });
});

// ─── GET /api/reports/cashier/:id ───────────────────────────────────────────

const getCashierHistory = asyncHandler(async (req, res) => {
  const cashierId = parseId(req.params.id);
  const today = todayStr();
  const defaultFrom = (() => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0, 10); })();
  const from = req.query.from ? parseDate(req.query.from, 'from') : defaultFrom;
  const to   = req.query.to   ? parseDate(req.query.to,   'to')   : today;
  if (from > to) throw AppError.badRequest('"to" must be on or after "from".', 'INVALID_DATE_RANGE');
  
  const ptVal = await getPtVal();

  const { rows: userRows } = await db.query(
    `SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.store_id, s.name AS store_name
       FROM users u LEFT JOIN stores s ON s.id = u.store_id WHERE u.id = $1`, [cashierId]
  );
  const cashier = userRows[0];
  if (!cashier || cashier.role !== 'cashier') throw AppError.notFound('Cashier not found.', 'CASHIER_NOT_FOUND');

  const { rows: sessions } = await db.query(
    `SELECT v.session_id, cs.session_date, cs.status, cs.opening_cash, cs.closed_at,
            v.store_id, v.store_name, v.sim_units_sold, v.sim_total_selling_price, v.sim_total_real_price,
            v.sim_total_points, v.sim_total_commission, v.sim_total_profit, v.storm_total,
            v.accessories_total, v.accessories_total_real_price, v.accessories_total_commission, v.accessories_total_profit,
            v.debt_total, v.expected_register_cash, v.total_cashier_benefit,
            v.loyalty_points_redeemed, v.loyalty_driven_revenue
       FROM v_session_live_totals v JOIN cashier_sessions cs ON cs.id = v.session_id
      WHERE cs.cashier_id = $1 AND cs.session_date BETWEEN $2 AND $3 ORDER BY cs.session_date DESC, cs.id DESC`, [cashierId, from, to]
  );

  const monthlyMap = new Map();
  for (const s of sessions) {
    const month = String(s.session_date).slice(0, 7);
    if (!monthlyMap.has(month)) monthlyMap.set(month, { month, sessions_count: 0, sim_units: 0, sim_revenue: 0, storm_revenue: 0, accessories_revenue: 0, commissions: 0, debts: 0 });
    const m = monthlyMap.get(month);
    m.sessions_count += 1; m.sim_units += parseInt(s.sim_units_sold, 10) || 0; m.sim_revenue += parseFloat(s.sim_total_selling_price) || 0;
    m.storm_revenue += parseFloat(s.storm_total) || 0; m.accessories_revenue += parseFloat(s.accessories_total) || 0;
    m.commissions += parseFloat(s.total_cashier_benefit) || 0; m.debts += parseFloat(s.debt_total) || 0;
  }
  const monthly = Array.from(monthlyMap.values()).sort((a, b) => b.month.localeCompare(a.month));

  const { rows: voids } = await db.query(
    `WITH s AS (SELECT id FROM cashier_sessions WHERE cashier_id = $1 AND session_date BETWEEN $2 AND $3)
     SELECT 'sim' AS type, x.id, x.session_id, x.void_reason, x.voided_at, x.selling_price_snapshot AS amount, x.offer_name_snapshot AS detail
       FROM session_sim_sales x WHERE x.is_voided = TRUE AND x.session_id IN (SELECT id FROM s)
     UNION ALL SELECT 'storm', x.id, x.session_id, x.void_reason, x.voided_at, x.amount, x.note
       FROM session_storm_entries x WHERE x.is_voided = TRUE AND x.session_id IN (SELECT id FROM s)
     UNION ALL SELECT 'accessory', x.id, x.session_id, x.void_reason, x.voided_at, x.price_snapshot, x.product_name_snapshot
       FROM session_accessory_sales x WHERE x.is_voided = TRUE AND x.session_id IN (SELECT id FROM s)
     UNION ALL SELECT 'debt', x.id, x.session_id, x.void_reason, x.voided_at, x.amount, x.description
       FROM session_debts x WHERE x.is_voided = TRUE AND x.session_id IN (SELECT id FROM s) ORDER BY voided_at DESC`, [cashierId, from, to]
  );

  const { rows: advRows } = await db.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'advance'   AND is_voided = FALSE), 0)
          - COALESCE(SUM(amount) FILTER (WHERE direction = 'repayment' AND is_voided = FALSE), 0) AS outstanding_balance
       FROM cashier_advances WHERE cashier_id = $1`, [cashierId]
  );

  const rangeDays = daysBetween(from, to);
  const [{ rows: prelevementMonths }, manualRecharges] = await Promise.all([
    db.query(
      `WITH combined AS (
         SELECT cs.cashier_id, DATE_TRUNC('month', se.entered_at)::date AS month, se.amount AS base_amount
           FROM session_storm_entries se JOIN cashier_sessions cs ON cs.id = se.session_id
          WHERE se.is_voided = FALSE AND cs.session_date BETWEEN $1 AND $2
         UNION ALL
         SELECT cs.cashier_id, DATE_TRUNC('month', ss.sold_at)::date AS month, ss.real_price_snapshot AS base_amount
           FROM session_sim_sales ss JOIN cashier_sessions cs ON cs.id = ss.session_id
          WHERE ss.is_voided = FALSE AND cs.session_date BETWEEN $1 AND $2
       )
       SELECT cashier_id, month, SUM(base_amount) AS base_amount FROM combined GROUP BY cashier_id, month`,
      [from, to]
    ),
    manualRechargesByMonth(from, to),
  ]);

  const totals = sessions.reduce((acc, s) => {
    acc.sim_units += parseInt(s.sim_units_sold, 10) || 0; acc.sim_revenue += parseFloat(s.sim_total_selling_price) || 0; acc.sim_cost += parseFloat(s.sim_total_real_price) || 0;
    acc.sim_points += parseInt(s.sim_total_points, 10) || 0;
    acc.storm_revenue += parseFloat(s.storm_total) || 0; acc.accessories_revenue += parseFloat(s.accessories_total) || 0; acc.accessories_cost += parseFloat(s.accessories_total_real_price) || 0;
    acc.commissions += parseFloat(s.total_cashier_benefit) || 0; acc.debts += parseFloat(s.debt_total) || 0; 
    acc.loyalty_points_redeemed += parseFloat(s.loyalty_points_redeemed) || 0;
    acc.loyalty_driven_revenue += parseFloat(s.loyalty_driven_revenue) || 0;
    return acc;
  }, { sim_units: 0, sim_revenue: 0, sim_cost: 0, sim_points: 0, storm_revenue: 0, accessories_revenue: 0, accessories_cost: 0, commissions: 0, debts: 0, loyalty_points_redeemed: 0, loyalty_driven_revenue: 0 });
  
  totals.loyalty_discount_dzd = totals.loyalty_points_redeemed * ptVal;

  // This cashier's share of the manual recharges (proportional to their part of the Prélèvement base).
  const myBaseByMonth = new Map();
  const allBaseByMonth = new Map();
  for (const r of prelevementMonths) {
    const k = monthKey(r.month);
    const b = parseFloat(r.base_amount) || 0;
    allBaseByMonth.set(k, (allBaseByMonth.get(k) || 0) + b);
    if (r.cashier_id === cashierId) myBaseByMonth.set(k, (myBaseByMonth.get(k) || 0) + b);
  }
  const myBase  = Array.from(myBaseByMonth.values()).reduce((s, b) => s + b, 0);
  const allBase = Array.from(allBaseByMonth.values()).reduce((s, b) => s + b, 0);

  let total_prelevement = 0;
  const base_total = totals.storm_revenue + totals.sim_cost;
  if (rangeDays === 1) {
    const manualShare = allBase > 0 ? manualRecharges.total * (myBase / allBase) : 0;
    total_prelevement = (base_total + manualShare) * 0.025;
  } else {
    for (const [k, mine] of myBaseByMonth) {
      const whole = allBaseByMonth.get(k) || 0;
      const manualMonth = manualRecharges.byMonth.get(k) || 0;
      const manualShare = whole > 0 ? manualMonth * (mine / whole) : 0;
      total_prelevement += calculatePrelevement(mine + manualShare);
    }
  }

  // PURE GROSS PROFIT MATH
  const final_gross_profit = (totals.sim_revenue - totals.sim_cost + totals.sim_points) + (totals.accessories_revenue - totals.accessories_cost) + total_prelevement;

  sendSuccess(res, {
    cashier, from, to,
    totals: { ...totals, prelevement: total_prelevement, gross_profit: final_gross_profit, total_revenue: totals.sim_revenue + totals.storm_revenue + totals.accessories_revenue },
    sessions, monthly, voided_transactions: voids, voided_count: voids.length, outstanding_advance_balance: parseFloat(advRows[0]?.outstanding_balance) || 0,
  });
});

// ─── GET /api/reports/audit ─────────────────────────────────────────────────

const getAuditLog = asyncHandler(async (req, res) => {
  const conditions = []; const params = [];
  if (req.query.user_id) { params.push(parseId(req.query.user_id, 'user_id')); conditions.push(`a.user_id = $${params.length}`); }
  if (req.query.action) { params.push(String(req.query.action).toUpperCase()); conditions.push(`a.action = $${params.length}::audit_action`); }
  if (req.query.table) { params.push(String(req.query.table)); conditions.push(`a.table_name = $${params.length}`); }
  if (req.query.record_id) { params.push(parseId(req.query.record_id, 'record_id')); conditions.push(`a.record_id = $${params.length}`); }
  if (req.query.from) { params.push(parseDate(req.query.from, 'from')); conditions.push(`a.created_at >= $${params.length}::timestamptz`); }
  if (req.query.to) { params.push(parseDate(req.query.to, 'to')); conditions.push(`a.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
  if (req.query.search) { params.push(`%${String(req.query.search).trim()}%`); conditions.push(`(a.description ILIKE $${params.length} OR u.username ILIKE $${params.length})`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit  = Math.min(Math.max(parseInt(req.query.limit  || '50', 10), 1), 500);
  const offset = Math.max(parseInt(req.query.offset || '0',  10), 0);
  params.push(limit, offset);

  const [{ rows }, { rows: countRows }] = await Promise.all([
    db.query(`SELECT a.id, a.user_id, u.username, u.full_name AS user_full_name, u.role, a.action, a.table_name, a.record_id, a.old_values, a.new_values, a.description, a.ip_address, a.created_at FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
    db.query(`SELECT COUNT(*)::int AS total FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${where ? where.replace(/\$\d+/g, (m) => m) : ''}`, params.slice(0, params.length - 2)),
  ]);

  sendSuccess(res, { items: rows, total: countRows[0]?.total ?? 0, limit, offset });
});

module.exports = {
  generateDailyReport, previewDailyReport, getReports, getReportById,
  getDateRangeReport, exportReportCsv, getMonthlySummary, getTopRollup,
  getCashierHistory, getAuditLog,
};