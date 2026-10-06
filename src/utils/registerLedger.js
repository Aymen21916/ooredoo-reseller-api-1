'use strict';

const AppError = require('./AppError');
const { parseId, parseDateTime } = require('./validators');

// How a closed session turns into register money:
//   true  → total = SIM + Storm + Products − debts − register expenses
//           (the cash that should really be in the drawer; debts are unpaid, expenses were paid out of it)
//   false → total = SIM + Storm + Products (debts and expenses are only recorded, not deducted)
const NET_OF_DEBTS_AND_EXPENSES = true;

/**
 * Writes the "money collected" entry for a closed session.
 * Safe to call twice: a session can only have one ACTIVE collection entry.
 * Sums are taken per table (never joined together) so rows are not multiplied.
 * Sales are counted as cash actually paid: selling price minus loyalty points redeemed.
 */
const recordSessionCollection = async (client, sessionId, createdBy) => {
  const { rows } = await client.query(
    `WITH pt AS (
       SELECT COALESCE((SELECT value::numeric FROM loyalty_settings WHERE key = 'point_to_dzd_value'), 1) AS v
     ),
     calc AS (
       SELECT cs.id AS session_id, cs.store_id, cs.cashier_id, cs.session_date, cs.closed_at,
              u.full_name AS cashier_name, st.name AS store_name,
              ROUND(COALESCE(sim.amount,   0), 2) AS sim_amount,
              ROUND(COALESCE(storm.amount, 0), 2) AS storm_amount,
              ROUND(COALESCE(prod.amount,  0), 2) AS product_amount,
              ROUND(COALESCE(de.amount,    0), 2) AS debts_amount,
              ROUND(COALESCE(ex.amount,    0), 2) AS expenses_amount
         FROM cashier_sessions cs
         JOIN users  u  ON u.id  = cs.cashier_id
         JOIN stores st ON st.id = cs.store_id
         CROSS JOIN pt
         LEFT JOIN LATERAL (
           SELECT SUM(x.selling_price_snapshot - COALESCE(x.loyalty_redeemed_snapshot, 0) * pt.v) AS amount
             FROM session_sim_sales x WHERE x.session_id = cs.id AND x.is_voided = FALSE
         ) sim ON TRUE
         LEFT JOIN LATERAL (
           SELECT SUM(x.amount - COALESCE(x.loyalty_redeemed_snapshot, 0) * pt.v) AS amount
             FROM session_storm_entries x WHERE x.session_id = cs.id AND x.is_voided = FALSE
         ) storm ON TRUE
         LEFT JOIN LATERAL (
           SELECT SUM(x.price_snapshot - COALESCE(x.loyalty_redeemed_snapshot, 0) * pt.v) AS amount
             FROM session_accessory_sales x WHERE x.session_id = cs.id AND x.is_voided = FALSE
         ) prod ON TRUE
         LEFT JOIN LATERAL (
           SELECT SUM(x.amount) AS amount
             FROM session_debts x WHERE x.session_id = cs.id AND x.is_voided = FALSE
         ) de ON TRUE
         LEFT JOIN LATERAL (
           SELECT SUM(x.amount) AS amount
             FROM register_expenses x WHERE x.session_id = cs.id AND x.is_voided = FALSE
         ) ex ON TRUE
        WHERE cs.id = $1
     )
     INSERT INTO register_ledger
       (store_id, user_id, session_id, source, direction, entry_date, description,
        total_amount, sim_amount, storm_amount, product_amount, debts_amount, expenses_amount,
        created_by, created_at)
     SELECT c.store_id, c.cashier_id, c.session_id, 'session', 'in', c.session_date,
            'Daily closing — ' || c.cashier_name || ' (' || c.store_name || ')',
            c.sim_amount + c.storm_amount + c.product_amount
              - CASE WHEN $3::boolean THEN c.debts_amount + c.expenses_amount ELSE 0 END,
            c.sim_amount, c.storm_amount, c.product_amount, c.debts_amount, c.expenses_amount,
            $2, COALESCE(c.closed_at, NOW())
       FROM calc c
     ON CONFLICT (session_id) WHERE source = 'session' AND is_voided = FALSE DO NOTHING
     RETURNING *`,
    [sessionId, createdBy, NET_OF_DEBTS_AND_EXPENSES]
  );
  return rows[0] || null;
};

const STATUS1 = ['all', 'active', 'void'];
const STATUS2 = ['all', 'in', 'out'];

const whereOf = (conds) => (conds.length ? `WHERE ${conds.join(' AND ')}` : '');

/**
 * Turns the query string into SQL conditions (table alias `l`).
 *   scopeWhere : store + user + date range            → used for the summary cards
 *   rowWhere   : scope + status1 (active/void) + status2 (in/out) → used for the table
 * Both share the same positional `params`.
 */
const buildFilters = (query = {}) => {
  const params = [];
  const scope = [];

  if (query.store_id) { params.push(parseId(query.store_id, 'store_id')); scope.push(`l.store_id = $${params.length}`); }
  if (query.user_id)  { params.push(parseId(query.user_id, 'user_id'));   scope.push(`l.user_id = $${params.length}`); }

  let from = null;
  let to = null;
  if (query.from) { 
    from = parseDateTime(query.from, 'from'); 
    params.push(from); 
    scope.push(`l.created_at >= $${params.length}`); 
  }
  if (query.to) { 
    to = parseDateTime(query.to, 'to'); 
    params.push(to); 
    scope.push(`l.created_at <= $${params.length}`); 
  }
  if (from && to && from > to) throw AppError.badRequest('"from" must be on or before "to".', 'INVALID_DATE_RANGE');

  const status1 = query.status1 || 'all';
  const status2 = query.status2 || 'all';
  if (!STATUS1.includes(status1)) throw AppError.badRequest('status1 must be all, active or void.', 'VALIDATION_ERROR');
  if (!STATUS2.includes(status2)) throw AppError.badRequest('status2 must be all, in or out.', 'VALIDATION_ERROR');

  const rows = [...scope];
  if (status1 === 'active') rows.push('l.is_voided = FALSE');
  if (status1 === 'void')   rows.push('l.is_voided = TRUE');
  if (status2 === 'in')     rows.push(`l.direction = 'in'`);
  if (status2 === 'out')    rows.push(`l.direction = 'out'`);

  return { params, scopeConds: scope, scopeWhere: whereOf(scope), rowWhere: whereOf(rows) };
};

module.exports = { NET_OF_DEBTS_AND_EXPENSES, recordSessionCollection, buildFilters };