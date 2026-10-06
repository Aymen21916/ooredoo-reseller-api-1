'use strict';

const db = require('../config/db');
const AppError = require('../utils/AppError');
const { asyncHandler, sendSuccess, sendCreated } = require('../utils/asyncHandler');
const { audit } = require('../utils/audit');
const { parseId, parsePagination } = require('../utils/validators');
const {
  parseDescription, parseNote, parseSetStatus, buildReviewFilter,
} = require('../utils/customerValidation');

const MAX_PENDING_PER_CASHIER = 5; // per customer, so a cashier can't flood the admin

// GET /api/customer-validation/alerts  — admin AND cashier (the payload depends on the role)
//   cashier: customers THEY created that the admin marked invalid
//            needs_correction = invalid and nothing sent yet · awaiting_admin = invalid and a correction is waiting
//   admin:   pending_corrections / customers_with_pending / unreviewed customers
const getAlerts = asyncHandler(async (req, res) => {
  if (req.user.role === 'admin') {
    const { rows } = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM customer_corrections WHERE status = 'pending')::int AS pending_corrections,
         (SELECT COUNT(DISTINCT customer_id) FROM customer_corrections WHERE status = 'pending')::int AS customers_with_pending,
         (SELECT COUNT(*) FROM customers c
           WHERE c.phone_number ~ '[0-9]{6}'
             AND NOT EXISTS (SELECT 1 FROM customer_validations v WHERE v.customer_id = c.id))::int AS unreviewed`
    );
    return sendSuccess(res, rows[0]);
  }

  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM customer_corrections cc WHERE cc.customer_id = c.id AND cc.status = 'pending'))::int AS needs_correction,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM customer_corrections cc WHERE cc.customer_id = c.id AND cc.status = 'pending'))::int AS awaiting_admin
       FROM customers c
       JOIN customer_validations v ON v.customer_id = c.id
      WHERE c.created_by = $1 AND v.status = 'invalid'`,
    [req.user.id]
  );
  sendSuccess(res, rows[0]);
});

// GET /api/customer-validation?q&validation=all|valid|invalid|unreviewed|pending&limit&offset   (admin)
const listForReview = asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query);
  const { params, where } = buildReviewFilter(req.query);

  const base = `FROM customers c LEFT JOIN customer_validations v ON v.customer_id = c.id`;

  const [{ rows }, { rows: totalRows }, { rows: countRows }] = await Promise.all([
    db.query(
      `SELECT c.id, c.phone_number, c.first_name, c.last_name, c.address, c.profession,
              c.created_by, cu.full_name AS created_by_name,
              v.status AS validation_status, v.review_note, v.reviewed_at, rb.full_name AS reviewed_by_name,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'id', cc.id, 'description', cc.description,
                         'submitted_by', u.full_name, 'created_at', cc.created_at
                       ) ORDER BY cc.created_at DESC)
                  FROM customer_corrections cc
                  LEFT JOIN users u ON u.id = cc.submitted_by
                 WHERE cc.customer_id = c.id AND cc.status = 'pending'
              ), '[]'::json) AS pending_corrections
         ${base}
         LEFT JOIN users cu ON cu.id = c.created_by
         LEFT JOIN users rb ON rb.id = v.reviewed_by
         ${where}
        ORDER BY EXISTS (SELECT 1 FROM customer_corrections cp WHERE cp.customer_id = c.id AND cp.status = 'pending') DESC,
                 c.last_name, c.first_name, c.id
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*)::int AS total ${base} ${where}`, params),
    // Header counters: always the whole customer base (ignores the search and the filter)
    db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE v.status = 'valid')::int   AS valid,
              COUNT(*) FILTER (WHERE v.status = 'invalid')::int AS invalid,
              COUNT(*) FILTER (WHERE v.status IS NULL)::int     AS unreviewed,
              (SELECT COUNT(DISTINCT customer_id) FROM customer_corrections WHERE status = 'pending')::int AS customers_with_pending,
              (SELECT COUNT(*) FROM customer_corrections WHERE status = 'pending')::int AS pending_corrections
         ${base}
        WHERE c.phone_number ~ '[0-9]{6}'`
    ),
  ]);

  sendSuccess(res, { items: rows, total: totalRows[0].total, limit, offset, counts: countRows[0] });
});

// PUT /api/customer-validation/:customerId  { status: 'valid'|'invalid'|'unreviewed', note? }   (admin)
//   valid      → also closes the pending cashier corrections (they were handled) as 'applied'
//   invalid    → optional note telling the cashier what is wrong
//   unreviewed → removes the review (back to "not reviewed yet")
const setStatus = asyncHandler(async (req, res) => {
  const customerId = parseId(req.params.customerId, 'customerId');
  const status = parseSetStatus(req.body && req.body.status);
  const note = status === 'invalid' ? parseNote(req.body.note) : null;

  const closed = await db.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT id FROM customers WHERE id = $1`, [customerId]);
    if (!rows[0]) throw AppError.notFound('Customer not found.', 'CUSTOMER_NOT_FOUND');

    if (status === 'unreviewed') {
      await client.query(`DELETE FROM customer_validations WHERE customer_id = $1`, [customerId]);
      return 0;
    }

    await client.query(
      `INSERT INTO customer_validations (customer_id, status, review_note, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (customer_id) DO UPDATE
         SET status = EXCLUDED.status, review_note = EXCLUDED.review_note,
             reviewed_by = EXCLUDED.reviewed_by, reviewed_at = NOW()`,
      [customerId, status, note, req.user.id]
    );

    if (status === 'valid') {
      const r = await client.query(
        `UPDATE customer_corrections
            SET status = 'applied', resolved_by = $2, resolved_at = NOW()
          WHERE customer_id = $1 AND status = 'pending'`,
        [customerId, req.user.id]
      );
      return r.rowCount || 0;
    }
    return 0;
  });

  audit({
    userId: req.user.id, action: 'UPDATE', table: 'customer_validations', recordId: customerId,
    newValues: { status, note }, description: `Customer #${customerId} marked ${status}`, ip: req.clientIp,
  });

  sendSuccess(res, { customer_id: customerId, status, closed_corrections: closed }, 200, 'Validation updated.');
});

// POST /api/customer-validation/corrections  { customer_id, description }   (cashier)
const createCorrection = asyncHandler(async (req, res) => {
  const customerId = parseId(req.body && req.body.customer_id, 'customer_id');
  const description = parseDescription(req.body.description);

  const { rows } = await db.query(
    `SELECT c.id, c.created_by, v.status,
            (SELECT COUNT(*) FROM customer_corrections cc
              WHERE cc.customer_id = c.id AND cc.status = 'pending' AND cc.submitted_by = $2)::int AS my_pending
       FROM customers c
       LEFT JOIN customer_validations v ON v.customer_id = c.id
      WHERE c.id = $1`,
    [customerId, req.user.id]
  );
  const customer = rows[0];
  if (!customer) throw AppError.notFound('Customer not found.', 'CUSTOMER_NOT_FOUND');
  if (customer.created_by !== req.user.id) {
    throw AppError.forbidden('You can only send corrections for your own customers.', 'NOT_YOUR_CUSTOMER');
  }
  if (customer.status !== 'invalid') {
    throw AppError.conflict('This customer does not need a correction.', 'NOT_INVALID');
  }
  if (customer.my_pending >= MAX_PENDING_PER_CASHIER) {
    throw AppError.conflict('You already sent several corrections for this customer. Please wait for the admin.', 'TOO_MANY_PENDING');
  }

  const { rows: created } = await db.query(
    `INSERT INTO customer_corrections (customer_id, submitted_by, description)
     VALUES ($1, $2, $3)
     RETURNING id, customer_id, description, status, created_at`,
    [customerId, req.user.id, description]
  );

  audit({
    userId: req.user.id, action: 'INSERT', table: 'customer_corrections', recordId: created[0].id,
    newValues: { customer_id: customerId }, description: `Correction sent for customer #${customerId}`, ip: req.clientIp,
  });

  sendCreated(res, created[0], 'Sent to the admin.');
});

// POST /api/customer-validation/corrections/:id/resolve  { action: 'applied'|'dismissed' }   (admin)
const resolveCorrection = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id, 'id');
  const action = req.body && req.body.action;
  if (!['applied', 'dismissed'].includes(action)) {
    throw AppError.badRequest('action must be "applied" or "dismissed".', 'VALIDATION_ERROR');
  }

  const { rows } = await db.query(
    `UPDATE customer_corrections
        SET status = $1, resolved_by = $2, resolved_at = NOW()
      WHERE id = $3 AND status = 'pending'
      RETURNING id, customer_id, status`,
    [action, req.user.id, id]
  );
  if (!rows[0]) {
    const { rows: exists } = await db.query(`SELECT status FROM customer_corrections WHERE id = $1`, [id]);
    if (!exists[0]) throw AppError.notFound('Correction not found.', 'CORRECTION_NOT_FOUND');
    throw AppError.conflict('This correction was already resolved.', 'ALREADY_RESOLVED');
  }

  audit({
    userId: req.user.id, action: 'UPDATE', table: 'customer_corrections', recordId: id,
    newValues: { status: action }, description: `Correction #${id} ${action}`, ip: req.clientIp,
  });

  sendSuccess(res, rows[0], 200, action === 'applied' ? 'Marked as applied.' : 'Dismissed.');
});

module.exports = { getAlerts, listForReview, setStatus, createCorrection, resolveCorrection };