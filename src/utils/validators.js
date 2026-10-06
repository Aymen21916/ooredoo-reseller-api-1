'use strict';

const AppError = require('./AppError');

// ─── Field presence ──────────────────────────────────────────────────────────

/**
 * Assert that all required keys are present and non-empty in `obj`.
 * Throws a 400 AppError listing the missing fields.
 *
 * @param {object}   obj
 * @param {string[]} fields
 */
const requireFields = (obj, fields) => {
  const missing = fields.filter(
    (k) => obj[k] === undefined || obj[k] === null || obj[k] === ''
  );
  if (missing.length) {
    throw AppError.badRequest(`Missing required field(s): ${missing.join(', ')}`, 'VALIDATION_ERROR');
  }
};

// ─── Type coercions ──────────────────────────────────────────────────────────

/**
 * Parse and validate a positive number. Throws 400 on failure.
 * @param {any}    value
 * @param {string} fieldName
 * @param {boolean} [allowZero=false]
 * @returns {number}
 */
const parsePositiveNumber = (value, fieldName, allowZero = false) => {
  const n = Number(value);
  if (Number.isNaN(n) || (allowZero ? n < 0 : n <= 0)) {
    throw AppError.badRequest(
      `"${fieldName}" must be a ${allowZero ? 'non-negative' : 'positive'} number.`,
      'VALIDATION_ERROR'
    );
  }
  return n;
};

/**
 * Parse and validate a positive integer. Throws 400 on failure.
 * @param {any}    value
 * @param {string} fieldName
 * @param {boolean} [allowZero=false]
 * @returns {number}
 */
const parsePositiveInt = (value, fieldName, allowZero = false) => {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || (allowZero ? n < 0 : n <= 0)) {
    throw AppError.badRequest(
      `"${fieldName}" must be a ${allowZero ? 'non-negative' : 'positive'} integer.`,
      'VALIDATION_ERROR'
    );
  }
  return n;
};

/**
 * Parse a route/query param as an integer id. Throws 404 on failure.
 * @param {any}    value
 * @param {string} [paramName='id']
 * @returns {number}
 */
const parseId = (value, paramName = 'id') => {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw AppError.notFound(`Invalid ${paramName}.`);
  }
  return n;
};

/**
 * Parse a YYYY-MM-DD date string. Throws 400 on failure.
 * Note: this is the legacy permissive variant kept for backwards compatibility.
 * Prefer `parseDateOnly` for stricter calendar validation.
 *
 * @param {any}    value
 * @param {string} fieldName
 * @returns {string} YYYY-MM-DD
 */
const parseDate = (value, fieldName) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw AppError.badRequest(`"${fieldName}" must be a valid date in YYYY-MM-DD format.`, 'VALIDATION_ERROR');
  }
  return value;
};

/**
 * Parse a datetime string (e.g., from a datetime-local input). Throws 400 on failure.
 *
 * @param {any}    value
 * @param {string} fieldName
 * @returns {string} 
 */
const parseDateTime = (value, fieldName) => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw AppError.badRequest(`"${fieldName}" must be a valid date and time.`, 'VALIDATION_ERROR');
  }
  return value;
};

/**
 * Validate that a string is non-empty and within maxLength.
 * @param {any}    value
 * @param {string} fieldName
 * @param {number} [maxLength=200]
 * @returns {string}
 */
const parseString = (value, fieldName, maxLength = 200) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw AppError.badRequest(`"${fieldName}" must be a non-empty string.`, 'VALIDATION_ERROR');
  }
  if (value.trim().length > maxLength) {
    throw AppError.badRequest(`"${fieldName}" must be at most ${maxLength} characters.`, 'VALIDATION_ERROR');
  }
  return value.trim();
};

/**
 * Validate pagination parameters from query string.
 * @param {object} query
 * @returns {{ limit: number, offset: number }}
 */
const parsePagination = (query) => {
  const limit  = Math.min(Math.max(parseInt(query.limit  || '50', 10), 1), 200);
  const offset = Math.max(parseInt(query.offset || '0',  10), 0);
  return { limit, offset };
};

// ─── Financial-tracking extensions ───────────────────────────────────────────
//
// The following helpers back the customer-linked debt modal, the cashier
// advances ledger, the register-expense logger, and the date-range report.
// All length checks are performed AFTER trimming whitespace, per the design
// document's "Field Validation Rules" table.

/**
 * Trim a value if it's a string; return '' for null/undefined; otherwise '' too.
 * @param {any} v
 * @returns {string}
 */
const safeTrim = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Validate a `customers` payload coming from the new-customer step of the
 * debt modal. Performs trim-then-check on every field so leading/trailing
 * whitespace cannot be used to bypass the NOT NULL / length constraints.
 *
 *   phone_number  : 8..20 chars, /^\+?\d+$/
 *   first_name    : 1..100 chars
 *   last_name     : 1..100 chars
 *   address       : 1..1000 chars
 *   profession    : 1..100 chars
 *
 * Throws AppError('VALIDATION_ERROR', 400) on the first failing rule, with a
 * message listing every failing field. Returns the trimmed payload on success.
 *
 * @param {{phone_number?: any, first_name?: any, last_name?: any,
 *          address?: any, profession?: any}} fields
 * @returns {{phone_number: string, first_name: string, last_name: string,
 *           address: string, profession: string}}
 */
const validateCustomerFields = (fields = {}) => {
  const phone_number = safeTrim(fields.phone_number);
  const first_name   = safeTrim(fields.first_name);
  const last_name    = safeTrim(fields.last_name);
  const address      = safeTrim(fields.address);
  const profession   = safeTrim(fields.profession);

  const errors = [];

  if (
    phone_number.length < 8 ||
    phone_number.length > 20 ||
    !/^\+?\d+$/.test(phone_number)
  ) {
    errors.push('phone_number must be 8..20 characters of digits with an optional leading "+"');
  }
  if (first_name.length < 1 || first_name.length > 100) {
    errors.push('first_name must be 1..100 characters after trimming');
  }
  if (last_name.length < 1 || last_name.length > 100) {
    errors.push('last_name must be 1..100 characters after trimming');
  }
  if (address.length < 1 || address.length > 1000) {
    errors.push('address must be 1..1000 characters after trimming');
  }
  if (profession.length < 1 || profession.length > 100) {
    errors.push('profession must be 1..100 characters after trimming');
  }

  if (errors.length) {
    throw AppError.badRequest(
      `Invalid customer fields: ${errors.join('; ')}.`,
      'VALIDATION_ERROR'
    );
  }

  return { phone_number, first_name, last_name, address, profession };
};

/**
 * Validate a numeric monetary amount against `[min, max]` and a maximum
 * decimal-place count. The check is done on the *string representation* of
 * the input so that `1.005` is rejected against `decimals_allowed = 2`
 * regardless of floating-point precision.
 *
 * Accepts both numbers and numeric strings (the API receives JSON-decoded
 * numbers, but query/form contexts may deliver strings).
 *
 * Returns a normalized `Number` on success. Throws
 * `AppError('VALIDATION_ERROR', 400)` on failure.
 *
 * @param {any} value
 * @param {{min?: number, max?: number, decimals_allowed?: number,
 *          fieldName?: string}} [opts]
 * @returns {number}
 */
const validateAmount = (value, opts = {}) => {
  const {
    min,
    max,
    decimals_allowed = 2,
    fieldName = 'amount',
  } = opts;

  if (value === undefined || value === null || value === '') {
    throw AppError.badRequest(`"${fieldName}" is required.`, 'VALIDATION_ERROR');
  }

  // Booleans coerce to 0/1 via Number(), so reject explicitly.
  if (typeof value === 'boolean') {
    throw AppError.badRequest(`"${fieldName}" must be a finite number.`, 'VALIDATION_ERROR');
  }

  const str = String(value).trim();
  // Plain decimal notation only (no scientific notation, no leading/trailing
  // dot). A leading minus is permitted at the syntactic level so that out-of-
  // range negatives produce a "must be >= min" error rather than a generic
  // "not a number".
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw AppError.badRequest(
      `"${fieldName}" must be a finite decimal number.`,
      'VALIDATION_ERROR'
    );
  }

  const dotIdx  = str.indexOf('.');
  const decimals = dotIdx === -1 ? 0 : str.length - dotIdx - 1;
  if (decimals > decimals_allowed) {
    throw AppError.badRequest(
      `"${fieldName}" must have at most ${decimals_allowed} decimal place(s).`,
      'VALIDATION_ERROR'
    );
  }

  const n = Number(str);
  if (!Number.isFinite(n)) {
    throw AppError.badRequest(`"${fieldName}" must be a finite number.`, 'VALIDATION_ERROR');
  }
  if (typeof min === 'number' && n < min) {
    throw AppError.badRequest(
      `"${fieldName}" must be >= ${min}.`,
      'VALIDATION_ERROR'
    );
  }
  if (typeof max === 'number' && n > max) {
    throw AppError.badRequest(
      `"${fieldName}" must be <= ${max}.`,
      'VALIDATION_ERROR'
    );
  }

  return n;
};

/**
 * Validate a void-reason string. Returns the trimmed value on success.
 *
 * Error contract:
 *   - missing (undefined/null)  → `MISSING_VOID_REASON`
 *   - non-string, or post-trim length outside [1, 500] → `INVALID_VOID_REASON`
 *
 * @param {any} reason
 * @returns {string}
 */
const validateVoidReason = (reason) => {
  if (reason === undefined || reason === null) {
    throw AppError.badRequest('void_reason is required.', 'MISSING_VOID_REASON');
  }
  if (typeof reason !== 'string') {
    throw AppError.badRequest(
      'void_reason must be a string of 1..500 characters after trimming.',
      'INVALID_VOID_REASON'
    );
  }
  const trimmed = reason.trim();
  if (trimmed.length < 1 || trimmed.length > 500) {
    throw AppError.badRequest(
      'void_reason must be 1..500 characters after trimming.',
      'INVALID_VOID_REASON'
    );
  }
  return trimmed;
};

/**
 * Strict YYYY-MM-DD parser. Unlike `parseDate`, this rejects calendar-
 * invalid strings such as "2023-02-30" or "2023-13-01".
 *
 * @param {any}    value
 * @param {string} [fieldName='date']
 * @returns {string} the validated YYYY-MM-DD string
 */
const parseDateOnly = (value, fieldName = 'date') => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw AppError.badRequest(
      `"${fieldName}" must be a date in YYYY-MM-DD format.`,
      'VALIDATION_ERROR'
    );
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    throw AppError.badRequest(
      `"${fieldName}" is not a valid calendar date.`,
      'VALIDATION_ERROR'
    );
  }
  return value;
};

/**
 * Format a Date as a YYYY-MM-DD string in the server's local timezone.
 * Used so date-range comparisons resolve in `Server_Local_Date` (the same
 * basis PostgreSQL's `CURRENT_DATE` resolves in for the API connection).
 *
 * @param {Date} d
 * @returns {string}
 */
const formatLocalDateOnly = (d) => {
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/**
 * Validate a date-range query (`from`, `to`).
 *
 * Rules (from design's "Field Validation Rules" table):
 *   - Both are valid YYYY-MM-DD calendar dates.
 *   - Neither is strictly greater than today (Server_Local_Date).
 *     → `FUTURE_DATE`
 *   - `to >= from`.
 *     → `INVALID_DATE_RANGE`
 *   - `(to - from) <= 366` days.
 *     → `RANGE_TOO_LARGE`
 *
 * @param {any} from
 * @param {any} to
 * @param {{now?: Date}} [opts] - optional injectable clock (for tests)
 * @returns {{from: string, to: string, diff_days: number}}
 */
const validateDateRange = (from, to, opts = {}) => {
  const now = opts.now instanceof Date ? opts.now : new Date();

  const f = parseDateOnly(from, 'from');
  const t = parseDateOnly(to,   'to');
  const today = formatLocalDateOnly(now);

  if (f > today || t > today) {
    throw AppError.badRequest('Date range cannot be in the future.', 'FUTURE_DATE');
  }
  if (t < f) {
    throw AppError.badRequest('"to" must be on or after "from".', 'INVALID_DATE_RANGE');
  }

  // Both are midnight UTC, so the diff in ms is exact integer days.
  const dayMs = 24 * 60 * 60 * 1000;
  const fromMs = (() => { const [y, m, d] = f.split('-').map(Number); return Date.UTC(y, m - 1, d); })();
  const toMs   = (() => { const [y, m, d] = t.split('-').map(Number); return Date.UTC(y, m - 1, d); })();
  const diff_days = Math.round((toMs - fromMs) / dayMs);

  if (diff_days > 366) {
    throw AppError.badRequest('Date range exceeds 366 days.', 'RANGE_TOO_LARGE');
  }

  return { from: f, to: t, diff_days };
};

module.exports = {
  requireFields,
  parsePositiveNumber,
  parsePositiveInt,
  parseId,
  parseDate,
  parseDateTime,
  parseString,
  parsePagination,

  // Financial-tracking extensions
  validateCustomerFields,
  validateAmount,
  validateVoidReason,
  parseDateOnly,
  validateDateRange,
  formatLocalDateOnly,
};
