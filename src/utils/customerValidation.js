'use strict';

const AppError = require('./AppError');

const LIST_FILTERS = ['all', 'valid', 'invalid', 'unreviewed', 'pending'];
const SET_STATUSES = ['valid', 'invalid', 'unreviewed'];

/** The cashier's "correct information" text (required, 1–1000 chars). */
const parseDescription = (raw) => {
  const s = String(raw ?? '').trim();
  if (!s) throw AppError.badRequest('Please write the correct information.', 'VALIDATION_ERROR');
  if (s.length > 1000) throw AppError.badRequest('The text is too long (max 1000 characters).', 'VALIDATION_ERROR');
  return s;
};

/** Admin's optional note explaining what is wrong (0–500 chars). Empty → null. */
const parseNote = (raw) => {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > 500) throw AppError.badRequest('The note is too long (max 500 characters).', 'VALIDATION_ERROR');
  return s;
};

const parseSetStatus = (raw) => {
  if (!SET_STATUSES.includes(raw)) {
    throw AppError.badRequest('status must be "valid", "invalid" or "unreviewed".', 'VALIDATION_ERROR');
  }
  return raw;
};

/**
 * WHERE clause for the admin review list (aliases: c = customers, v = customer_validations).
 *   q          name / phone search
 *   validation all | valid | invalid | unreviewed | pending (has corrections waiting for the admin)
 * The "LEGACY-UNKNOWN" placeholder customer (no real phone number) is always excluded.
 */
const buildReviewFilter = (query = {}) => {
  const params = [];
  const conds = [`c.phone_number ~ '[0-9]{6}'`];

  if (query.q && String(query.q).trim()) {
    params.push(`%${String(query.q).trim()}%`);
    conds.push(`(c.phone_number ILIKE $${params.length} OR (c.first_name || ' ' || c.last_name) ILIKE $${params.length})`);
  }

  const filter = query.validation || 'all';
  if (!LIST_FILTERS.includes(filter)) {
    throw AppError.badRequest('validation must be all, valid, invalid, unreviewed or pending.', 'VALIDATION_ERROR');
  }
  if (filter === 'valid')      conds.push(`v.status = 'valid'`);
  if (filter === 'invalid')    conds.push(`v.status = 'invalid'`);
  if (filter === 'unreviewed') conds.push('v.status IS NULL');
  if (filter === 'pending') {
    conds.push(`EXISTS (SELECT 1 FROM customer_corrections cp WHERE cp.customer_id = c.id AND cp.status = 'pending')`);
  }

  return { params, where: `WHERE ${conds.join(' AND ')}` };
};

module.exports = { LIST_FILTERS, SET_STATUSES, parseDescription, parseNote, parseSetStatus, buildReviewFilter };