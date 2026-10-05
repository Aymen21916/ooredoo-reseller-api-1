'use strict';

const db = require('../config/db');
const AppError = require('../utils/AppError');
const { asyncHandler, sendSuccess, sendCreated } = require('../utils/asyncHandler');
const { audit } = require('../utils/audit');
const {
  requireFields, parseId, parseString, parsePagination, validateAmount, validateVoidReason,
} = require('../utils/validators');
const { buildFilters } = require('../utils/registerLedger');

const num = (v) => parseFloat(v) || 0;
const fmt = (n) => `${n.toFixed(2)} DZD`;

/** Money currently in a store's register = active "in" − active "out". Call inside a store-locked transaction. */
const storeBalance = async (client, storeId) => {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN total_amount ELSE -total_amount END), 0) AS balance
       FROM register_ledger
      WHERE store_id = $1 AND is_voided = FALSE`,
    [storeId]
  );
  return num(rows[0].balance);
};

// Serialises every money movement of one store (manual entries and voids).
const lockStore = async (client, storeId) => {
  const { rows } = await client.query(`SELECT id FROM stores WHERE id = $1 FOR UPDATE`, [storeId]);
  if (!rows[0]) throw AppError.notFound('Store not found.', 'STORE_NOT_FOUND');
};

// GET /api/register-ledger/filters — options for the dropdowns (+ current balance per store)
const getFilters = asyncHandler(async (req, res) => {
  const [{ rows: stores }, { rows: users }] = await Promise.all([
    db.query(
      `SELECT s.id, s.name, COALESCE(b.balance, 0) AS balance
         FROM stores s
         LEFT JOIN (
           SELECT store_id, SUM(CASE WHEN direction = 'in' THEN total_amount ELSE -total_amount END) AS balance
             FROM register_ledger WHERE is_voided = FALSE GROUP BY store_id
         ) b ON b.store_id = s.id
        WHERE s.is_active = TRUE OR b.store_id IS NOT NULL
        ORDER BY s.name`
    ),
    db.query(
      `SELECT u.id, u.full_name, u.role
         FROM users u
        WHERE u.is_active = TRUE OR u.id IN (SELECT DISTINCT user_id FROM register_ledger)
        ORDER BY u.full_name`
    ),
  ]);
  sendSuccess(res, {
    stores: stores.map((s) => ({ id: s.id, name: s.name, balance: num(s.balance) })),
    users,
  });
});

// GET /api/register-ledger?store_id&user_id&from&to&status1=all|active|void&status2=all|in|out&limit&offset
const listLedger = asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query);
  const { params, scopeWhere, rowWhere } = buildFilters(req.query);

  const summaryWhere = scopeWhere ? `${scopeWhere} AND l.is_voided = FALSE` : 'WHERE l.is_voided = FALSE';

  const [{ rows }, { rows: countRows }, { rows: sumRows }] = await Promise.all([
    db.query(
      `SELECT l.id, l.store_id, st.name AS store_name, l.user_id, u.full_name AS user_name,
              l.session_id, l.source, l.direction, to_char(l.entry_date, 'YYYY-MM-DD') AS entry_date,
              l.description, l.total_amount, l.sim_amount, l.storm_amount, l.product_amount,
              l.debts_amount, l.expenses_amount,
              l.is_voided, l.voided_at, vu.full_name AS voided_by_name, l.void_reason, l.created_at
         FROM register_ledger l
         JOIN stores st ON st.id = l.store_id
         JOIN users  u  ON u.id  = l.user_id
         LEFT JOIN users vu ON vu.id = l.voided_by
         ${rowWhere}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*)::int AS total FROM register_ledger l ${rowWhere}`, params),
    db.query(
      `SELECT COALESCE(SUM(l.total_amount) FILTER (WHERE l.direction = 'in'),  0) AS collected,
              COALESCE(SUM(l.total_amount) FILTER (WHERE l.direction = 'out'), 0) AS taken
         FROM register_ledger l ${summaryWhere}`,
      params
    ),
  ]);

  const collected = num(sumRows[0].collected);
  const taken = num(sumRows[0].taken);

  sendSuccess(res, {
    items: rows.map((r) => ({
      ...r,
      total_amount: num(r.total_amount),
      sim_amount: num(r.sim_amount),
      storm_amount: num(r.storm_amount),
      product_amount: num(r.product_amount),
      debts_amount: num(r.debts_amount),
      expenses_amount: num(r.expenses_amount),
    })),
    total: countRows[0].total,
    limit,
    offset,
    // Always counts active entries only and ignores the status filters.
    summary: { collected, taken, remaining: collected - taken },
  });
});

// POST /api/register-ledger/manual  { store_id, direction: 'in'|'out', amount, description? }
const createManualEntry = asyncHandler(async (req, res) => {
  requireFields(req.body, ['store_id', 'direction', 'amount']);
  const storeId = parseId(req.body.store_id, 'store_id');
  const direction = req.body.direction;
  if (!['in', 'out'].includes(direction)) {
    throw AppError.badRequest('direction must be "in" (add money) or "out" (take money).', 'VALIDATION_ERROR');
  }
  const amount = validateAmount(req.body.amount, { min: 0.01, max: 9999999.99, decimals_allowed: 2, fieldName: 'amount' });
  const description = req.body.description && String(req.body.description).trim()
    ? parseString(req.body.description, 'description', 500)
    : (direction === 'in' ? 'Cash added to the register by admin' : 'Cash taken from the register by admin');

  const entry = await db.withTransaction(async (client) => {
    await lockStore(client, storeId);

    if (direction === 'out') {
      const balance = await storeBalance(client, storeId);
      if (amount > balance + 0.001) {
        throw AppError.badRequest(
          `Not enough cash in this register: only ${fmt(balance)} available.`,
          'INSUFFICIENT_REGISTER_CASH'
        );
      }
    }

    const { rows } = await client.query(
      `INSERT INTO register_ledger
         (store_id, user_id, source, direction, entry_date, description, total_amount, created_by)
       VALUES ($1, $2, 'manual', $3, CURRENT_DATE, $4, $5, $2)
       RETURNING id, store_id, direction, total_amount, description, created_at`,
      [storeId, req.user.id, direction, description, amount]
    );
    return rows[0];
  });

  audit({
    userId: req.user.id, action: 'INSERT', table: 'register_ledger', recordId: entry.id,
    newValues: { store_id: storeId, direction, amount }, description, ip: req.clientIp,
  });

  sendCreated(res, { ...entry, total_amount: num(entry.total_amount) }, direction === 'in' ? 'Money added to the register.' : 'Money taken from the register.');
});

// POST /api/register-ledger/:id/void  { reason }
const voidEntry = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id, 'id');
  const reason = validateVoidReason(req.body && req.body.reason);

  // Find the store first so we can lock it BEFORE locking the entry (same order everywhere → no deadlocks).
  const { rows: pre } = await db.query(`SELECT store_id FROM register_ledger WHERE id = $1`, [id]);
  if (!pre[0]) throw AppError.notFound('Entry not found.', 'ENTRY_NOT_FOUND');

  await db.withTransaction(async (client) => {
    await lockStore(client, pre[0].store_id);

    const { rows } = await client.query(`SELECT * FROM register_ledger WHERE id = $1 FOR UPDATE`, [id]);
    const row = rows[0];
    if (!row) throw AppError.notFound('Entry not found.', 'ENTRY_NOT_FOUND');
    if (row.is_voided) throw AppError.conflict('This entry is already voided.', 'ALREADY_VOIDED');

    await client.query(
      `UPDATE register_ledger SET is_voided = TRUE, voided_at = NOW(), voided_by = $1, void_reason = $2 WHERE id = $3`,
      [req.user.id, reason, id]
    );

    // Voiding collected money must not leave the register in the red:
    // if part of it was already taken, the withdrawal has to be voided first.
    if (row.direction === 'in') {
      const balance = await storeBalance(client, row.store_id);
      if (balance < -0.001) {
        throw AppError.conflict(
          `Cannot void: this register would end up at ${fmt(balance)} because the money was already taken. Void the withdrawal first.`,
          'VOID_WOULD_OVERDRAW'
        );
      }
    }
  });

  audit({
    userId: req.user.id, action: 'UPDATE', table: 'register_ledger', recordId: id,
    newValues: { is_voided: true, void_reason: reason }, description: `Voided register entry #${id}: ${reason}`, ip: req.clientIp,
  });

  sendSuccess(res, null, 200, 'Entry voided.');
});

module.exports = { getFilters, listLedger, createManualEntry, voidEntry };