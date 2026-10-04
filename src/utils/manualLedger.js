'use strict';

const db = require('../config/db');

// A manual Side-Ledger item is a global_pool_state row whose notes look like
//   "[RECHARGE] <amount> | <note>"   or   "[REWARD] <amount> | <note>"
// (written by financesController.updatePool).
const MANUAL_ITEMS_SQL = `
  SELECT g.id,
         g.updated_at AS created_at,
         g.updated_by,
         CASE WHEN g.notes LIKE '[RECHARGE] %' THEN 'RECHARGE' ELSE 'REWARD' END AS type,
         CASE WHEN t.tok ~ '^-?[0-9]+([.][0-9]+)?$' THEN t.tok::numeric ELSE 0 END AS amount,
         CASE WHEN strpos(g.notes, ' | ') > 0
              THEN btrim(substr(g.notes, strpos(g.notes, ' | ') + 3))
              ELSE '' END AS note
    FROM global_pool_state g
    CROSS JOIN LATERAL (
      SELECT split_part(split_part(g.notes, '] ', 2), ' ', 1) AS tok
    ) t
   WHERE g.notes LIKE '[RECHARGE] %' OR g.notes LIKE '[REWARD] %'`;

const pad = (n) => String(n).padStart(2, '0');

/** "YYYY-MM" key for a month value that may be a Date or a 'YYYY-MM-DD' string. */
const monthKey = (m) => {
  if (m instanceof Date) return `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
  return String(m).slice(0, 7);
};

/**
 * Manual recharges added in [from, to] (calendar days), grouped by month.
 * wholeMonths = true widens the range to full calendar months (used by the monthly summary).
 * Returns { byMonth: Map('YYYY-MM' -> total), total }.
 */
const manualRechargesByMonth = async (from, to, { wholeMonths = false } = {}) => {
  const lower = wholeMonths ? `DATE_TRUNC('month', $1::date)` : `$1::date`;
  const upper = wholeMonths ? `(DATE_TRUNC('month', $2::date) + INTERVAL '1 month')` : `($2::date + 1)`;

  const { rows } = await db.query(
    `SELECT DATE_TRUNC('month', m.created_at)::date AS month,
            COALESCE(SUM(m.amount), 0)              AS total
       FROM (${MANUAL_ITEMS_SQL}) m
      WHERE m.type = 'RECHARGE'
        AND ($1::date IS NULL OR m.created_at::date >= ${lower})
        AND ($2::date IS NULL OR m.created_at::date <  ${upper})
      GROUP BY 1`,
    [from || null, to || null]
  );

  const byMonth = new Map();
  let total = 0;
  for (const r of rows) {
    const t = parseFloat(r.total) || 0;
    byMonth.set(monthKey(r.month), t);
    total += t;
  }
  return { byMonth, total };
};

module.exports = { MANUAL_ITEMS_SQL, manualRechargesByMonth, monthKey };