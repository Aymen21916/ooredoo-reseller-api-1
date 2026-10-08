'use strict';

const db = require('../config/db');
const AppError = require('../utils/AppError');
const { asyncHandler, sendCreated, sendSuccess } = require('../utils/asyncHandler');
const { audit } = require('../utils/audit');
const { lockStore, storeBalance } = require('../utils/registerLedger');
const {
  parseId,
  parsePositiveInt,
  parsePagination,
  validateAmount,
  validateVoidReason,
  parseDateOnly,
} = require('../utils/validators');

// ─── Constants ───────────────────────────────────────────────────────────────

// Per design "Field Validation Rules" and Requirement 2.2/2.5.
const AMOUNT_LIMITS = { min: 0.01, max: 9999999999.99, decimals_allowed: 2 };
const NOTE_MAX_LEN  = 500;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Validate and trim an optional note. Returns a string ≤500 chars or null.
 * Throws AppError('VALIDATION_ERROR', 400) if the value is the wrong shape.
 */
const parseNote = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw AppError.badRequest('"note" must be a string.', 'VALIDATION_ERROR');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > NOTE_MAX_LEN) {
    throw AppError.badRequest(
      `"note" must be at most ${NOTE_MAX_LEN} characters after trimming.`,
      'VALIDATION_ERROR'
    );
  }
  return trimmed;
};

/**
 * Run the shared `validateAmount` helper but remap a VALIDATION_ERROR result
 * to `INVALID_AMOUNT` per Requirements 2.3 and the design's API contract.
 * Anything else (e.g. non-AppError programming bugs) propagates unchanged.
 */
const parseAdvanceAmount = (raw) => {
  try {
    return validateAmount(raw, { ...AMOUNT_LIMITS, fieldName: 'amount' });
  } catch (err) {
    if (err && err.isOperational && err.code === 'VALIDATION_ERROR') {
      throw AppError.badRequest(err.message, 'INVALID_AMOUNT');
    }
    throw err;
  }
};

/**
 * Resolve the cashier's currently open session. Throws 400 NO_OPEN_SESSION
 * when none exists. Cashier-only contexts use this; repayments do NOT.
 */
const requireOpenSession = async (cashierId, client = db) => {
  const { rows } = await client.query(
    `SELECT id FROM cashier_sessions
     WHERE cashier_id = $1 AND status = 'open'
     ORDER BY id DESC LIMIT 1`,
    [cashierId]
  );
  if (!rows[0]) {
    throw AppError.badRequest(
      'You have no open session. Open one before recording an advance.',
      'NO_OPEN_SESSION'
    );
  }
  return rows[0];
};

/**
 * Compute Outstanding_Advance_Balance for a cashier per Requirement 2.7
 * and the design's "Outstanding Advance Balance" SQL.
 *
 * Runs against the supplied client (so callers inside a transaction get a
 * consistent snapshot under their isolation level).
 */
const loadOutstandingBalance = async (cashierId, client = db) => {
  const { rows } = await client.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE direction = 'advance'   AND is_voided = FALSE), 0)
     - COALESCE(SUM(amount) FILTER (WHERE direction = 'repayment' AND is_voided = FALSE), 0)
       AS outstanding_balance
     FROM cashier_advances
     WHERE cashier_id = $1`,
    [cashierId]
  );
  // NUMERIC parser is configured to return float; coerce defensively in case
  // a future caller turns it off.
  return parseFloat(rows[0].outstanding_balance) || 0;
};

/** Format a `cashier_advances` row for API responses. */
const shapeRow = (row) => ({
  id:           row.id,
  cashier_id:   row.cashier_id,
  session_id:   row.session_id,
  direction:    row.direction,
  amount:       parseFloat(row.amount) || 0,
  note:         row.note,
  is_voided:    row.is_voided,
  voided_at:    row.voided_at,
  voided_by:    row.voided_by,
  void_reason:  row.void_reason,
  created_at:   row.created_at,
  created_by:   row.created_by,
});

// ─── POST /api/advances  — cashier records an advance ───────────────────────

const createAdvance = asyncHandler(async (req, res) => {
  if (req.user.role !== 'cashier') {
    throw AppError.forbidden(
      'Only cashiers can record their own advances.',
      'INSUFFICIENT_ROLE'
    );
  }

  const amount = parseAdvanceAmount(req.body.amount);
  const note   = parseNote(req.body.note);

  const result = await db.withTransaction(async (client) => {
    const session = await requireOpenSession(req.user.id, client);

    const { rows } = await client.query(
      `INSERT INTO cashier_advances
         (cashier_id, session_id, direction, amount, note, created_by)
       VALUES ($1, $2, 'advance', $3, $4, $1)
       RETURNING *`,
      [req.user.id, session.id, amount, note]
    );
    return rows[0];
  });

  audit({
    userId:      req.user.id,
    action:      'INSERT',
    table:       'cashier_advances',
    recordId:    result.id,
    newValues:   {
      cashier_id: result.cashier_id,
      session_id: result.session_id,
      direction:  'advance',
      amount,
      note,
    },
    description: 'advance',
    ip:          req.clientIp,
  });

  sendCreated(res, shapeRow(result), 'Advance recorded.');
});

// ─── POST /api/advances/repayment  — admin records a repayment ──────────────

const createRepayment = asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') {
    throw AppError.forbidden(
      'Only admins can record repayments.',
      'INSUFFICIENT_ROLE'
    );
  }

  const cashierId = parsePositiveInt(req.body.cashier_id, 'cashier_id');
  const amount    = parseAdvanceAmount(req.body.amount);
  const note      = parseNote(req.body.note);

  const { row, balance_after } = await db.withTransaction(async (client) => {
    // Look up the cashier — must exist, be a cashier, AND be active.
    // Requirement 2.5 / Design API: 404 CASHIER_NOT_FOUND on missing/inactive.
    const { rows: userRows } = await client.query(
      `SELECT id, role, is_active FROM users WHERE id = $1`,
      [cashierId]
    );
    const user = userRows[0];
    if (!user || user.role !== 'cashier' || user.is_active !== true) {
      throw AppError.notFound('Cashier not found.', 'CASHIER_NOT_FOUND');
    }

    // Compute the current Outstanding_Advance_Balance. The transaction
    // isolates this read from concurrent inserts; in the unlikely case of a
    // race the schema accepts the row and the next read still sees a
    // non-negative balance (advances are bounded by INSUFFICIENT_REGISTER_CASH
    // checks elsewhere; here we just enforce the ceiling at request time).
    const balance = await loadOutstandingBalance(cashierId, client);

    if (amount > balance) {
      throw AppError.badRequest(
        'Repayment exceeds the cashier\'s outstanding balance.',
        'REPAYMENT_EXCEEDS_BALANCE'
      ).withDetails({ current_balance: balance });
    }

    const { rows: insertRows } = await client.query(
      `INSERT INTO cashier_advances
         (cashier_id, session_id, direction, amount, note, created_by)
       VALUES ($1, NULL, 'repayment', $2, $3, $4)
       RETURNING *`,
      [cashierId, amount, note, req.user.id]
    );

    const inserted = insertRows[0];

    // Round to two decimals to keep the response value stable against
    // floating-point drift (NUMERIC math in PG is exact, but JS subtraction
    // is not).
    const balanceAfter = Math.round((balance - amount) * 100) / 100;

    return { row: inserted, balance_after: balanceAfter };
  });

  audit({
    userId:      req.user.id,
    action:      'INSERT',
    table:       'cashier_advances',
    recordId:    row.id,
    newValues:   {
      cashier_id: row.cashier_id,
      session_id: null,
      direction:  'repayment',
      amount,
      note,
    },
    description: 'repayment',
    ip:          req.clientIp,
  });

  sendCreated(res, {
    ...shapeRow(row),
    outstanding_balance: balance_after,
  }, 'Repayment recorded.');
});

// ─── GET /api/advances/me  — cashier's own ledger and balance ────────────────

const getMyAdvances = asyncHandler(async (req, res) => {
  if (req.user.role !== 'cashier') {
    throw AppError.forbidden(
      'Only cashiers can view their own advance ledger.',
      'INSUFFICIENT_ROLE'
    );
  }

  const { limit, offset } = parsePagination(req.query);

  const [{ rows: items }, balance] = await Promise.all([
    db.query(
      `SELECT *
       FROM cashier_advances
       WHERE cashier_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    ),
    loadOutstandingBalance(req.user.id),
  ]);

  sendSuccess(res, {
    outstanding_balance: balance,
    items: items.map(shapeRow),
    limit,
    offset,
  });
});

// ─── GET /api/advances  — admin overview, one row per active cashier ────────

const getAllAdvances = asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') {
    throw AppError.forbidden(
      'Only admins can list every cashier\'s advance balance.',
      'INSUFFICIENT_ROLE'
    );
  }

  // One row per active cashier (Requirement 2.9). LEFT JOIN against the
  // ledger so cashiers with zero balance still appear, then aggregate the
  // outstanding balance and the latest non-voided activity timestamp.
  const { rows } = await db.query(
    `SELECT u.id                                AS cashier_id,
            u.full_name                         AS cashier_name,
            u.store_id                          AS store_id,
            s.name                              AS store_name,
            COALESCE(
              SUM(ca.amount) FILTER (
                WHERE ca.direction = 'advance'   AND ca.is_voided = FALSE
              ), 0
            )
            -
            COALESCE(
              SUM(ca.amount) FILTER (
                WHERE ca.direction = 'repayment' AND ca.is_voided = FALSE
              ), 0
            )                                   AS outstanding_balance,
            MAX(ca.created_at)
              FILTER (WHERE ca.is_voided = FALSE) AS last_activity_at
       FROM users u
       LEFT JOIN stores s           ON s.id = u.store_id
       LEFT JOIN cashier_advances ca ON ca.cashier_id = u.id
      WHERE u.role = 'cashier' AND u.is_active = TRUE
      GROUP BY u.id, u.full_name, u.store_id, s.name
      ORDER BY outstanding_balance DESC, u.full_name ASC`
  );

  sendSuccess(res, rows.map((r) => ({
    cashier_id:          r.cashier_id,
    cashier_name:        r.cashier_name,
    store_id:            r.store_id,
    store_name:          r.store_name,
    outstanding_balance: parseFloat(r.outstanding_balance) || 0,
    last_activity_at:    r.last_activity_at,
  })));
});

// ─── GET /api/advances/cashier/:id  — admin drill-down ──────────────────────

const getCashierAdvances = asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') {
    throw AppError.forbidden(
      'Only admins can drill into another cashier\'s advance ledger.',
      'INSUFFICIENT_ROLE'
    );
  }

  const cashierId = parseId(req.params.id, 'cashier_id');
  const { limit, offset } = parsePagination(req.query);

  const { rows: userRows } = await db.query(
    `SELECT u.id, u.full_name, u.role, u.is_active, u.store_id, s.name AS store_name
       FROM users u
       LEFT JOIN stores s ON s.id = u.store_id
      WHERE u.id = $1`,
    [cashierId]
  );
  const cashier = userRows[0];
  if (!cashier || cashier.role !== 'cashier' || cashier.is_active !== true) {
    throw AppError.notFound('Cashier not found.', 'CASHIER_NOT_FOUND');
  }

  const [{ rows: items }, balance] = await Promise.all([
    db.query(
      `SELECT *
         FROM cashier_advances
        WHERE cashier_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [cashierId, limit, offset]
    ),
    loadOutstandingBalance(cashierId),
  ]);

  sendSuccess(res, {
    cashier: {
      id:         cashier.id,
      full_name:  cashier.full_name,
      store_id:   cashier.store_id,
      store_name: cashier.store_name,
    },
    outstanding_balance: balance,
    items:               items.map(shapeRow),
    limit,
    offset,
  });
});

// ─── POST /api/advances/:id/void  — shared cashier + admin endpoint ─────────

const voidAdvance = asyncHandler(async (req, res) => {
  const advanceId = parseId(req.params.id, 'id');
  // Per design API: the void payload field is `reason`. Tolerate the
  // alternative `void_reason` so admin tools that follow the audit-log
  // column name still work.
  const reason = validateVoidReason(
    req.body.reason !== undefined ? req.body.reason : req.body.void_reason
  );

  const updated = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, cashier_id, session_id, direction, amount, is_voided, created_by
         FROM cashier_advances
        WHERE id = $1
        FOR UPDATE`,
      [advanceId]
    );
    const row = rows[0];
    if (!row) throw AppError.notFound('Advance not found.');

    if (row.is_voided) {
      // Requirement 2.10/2.11/3.12 contract: 409 ALREADY_VOIDED.
      throw AppError.conflict(
        'This advance row is already voided.',
        'ALREADY_VOIDED'
      );
    }

    // Role-based access control (Requirements 2.11, 2.12).
    if (req.user.role === 'cashier') {
      if (row.cashier_id !== req.user.id) {
        throw AppError.forbidden('Not your advance row.', 'FORBIDDEN');
      }

      // Cashiers may only void rows tied to their own currently open
      // session. Repayment rows have session_id = NULL, so the second check
      // already rejects those for cashier callers. Advance rows must
      // additionally match the cashier's open session id. Per Req 2.11 the
      // failure mode here is 403 FORBIDDEN — even a missing open session
      // surfaces as FORBIDDEN, not NO_OPEN_SESSION.
      const { rows: openRows } = await client.query(
        `SELECT id FROM cashier_sessions
          WHERE cashier_id = $1 AND status = 'open'
          ORDER BY id DESC LIMIT 1`,
        [req.user.id]
      );
      const openSessionId = openRows[0]?.id ?? null;
      if (openSessionId === null || row.session_id !== openSessionId) {
        throw AppError.forbidden(
          'Cashiers can only void advances from their currently open session.',
          'FORBIDDEN'
        );
      }
    } else if (req.user.role !== 'admin') {
      throw AppError.forbidden('Insufficient role.', 'INSUFFICIENT_ROLE');
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE cashier_advances
          SET is_voided   = TRUE,
              voided_at   = NOW(),
              voided_by   = $1,
              void_reason = $2
        WHERE id = $3
        RETURNING *`,
      [req.user.id, reason, advanceId]
    );
    return { ...updatedRows[0], _direction: row.direction };
  });

  audit({
    userId:      req.user.id,
    action:      'VOID',
    table:       'cashier_advances',
    recordId:    updated.id,
    oldValues:   { is_voided: false, direction: updated._direction },
    newValues:   {
      is_voided: true,
      direction: updated._direction,
      void_reason: reason,
    },
    description: updated._direction,
    ip:          req.clientIp,
  });

  sendSuccess(res, {
    id:         updated.id,
    is_voided:  updated.is_voided,
    voided_at:  updated.voided_at,
    voided_by:  updated.voided_by,
  }, 200, 'Advance voided.');
});

// ─── Payroll ────────────────────────────────────────────────────────────────
// total salary = base + SIM commission + accessory commission
//                + app-install commission (only when the cashier's checkbox is on)

const APP_COMMISSION_KEY = 'app_install_commission';
const SALARY_LIMITS = { min: 0, max: 9999999.99, decimals_allowed: 2 };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** "YYYY-MM" (default: current month) -> { month, from, to } with `to` exclusive. */
const resolveMonth = (raw) => {
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() + 1;
  if (raw !== undefined && raw !== '') {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(raw));
    if (!match) throw AppError.badRequest('"month" must be in YYYY-MM format.', 'VALIDATION_ERROR');
    y = parseInt(match[1], 10);
    m = parseInt(match[2], 10);
  }
  const pad = (n) => String(n).padStart(2, '0');
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { month: `${y}-${pad(m)}`, from: `${y}-${pad(m)}-01`, to: `${ny}-${pad(nm)}-01` };
};

// Commissions are summed in separate sub-queries (NOT joined together) so rows
// are never multiplied. $1 = first day of month, $2 = first day of next month.
const PAYROLL_SQL = `
  SELECT u.id AS cashier_id, u.full_name AS cashier_name, u.store_id, st.name AS store_name,
         u.app_commission_enabled,
         COALESCE(bs.base_salary, 0)       AS base_salary,
         COALESCE(sim.units, 0)            AS sim_units,
         COALESCE(sim.commission, 0)       AS sim_commission,
         COALESCE(sim.app_installs, 0)     AS app_installs,
         COALESCE(sim.app_commission, 0)   AS app_commission_earned,
         COALESCE(acc.units, 0)            AS accessory_units,
         COALESCE(acc.commission, 0)       AS accessory_commission,
         COALESCE(adv.outstanding, 0)      AS outstanding_advance,
         COALESCE(pay.paid, 0)             AS paid_amount,
         COALESCE(pay.deducted, 0)         AS advance_deducted
    FROM users u
    LEFT JOIN stores st ON st.id = u.store_id
    LEFT JOIN LATERAL (
      SELECT h.base_salary
        FROM cashier_salary_history h
       WHERE h.cashier_id = u.id
         AND h.effective_from <= LEAST($2::date - 1, CURRENT_DATE)
       ORDER BY h.effective_from DESC, h.id DESC
       LIMIT 1
    ) bs ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE ss.is_voided = FALSE) AS units,
             COALESCE(SUM(ss.commission_snapshot) FILTER (WHERE ss.is_voided = FALSE), 0) AS commission,
             COUNT(*) FILTER (WHERE ss.is_voided = FALSE AND ss.my_ooredoo_app_installed) AS app_installs,
             COALESCE(SUM(ss.app_commission_snapshot)
                      FILTER (WHERE ss.is_voided = FALSE AND ss.my_ooredoo_app_installed), 0) AS app_commission
        FROM session_sim_sales ss
        JOIN cashier_sessions cs ON cs.id = ss.session_id
       WHERE cs.cashier_id = u.id AND cs.session_date >= $1::date AND cs.session_date < $2::date
    ) sim ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE sa.is_voided = FALSE) AS units,
             COALESCE(SUM(sa.commission_snapshot) FILTER (WHERE sa.is_voided = FALSE), 0) AS commission
        FROM session_accessory_sales sa
        JOIN cashier_sessions cs ON cs.id = sa.session_id
       WHERE cs.cashier_id = u.id AND cs.session_date >= $1::date AND cs.session_date < $2::date
    ) acc ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(ca.amount) FILTER (WHERE ca.direction = 'advance'   AND ca.is_voided = FALSE), 0)
           - COALESCE(SUM(ca.amount) FILTER (WHERE ca.direction = 'repayment' AND ca.is_voided = FALSE), 0)
             AS outstanding
        FROM cashier_advances ca
       WHERE ca.cashier_id = u.id
    ) adv ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(sp.amount), 0)           AS paid,
             COALESCE(SUM(sp.advance_deducted), 0) AS deducted
        FROM salary_payments sp
       WHERE sp.cashier_id = u.id
         AND sp.month = to_char($1::date, 'YYYY-MM')
         AND sp.is_voided = FALSE
    ) pay ON TRUE
   WHERE u.role = 'cashier' AND u.is_active = TRUE`;

const shapePayroll = (r) => {
  const base        = round2(r.base_salary);
  const simC        = round2(r.sim_commission);
  const accC        = round2(r.accessory_commission);
  const appEarned   = round2(r.app_commission_earned);
  const enabled     = r.app_commission_enabled === true;
  const appCounted  = enabled ? appEarned : 0;
  const total       = round2(base + simC + accC + appCounted);
  const outstanding = round2(r.outstanding_advance);
  const paid        = round2(r.paid_amount);
  const deducted    = round2(r.advance_deducted);
  const remaining   = round2(Math.max(total - paid - deducted, 0));
  const deductible  = round2(Math.min(Math.max(outstanding, 0), remaining));
  return {
    cashier_id:            r.cashier_id,
    cashier_name:          r.cashier_name,
    store_id:              r.store_id,
    store_name:            r.store_name,
    base_salary:           base,
    sim_units:             parseInt(r.sim_units, 10) || 0,
    sim_commission:        simC,
    accessory_units:       parseInt(r.accessory_units, 10) || 0,
    accessory_commission:  accC,
    app_commission_enabled: enabled,
    app_installs:          parseInt(r.app_installs, 10) || 0,
    app_commission_earned: appEarned,   // what the installs are worth
    app_commission:        appCounted,  // what is actually added (0 when checkbox is off)
    total_salary:          total,
    outstanding_advance:   outstanding,
    net_after_advances:    round2(total - outstanding),
    amount_paid:           paid,        // cash already handed out for this month
    advance_deducted:      deducted,    // advance already settled from this month's salary
    remaining_salary:      remaining,   // total − paid − deducted (never below 0)
    advance_deductible:    deductible,  // the part of the advance that can still be deducted now
    suggested_cash:        round2(remaining - deductible), // cash due now if the advance is deducted
  };
};

const readAppCommissionSetting = async (client = db) => {
  const { rows } = await client.query(`SELECT value FROM payroll_settings WHERE key = $1`, [APP_COMMISSION_KEY]);
  return rows[0] ? parseFloat(rows[0].value) || 0 : 0;
};

const shapePayment = (r) => ({
  id:               r.id,
  cashier_id:       r.cashier_id,
  cashier_name:     r.cashier_name,
  month:            r.month,
  amount:           parseFloat(r.amount) || 0,
  advance_deducted: parseFloat(r.advance_deducted) || 0,
  note:             r.note,
  is_voided:        r.is_voided,
  void_reason:      r.void_reason,
  paid_by_name:     r.paid_by_name,
  created_at:       r.created_at,
});

/** Salary payments of one month (all cashiers, or just one). Voided rows are included and flagged. */
const loadPayments = async (month, cashierId = null, client = db) => {
  const params = [month];
  let where = 'sp.month = $1';
  if (cashierId) { params.push(cashierId); where += ' AND sp.cashier_id = $2'; }
  const { rows } = await client.query(
    `SELECT sp.id, sp.cashier_id, u.full_name AS cashier_name, sp.month, sp.amount, sp.advance_deducted,
            sp.note, sp.is_voided, sp.void_reason, sp.created_at, a.full_name AS paid_by_name
       FROM salary_payments sp
       JOIN users u ON u.id = sp.cashier_id
       LEFT JOIN users a ON a.id = sp.created_by
      WHERE ${where}
      ORDER BY sp.created_at DESC, sp.id DESC`,
    params
  );
  return rows.map(shapePayment);
};

// GET /api/advances/salary?month=YYYY-MM  (admin)
const getPayroll = asyncHandler(async (req, res) => {
  const { month, from, to } = resolveMonth(req.query.month);
  const [{ rows }, appInstallCommission, payments] = await Promise.all([
    db.query(`${PAYROLL_SQL} ORDER BY u.full_name ASC`, [from, to]),
    readAppCommissionSetting(),
    loadPayments(month),
  ]);
  sendSuccess(res, {
    month, from, to,
    app_install_commission: appInstallCommission,
    items: rows.map(shapePayroll),
    payments,
  });
});

// GET /api/advances/salary/me?month=YYYY-MM  (cashier)
const getMyPayroll = asyncHandler(async (req, res) => {
  if (req.user.role !== 'cashier') {
    throw AppError.forbidden('Only cashiers can view their own salary.', 'INSUFFICIENT_ROLE');
  }
  const { month, from, to } = resolveMonth(req.query.month);
  const [{ rows }, payments] = await Promise.all([
    db.query(`${PAYROLL_SQL} AND u.id = $3`, [from, to, req.user.id]),
    loadPayments(month, req.user.id),
  ]);
  if (!rows[0]) throw AppError.notFound('Cashier not found.', 'CASHIER_NOT_FOUND');
  sendSuccess(res, { month, ...shapePayroll(rows[0]), payments });
});

// PUT /api/advances/salary/base  (admin) — adds a new base-salary entry
const setBaseSalary = asyncHandler(async (req, res) => {
  const cashierId = parsePositiveInt(req.body.cashier_id, 'cashier_id');
  const baseSalary = validateAmount(req.body.base_salary, { ...SALARY_LIMITS, fieldName: 'base_salary' });
  const effectiveFrom = req.body.effective_from ? parseDateOnly(req.body.effective_from, 'effective_from') : null;

  const { rows: userRows } = await db.query(`SELECT id, role, is_active FROM users WHERE id = $1`, [cashierId]);
  const user = userRows[0];
  if (!user || user.role !== 'cashier' || user.is_active !== true) {
    throw AppError.notFound('Cashier not found.', 'CASHIER_NOT_FOUND');
  }

  const { rows } = await db.query(
    `INSERT INTO cashier_salary_history (cashier_id, base_salary, effective_from, created_by)
     VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4)
     RETURNING id, cashier_id, base_salary, to_char(effective_from, 'YYYY-MM-DD') AS effective_from`,
    [cashierId, baseSalary, effectiveFrom, req.user.id]
  );

  audit({
    userId: req.user.id, action: 'INSERT', table: 'cashier_salary_history', recordId: rows[0].id,
    newValues: { cashier_id: cashierId, base_salary: baseSalary, effective_from: rows[0].effective_from },
    description: 'base_salary', ip: req.clientIp,
  });

  sendCreated(res, { ...rows[0], base_salary: parseFloat(rows[0].base_salary) }, 'Base salary updated.');
});

// PATCH /api/advances/salary/app-commission  (admin) — the per-cashier checkbox
const setAppCommissionEnabled = asyncHandler(async (req, res) => {
  const cashierId = parsePositiveInt(req.body.cashier_id, 'cashier_id');
  if (typeof req.body.enabled !== 'boolean') {
    throw AppError.badRequest('"enabled" must be true or false.', 'VALIDATION_ERROR');
  }
  const { rows } = await db.query(
    `UPDATE users SET app_commission_enabled = $1
      WHERE id = $2 AND role = 'cashier' AND is_active = TRUE
      RETURNING id, app_commission_enabled`,
    [req.body.enabled, cashierId]
  );
  if (!rows[0]) throw AppError.notFound('Cashier not found.', 'CASHIER_NOT_FOUND');

  audit({
    userId: req.user.id, action: 'UPDATE', table: 'users', recordId: cashierId,
    newValues: { app_commission_enabled: req.body.enabled },
    description: 'app_commission_enabled', ip: req.clientIp,
  });

  sendSuccess(res, rows[0], 200, 'Updated.');
});

// GET /api/advances/settings  (admin)
const getPayrollSettings = asyncHandler(async (req, res) => {
  sendSuccess(res, { app_install_commission: await readAppCommissionSetting() });
});

// PUT /api/advances/settings  (admin)
const updatePayrollSettings = asyncHandler(async (req, res) => {
  const amount = validateAmount(req.body.app_install_commission, { ...SALARY_LIMITS, fieldName: 'app_install_commission' });
  await db.query(
    `INSERT INTO payroll_settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
    [APP_COMMISSION_KEY, amount, req.user.id]
  );
  audit({
    userId: req.user.id, action: 'UPDATE', table: 'payroll_settings', recordId: 0,
    newValues: { [APP_COMMISSION_KEY]: amount }, ip: req.clientIp,
  });
  sendSuccess(res, { app_install_commission: amount }, 200, 'Settings saved.');
});

// POST /api/advances/salary/payments  (admin)
// { cashier_id, month: 'YYYY-MM', amount, deduct_advance?: boolean, note? }
// Pays (part of) a cashier's salary OUT of the cashier's store register:
//   • writes a manual 'out' entry in register_ledger (so the register balance goes down),
//   • optionally deducts the cashier's outstanding advance from the salary (a 'repayment' row, no cash moves),
//   • records the payment in salary_payments so the cashier can see it.
const createSalaryPayment = asyncHandler(async (req, res) => {
  const cashierId = parsePositiveInt(req.body.cashier_id, 'cashier_id');
  const { month, from, to } = resolveMonth(req.body.month);
  if (month > resolveMonth().month) {
    throw AppError.badRequest('You cannot pay the salary of a future month.', 'VALIDATION_ERROR');
  }
  const amount = parseAdvanceAmount(req.body.amount);
  const deduct = req.body.deduct_advance === true;
  const note   = parseNote(req.body.note);

  const result = await db.withTransaction(async (client) => {
    const { rows: userRows } = await client.query(
      `SELECT id, full_name, role, is_active, store_id FROM users WHERE id = $1`, [cashierId]
    );
    const cashier = userRows[0];
    if (!cashier || cashier.role !== 'cashier' || cashier.is_active !== true) {
      throw AppError.notFound('Cashier not found.', 'CASHIER_NOT_FOUND');
    }
    if (!cashier.store_id) {
      throw AppError.badRequest('This cashier has no store, so there is no register to pay from.', 'NO_STORE');
    }

    // Same lock the register ledger uses: payments and manual entries of one store never run at the same time.
    await lockStore(client, cashier.store_id);

    const { rows: payRows } = await client.query(`${PAYROLL_SQL} AND u.id = $3`, [from, to, cashierId]);
    const payroll = payRows[0] ? shapePayroll(payRows[0]) : null;
    if (!payroll) throw AppError.notFound('Cashier not found.', 'CASHIER_NOT_FOUND');

    if (payroll.remaining_salary <= 0) {
      throw AppError.badRequest('This salary is already fully paid for this month.', 'NOTHING_DUE');
    }

    const deduction = deduct ? payroll.advance_deductible : 0;
    const maxCash   = round2(payroll.remaining_salary - deduction);
    if (amount > maxCash + 0.001) {
      throw AppError.badRequest(
        'The payment is higher than the salary still due.',
        'PAYMENT_EXCEEDS_DUE'
      ).withDetails({ max_amount: maxCash });
    }

    const balance = await storeBalance(client, cashier.store_id);
    if (amount > balance + 0.001) {
      throw AppError.badRequest(
        `Not enough cash in this register: only ${balance.toFixed(2)} DZD available.`,
        'INSUFFICIENT_REGISTER_CASH'
      ).withDetails({ current_balance: balance });
    }

    const description = `Salary payment — ${cashier.full_name} (${month})`;
    const { rows: ledgerRows } = await client.query(
      `INSERT INTO register_ledger
         (store_id, user_id, source, direction, entry_date, description, total_amount, created_by)
       VALUES ($1, $2, 'manual', 'out', CURRENT_DATE, $3, $4, $2)
       RETURNING id`,
      [cashier.store_id, req.user.id, description, amount]
    );

    let repaymentId = null;
    if (deduction > 0) {
      const { rows: repRows } = await client.query(
        `INSERT INTO cashier_advances (cashier_id, session_id, direction, amount, note, created_by)
         VALUES ($1, NULL, 'repayment', $2, $3, $4)
         RETURNING id`,
        [cashierId, deduction, `Deducted from ${month} salary`, req.user.id]
      );
      repaymentId = repRows[0].id;
    }

    const { rows: spRows } = await client.query(
      `INSERT INTO salary_payments
         (cashier_id, store_id, month, amount, advance_deducted, note, ledger_id, repayment_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [cashierId, cashier.store_id, month, amount, deduction, note, ledgerRows[0].id, repaymentId, req.user.id]
    );

    return {
      id: spRows[0].id, ledger_id: ledgerRows[0].id, repayment_id: repaymentId,
      cashier_id: cashierId, cashier_name: cashier.full_name, store_id: cashier.store_id,
      month, amount, advance_deducted: deduction,
      remaining_salary: round2(payroll.remaining_salary - amount - deduction),
      register_balance_after: round2(balance - amount),
    };
  });

  audit({
    userId: req.user.id, action: 'INSERT', table: 'salary_payments', recordId: result.id,
    newValues: {
      cashier_id: cashierId, month, amount, advance_deducted: result.advance_deducted,
      ledger_id: result.ledger_id, store_id: result.store_id,
    },
    description: 'salary_payment', ip: req.clientIp,
  });

  sendCreated(res, result, 'Salary payment recorded.');
});

// POST /api/advances/salary/payments/:id/void  (admin) { reason }
// Puts the money back in the register and re-opens the deducted advance.
const voidSalaryPayment = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id, 'id');
  const reason = validateVoidReason(req.body.reason !== undefined ? req.body.reason : req.body.void_reason);

  // Lock the store BEFORE the payment row (same order as everywhere else → no deadlocks).
  const { rows: pre } = await db.query(`SELECT store_id FROM salary_payments WHERE id = $1`, [id]);
  if (!pre[0]) throw AppError.notFound('Salary payment not found.', 'PAYMENT_NOT_FOUND');

  const updated = await db.withTransaction(async (client) => {
    await lockStore(client, pre[0].store_id);

    const { rows } = await client.query(`SELECT * FROM salary_payments WHERE id = $1 FOR UPDATE`, [id]);
    const row = rows[0];
    if (!row) throw AppError.notFound('Salary payment not found.', 'PAYMENT_NOT_FOUND');
    if (row.is_voided) throw AppError.conflict('This salary payment is already voided.', 'ALREADY_VOIDED');

    await client.query(
      `UPDATE register_ledger
          SET is_voided = TRUE, voided_at = NOW(), voided_by = $1, void_reason = $2
        WHERE id = $3 AND is_voided = FALSE`,
      [req.user.id, reason, row.ledger_id]
    );
    if (row.repayment_id) {
      await client.query(
        `UPDATE cashier_advances
            SET is_voided = TRUE, voided_at = NOW(), voided_by = $1, void_reason = $2
          WHERE id = $3 AND is_voided = FALSE`,
        [req.user.id, reason, row.repayment_id]
      );
    }
    const { rows: out } = await client.query(
      `UPDATE salary_payments
          SET is_voided = TRUE, voided_at = NOW(), voided_by = $1, void_reason = $2
        WHERE id = $3
        RETURNING id, is_voided, voided_at, voided_by`,
      [req.user.id, reason, id]
    );
    return out[0];
  });

  audit({
    userId: req.user.id, action: 'VOID', table: 'salary_payments', recordId: id,
    oldValues: { is_voided: false }, newValues: { is_voided: true, void_reason: reason },
    description: 'salary_payment', ip: req.clientIp,
  });

  sendSuccess(res, updated, 200, 'Salary payment voided.');
});

module.exports = {
  createSalaryPayment,
  voidSalaryPayment,
  createAdvance,
  createRepayment,
  getMyAdvances,
  getAllAdvances,
  getCashierAdvances,
  voidAdvance,
  getPayroll,
  getMyPayroll,
  setBaseSalary,
  setAppCommissionEnabled,
  getPayrollSettings,
  updatePayrollSettings,
};
