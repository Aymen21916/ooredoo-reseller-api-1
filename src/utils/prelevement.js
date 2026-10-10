'use strict';

/**
 * Prélèvement helpers.
 *
 * SINGLE SOURCE OF TRUTH: the only input of the Prélèvement is the list of
 * manual "RECHARGE" items of the Side-Ledger — exactly the figures returned by
 * `GET /api/finances/manual-ledger` (financesController.getManualLedger).
 * Both that endpoint and every report use `fetchManualLedger` /
 * `getPrelevementForRange` below, so the numbers can never diverge.
 *
 * Storm and SIM cost are NOT part of the base any more.
 */

const db = require('../config/db');
const { MANUAL_ITEMS_SQL, manualRechargesByMonth } = require('./manualLedger');

// ─── Tiered calculation ──────────────────────────────────────────────────────
// `manualRecharges` = total manual recharges of ONE month (DZD).
//   0        – 700 000  : 2.5 %
//   700 000  – 1 200 000: 17 500 + 3 %   of the part above 700 000
//   1 200 000 – 1 800 000: 32 500 + 3.5 % of the part above 1 200 000
//   > 1 800 000          : 53 500 + 4 %   of the part above 1 800 000
// (the previous code used 52 500 for the last tier, which made the result drop
//  by 1 000 DZD when crossing 1 800 000 — 32 500 + 600 000 × 3.5 % = 53 500.)
const calculatePrelevement = (manualRecharges) => {
  const amount = Number(manualRecharges) || 0;
  if (amount <= 0) return 0;
  if (amount <= 700000)  return amount * 0.025;
  if (amount <= 1200000) return 17500 + (amount - 700000) * 0.03;
  if (amount <= 1800000) return 32500 + (amount - 1200000) * 0.035;
  return 53500 + (amount - 1800000) * 0.04;
};

// ─── Manual ledger access (same query as GET /manual-ledger) ────────────────

/** Items + totals of the manual ledger for [from, to]. Used by getManualLedger. */
const fetchManualLedger = async (from, to) => {
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
  return { items, sums: sums[0] || {} };
};

/**
 * Prélèvement for a period = Σ calculatePrelevement(manual recharges of each month).
 * The tiers are monthly, so a period spanning several months is calculated month by month.
 * `wholeMonths: true` widens [from, to] to full calendar months (used by the monthly summary).
 * Month grouping comes from utils/manualLedger.manualRechargesByMonth (same MANUAL_ITEMS_SQL).
 */
const getPrelevementForRange = async (from, to, { wholeMonths = false } = {}) => {
  const { byMonth } = await manualRechargesByMonth(from || null, to || null, { wholeMonths });
  const months = Array.from(byMonth, ([month, recharges]) => ({
    month,
    manual_recharges: recharges,
    prelevement: calculatePrelevement(recharges),
  })).sort((a, b) => a.month.localeCompare(b.month));
  return {
    manual_recharges: months.reduce((s, m) => s + m.manual_recharges, 0),
    prelevement: months.reduce((s, m) => s + m.prelevement, 0),
    by_month: months,
  };
};

module.exports = {
  calculatePrelevement,
  fetchManualLedger,
  getPrelevementForRange,
};