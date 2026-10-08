'use strict';

const db = require('../config/db');
const AppError = require('../utils/AppError');
const { asyncHandler, sendSuccess, sendCreated } = require('../utils/asyncHandler');
const { audit } = require('../utils/audit');
const { parseId, parseString, validateAmount, validateVoidReason } = require('../utils/validators');
const { sessionLiveTakings } = require('../utils/registerLedger');

const num = (v) => parseFloat(v) || 0;

/** The cashier's open session id, or NO_OPEN_SESSION. */
const requireOpenSession = async (cashierId) => {
  const { rows } = await db.query(
    `SELECT id FROM cashier_sessions WHERE cashier_id = $1 AND status = 'open' LIMIT 1`,
    [cashierId]
  );
  if (!rows[0]) {
    throw AppError.badRequest('You have no open session.', 'NO_OPEN_SESSION');
  }
  return rows[0].id;
};

// POST /api/card-payments  { amount, note? }
// "A customer paid <amount> by credit card: the sale is recorded but no cash came into the drawer."
const createCardPayment = asyncHandler(async (req, res) => {
  const amount = validateAmount(req.body.amount, {
    min: 0.01, max: 9999999.99, decimals_allowed: 2, fieldName: 'amount',
  });
  const note = req.body.note && String(req.body.note).trim()
    ? parseString(req.body.note, 'note', 500)
    : null;

  const sessionId = await requireOpenSession(req.user.id);

  // Card payments can never be higher than what the session sold.
  const live = await sessionLiveTakings(db, sessionId);
  if (live.card + amount > live.sales + 0.001) {
    throw AppError.badRequest(
      'Card payments cannot exceed the total sales of this session.',
      'CARD_EXCEEDS_SALES'
    );
  }

  const { rows } = await db.query(
    `INSERT INTO session_card_payments (session_id, amount, note, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, session_id, amount, note, is_voided, entered_at`,
    [sessionId, amount, note, req.user.id]
  );

  audit({
    userId: req.user.id, action: 'INSERT', table: 'session_card_payments', recordId: rows[0].id,
    newValues: { session_id: sessionId, amount, note }, description: 'Card payment recorded', ip: req.clientIp,
  });

  sendCreated(res, { ...rows[0], amount: num(rows[0].amount) }, 'Card payment recorded.');
});

// GET /api/card-payments/me  → card payments of the cashier's open session + total
const listMyCardPayments = asyncHandler(async (req, res) => {
  const { rows: s } = await db.query(
    `SELECT id FROM cashier_sessions WHERE cashier_id = $1 AND status = 'open' LIMIT 1`,
    [req.user.id]
  );
  if (!s[0]) return sendSuccess(res, { items: [], total: 0 });

  const { rows } = await db.query(
    `SELECT id, session_id, amount, note, is_voided, void_reason, entered_at
       FROM session_card_payments
      WHERE session_id = $1
      ORDER BY entered_at DESC, id DESC`,
    [s[0].id]
  );
  const items = rows.map((r) => ({ ...r, amount: num(r.amount) }));
  const total = items.filter((r) => !r.is_voided).reduce((sum, r) => sum + r.amount, 0);
  sendSuccess(res, { items, total: Math.round(total * 100) / 100 });
});

// POST /api/card-payments/:id/void  { reason }   (own payments, open session only)
const voidCardPayment = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id, 'id');
  const reason = validateVoidReason(req.body && (req.body.reason ?? req.body.void_reason));

  const { rows } = await db.query(
    `UPDATE session_card_payments p
        SET is_voided = TRUE, voided_at = NOW(), voided_by = $1, void_reason = $2
       FROM cashier_sessions cs
      WHERE p.id = $3
        AND cs.id = p.session_id
        AND cs.cashier_id = $1
        AND cs.status = 'open'
        AND p.is_voided = FALSE
      RETURNING p.id, p.amount`,
    [req.user.id, reason, id]
  );
  if (!rows[0]) {
    throw AppError.notFound('Card payment not found, already voided, or its session is closed.');
  }

  audit({
    userId: req.user.id, action: 'VOID', table: 'session_card_payments', recordId: id,
    newValues: { is_voided: true, void_reason: reason, amount: num(rows[0].amount) },
    description: `Voided card payment #${id}`, ip: req.clientIp,
  });

  sendSuccess(res, { id, is_voided: true }, 200, 'Card payment voided.');
});

module.exports = { createCardPayment, listMyCardPayments, voidCardPayment };
