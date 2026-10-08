'use strict';

const db        = require('../config/db');
const AppError  = require('../utils/AppError');
const { asyncHandler, sendSuccess, sendCreated } = require('../utils/asyncHandler');
const {
  parseId, parsePagination, parseDateOnly,
  validateAmount, validateVoidReason,
} = require('../utils/validators');
const { lockStore, getRegisterCash } = require('../utils/registerLedger');

// ─── Constants ──────────────────────────────────────────────────────────────

/** Closed enum for `register_expenses.category`. */
const EXPENSE_CATEGORIES = ['utility', 'inventory', 'other'];

/** Monetary bounds for a register expense (per design's Field Validation table). */
const EXPENSE_AMOUNT_MIN = 0.01;
const EXPENSE_AMOUNT_MAX = 9_999_999.99;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Insert an `audit_logs` row using the supplied transactional client so the
 * audit entry shares the same SQL transaction as the register-expense and
 * `ledger writes (Requirement 3.15).
 *
 * The shape mirrors the fire-and-forget `utils/audit.js` helper so callers
 * do not need to know which variant is in use.
 */
const auditWithin = (client, params) => client.query(
  `INSERT INTO audit_logs
     (user_id, action, table_name, record_id,
      old_values, new_values, description, ip_address)
   VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::inet)`,
  [
    params.userId,
    params.action,
    params.table       || null,
    params.recordId    || null,
    params.oldValues   ? JSON.stringify(params.oldValues) : null,
    params.newValues   ? JSON.stringify(params.newValues) : null,
    params.description || null,
    params.ip          || null,
  ]
);

/**
 * Trim and length-check the description field. Returns the trimmed string.
 * Throws `VALIDATION_ERROR` (400) when the rule is violated.
 */
const validateDescription = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw AppError.badRequest('"description" is required.', 'VALIDATION_ERROR');
  }
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 500) {
    throw AppError.badRequest(
      '"description" must be 1..500 characters after trimming.',
      'VALIDATION_ERROR'
    );
  }
  return trimmed;
};

/** Validate the closed `category` enum. Throws on mismatch. */
const validateCategory = (raw) => {
  if (typeof raw !== 'string' || !EXPENSE_CATEGORIES.includes(raw)) {
    throw AppError.badRequest(
      `"category" must be one of: ${EXPENSE_CATEGORIES.join(', ')}.`,
      'VALIDATION_ERROR'
    );
  }
  return raw;
};

/**
 * Format a Date as YYYY-MM-DD using the server's local clock so we match
 * PostgreSQL's `CURRENT_DATE` (which resolves in the connection timezone —
 * the API connection runs in the server's local TZ).
 */
const todayLocal = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/**
 * Resolve the cashier's currently open session (if any) along with the
 * cashier's `users.store_id`. Throws `NO_OPEN_SESSION` (400) when the
 * cashier has no open session.
 */
const resolveCashierContext = async (userId, client) => {
  const { rows } = await client.query(
    `SELECT u.store_id, cs.id AS session_id
       FROM users u
       LEFT JOIN cashier_sessions cs
         ON cs.cashier_id = u.id AND cs.status = 'open'
      WHERE u.id = $1`,
    [userId]
  );
  const row = rows[0];
  if (!row || !row.session_id) {
    throw AppError.badRequest(
      'You have no open session. Open one before recording an expense.',
      'NO_OPEN_SESSION'
    );
  }
  if (!row.store_id) {
    // A cashier without a store_id violates the schema's
    // `cashier_requires_store` constraint, so this should never happen — but
    // surface it as a 400 rather than a 500 if it ever does.
    throw AppError.badRequest('Cashier is not bound to a store.', 'VALIDATION_ERROR');
  }
  return { storeId: row.store_id, sessionId: row.session_id };
};

/**
 * Look up `cashier_sessions.id` for the cashier's currently open session,
 * returning null when none is open. Used by the void-access check (Req 3.13)
 * where the absence of an open session simply means the cashier cannot
 * void session-scoped rows; it does not on its own block the request.
 */
const findOpenSessionId = async (cashierId, client) => {
  const { rows } = await client.query(
    `SELECT id FROM cashier_sessions
      WHERE cashier_id = $1 AND status = 'open'
      LIMIT 1`,
    [cashierId]
  );
  return rows[0]?.id ?? null;
};

// ─── POST /api/finances/expenses  — cashier OR admin ────────────────────────
//
//   Body (cashier):  { amount, description, category }
//   Body (admin):    { amount, description, category, expense_date?, store_id }
//
//   Cashier path:
//     - store_id   ← users.store_id of the authenticated cashier
//     - session_id ← cashier's currently open session (else NO_OPEN_SESSION)
//     - expense_date defaults to CURRENT_DATE; if supplied it must equal it
//       (BACKDATE_FORBIDDEN otherwise — Req 3.4).
//
//   Admin path:
//     - store_id is required (must reference an active store)
//     - session_id is NULL
//     - expense_date defaults to CURRENT_DATE; must not be in the future
//       (FUTURE_DATE otherwise — Req 3.6).

const createExpense = asyncHandler(async (req, res) => {
  const role  = req.user.role;
  const today = todayLocal();

  const amount      = validateAmount(req.body.amount, {
    min: EXPENSE_AMOUNT_MIN,
    max: EXPENSE_AMOUNT_MAX,
    decimals_allowed: 2,
    fieldName: 'amount',
  });
  const description = validateDescription(req.body.description);
  const category    = validateCategory(req.body.category);

  // Resolve role-specific context (store_id, session_id, expense_date).
  const result = await db.withTransaction(async (client) => {
    let storeId;
    let sessionId;
    let expenseDate;

    if (role === 'cashier') {
      ({ storeId, sessionId } = await resolveCashierContext(req.user.id, client));

      if (req.body.expense_date !== undefined && req.body.expense_date !== null) {
        const supplied = parseDateOnly(req.body.expense_date, 'expense_date');
        if (supplied !== today) {
          throw AppError.badRequest(
            'Cashiers cannot backdate register expenses.',
            'BACKDATE_FORBIDDEN'
          );
        }
        expenseDate = supplied;
      } else {
        expenseDate = today;
      }
    } else if (role === 'admin') {
      if (req.body.store_id === undefined || req.body.store_id === null) {
        throw AppError.badRequest('"store_id" is required.', 'VALIDATION_ERROR');
      }
      storeId   = parseId(req.body.store_id, 'store_id');
      sessionId = null;

      // Verify the store exists and is active.
      const { rows: storeRows } = await client.query(
        `SELECT id FROM stores WHERE id = $1 AND is_active = TRUE`,
        [storeId]
      );
      if (!storeRows[0]) throw AppError.notFound('Store not found.');

      if (req.body.expense_date !== undefined && req.body.expense_date !== null) {
        const supplied = parseDateOnly(req.body.expense_date, 'expense_date');
        if (supplied > today) {
          throw AppError.badRequest(
            'expense_date cannot be in the future.',
            'FUTURE_DATE'
          );
        }
        expenseDate = supplied;
      } else {
        expenseDate = today;
      }
    } else {
      throw AppError.forbidden('Only cashiers and admins can record expenses.', 'FORBIDDEN');
    }

    // Serialise with every other money movement of this store, then verify funds
    // against the REGISTER LEDGER (not the legacy store_register_state table).
    //   cashier → ledger balance + what his open session has sold so far
    //   admin   → ledger balance
    await lockStore(client, storeId);
    const cash = await getRegisterCash(client, storeId, sessionId);

    if (cash.available + 0.001 < amount) {
      throw AppError.badRequest(
        'The register does not have enough cash to cover this expense.',
        'INSUFFICIENT_REGISTER_CASH'
      ).withDetails({ current_balance: cash.available });
    }

    // Insert the expense row.
    const { rows: expRows } = await client.query(
      `INSERT INTO register_expenses
         (store_id, session_id, amount, expense_date, description, category, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, store_id, session_id, amount, expense_date,
                 description, category, is_voided, created_at, created_by`,
      [storeId, sessionId, amount, expenseDate, description, category, req.user.id]
    );
    const expense = expRows[0];

    // Cashier expenses are deducted automatically when the session closes
    // (register_ledger.expenses_amount). Admin expenses have no session, so they
    // take the money out of the register right now with a linked "out" entry.
    if (role === 'admin') {
      await client.query(
        `INSERT INTO register_ledger
           (store_id, user_id, source, direction, entry_date, description,
            total_amount, created_by, expense_id)
         VALUES ($1, $2, 'manual', 'out', $3, $4, $5, $2, $6)`,
        [storeId, req.user.id, expenseDate, `Expense #${expense.id}: ${description}`.slice(0, 500), amount, expense.id]
      );
    }

    await auditWithin(client, {
      userId:    req.user.id,
      action:    'INSERT',
      table:     'register_expenses',
      recordId:  expense.id,
      newValues: {
        store_id:     storeId,
        session_id:   sessionId,
        amount,
        expense_date: expenseDate,
        description,
        category,
      },
      ip:        req.clientIp,
    });

    return {
      ...expense,
      amount: parseFloat(expense.amount),
      register_balance_after: Number((cash.available - amount).toFixed(2)),
    };
  });

  sendCreated(res, result, 'Register expense recorded.');
});

// ─── GET /api/finances/expenses/register-cash ───────────────────────────────
//   cashier: figures for his store + open session (store_id is taken from his account)
//   admin  : ?store_id=<id> → ledger balance of that store
//   Used by the "Record expense" modal to show how much cash is in the register.

const getRegisterCashInfo = asyncHandler(async (req, res) => {
  let storeId;
  let sessionId = null;

  if (req.user.role === 'cashier') {
    ({ storeId, sessionId } = await resolveCashierContext(req.user.id, db));
  } else if (req.user.role === 'admin') {
    storeId = parseId(req.query.store_id, 'store_id');
  } else {
    throw AppError.forbidden('Only cashiers and admins can read the register cash.', 'FORBIDDEN');
  }

  sendSuccess(res, await getRegisterCash(db, storeId, sessionId));
});

// ─── GET /api/finances/expenses/me  — cashier, current session ──────────────

const listMyExpenses = asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query);

  const sessionId = await findOpenSessionId(req.user.id, db);
  if (sessionId === null) {
    // No open session → nothing to show. Mirrors the existing Cashier_UI
    // behaviour where session-scoped panels render empty until a session
    // is opened.
    return sendSuccess(res, []);
  }

  const { rows } = await db.query(
    `SELECT id, store_id, session_id, amount, expense_date, description,
            category, is_voided, void_reason, voided_at, voided_by,
            created_at, created_by
       FROM register_expenses
      WHERE session_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [sessionId, limit, offset]
  );

  sendSuccess(res, rows.map((r) => ({ ...r, amount: parseFloat(r.amount) })));
});

// ─── GET /api/finances/expenses  — admin, all stores, with filters ──────────
//
//   Query: store_id?, category?, from?, to?, voided? (true|false|all),
//          limit, offset
//   Order: expense_date DESC, created_at DESC

const listAllExpenses = asyncHandler(async (req, res) => {
  const { limit, offset } = parsePagination(req.query);

  const params = [];
  const conditions = [];

  if (req.query.store_id) {
    params.push(parseId(req.query.store_id, 'store_id'));
    conditions.push(`re.store_id = $${params.length}`);
  }

  if (req.query.category) {
    if (!EXPENSE_CATEGORIES.includes(req.query.category)) {
      throw AppError.badRequest(
        `"category" must be one of: ${EXPENSE_CATEGORIES.join(', ')}.`,
        'VALIDATION_ERROR'
      );
    }
    params.push(req.query.category);
    conditions.push(`re.category = $${params.length}`);
  }

  if (req.query.from) {
    params.push(parseDateOnly(req.query.from, 'from'));
    conditions.push(`re.expense_date >= $${params.length}`);
  }

  if (req.query.to) {
    params.push(parseDateOnly(req.query.to, 'to'));
    conditions.push(`re.expense_date <= $${params.length}`);
  }

  // The old automatic "daily cash collection" rows are replaced by the Register Ledger.
  conditions.push(`re.description NOT LIKE 'Automatic Daily Cash Collection%'`);

  // `voided` filter: 'true' | 'false' | 'all'. Default excludes voided rows.
  const voidedRaw = req.query.voided !== undefined ? String(req.query.voided) : 'false';
  if (voidedRaw === 'true') {
    conditions.push(`re.is_voided = TRUE`);
  } else if (voidedRaw === 'all') {
    // no filter
  } else if (voidedRaw === 'false') {
    conditions.push(`re.is_voided = FALSE`);
  } else {
    throw AppError.badRequest(
      '"voided" must be one of: true, false, all.',
      'VALIDATION_ERROR'
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);
  params.push(offset);

  const { rows } = await db.query(
    `SELECT re.id, re.store_id, s.name AS store_name,
            re.session_id, cs.cashier_id, u.full_name AS cashier_name,
            re.amount, re.expense_date, re.description, re.category,
            re.is_voided, re.void_reason, re.voided_at, re.voided_by,
            re.created_at, re.created_by
       FROM register_expenses re
       JOIN stores s             ON s.id  = re.store_id
       LEFT JOIN cashier_sessions cs ON cs.id = re.session_id
       LEFT JOIN users u         ON u.id  = COALESCE(cs.cashier_id, re.created_by)
       ${where}
      ORDER BY re.expense_date DESC, re.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  sendSuccess(res, rows.map((r) => ({ ...r, amount: parseFloat(r.amount) })));
});

// ─── POST /api/finances/expenses/:id/void  — cashier OR admin ───────────────
//
//   Cashier: must be the row's `created_by` AND the row's `session_id` must
//            equal the cashier's currently open session id.
//   Admin:   any non-voided row.
//
//   Atomically (within one transaction):
//     1. Lock the expense's store.
//     2. Soft-void the `register_expenses` row.
//     3. Give the money back to the register ledger (void the linked entry / add a refund entry).
//     4. Audit-log both updates.

const voidExpense = asyncHandler(async (req, res) => {
  const expenseId = parseId(req.params.id, 'id');
  const reason    = validateVoidReason(req.body.reason ?? req.body.void_reason);
  const role      = req.user.role;

  const result = await db.withTransaction(async (client) => {
    // 1. Load and lock the expense row.
    const { rows: expRows } = await client.query(
      `SELECT id, store_id, session_id, amount, description, category,
              is_voided, created_by
         FROM register_expenses
        WHERE id = $1
        FOR UPDATE`,
      [expenseId]
    );
    const expense = expRows[0];
    if (!expense) throw AppError.notFound('Register expense not found.');

    if (expense.is_voided) {
      throw AppError.conflict('Register expense is already voided.', 'ALREADY_VOIDED');
    }

    // 2. Role-based access (Req 3.13/3.14).
    if (role === 'cashier') {
      if (expense.created_by !== req.user.id) {
        throw AppError.forbidden('You can only void your own expenses.', 'FORBIDDEN');
      }
      const openSessionId = await findOpenSessionId(req.user.id, client);
      if (openSessionId === null || expense.session_id !== openSessionId) {
        throw AppError.forbidden(
          'You can only void expenses recorded in your current open session.',
          'FORBIDDEN'
        );
      }
    } else if (role !== 'admin') {
      throw AppError.forbidden('Only cashiers and admins can void expenses.', 'FORBIDDEN');
    }

    // 3. Serialise with the other money movements of the store.
    await lockStore(client, expense.store_id);

    // 4. Mark the expense voided.
    const { rows: voidRows } = await client.query(
      `UPDATE register_expenses
          SET is_voided   = TRUE,
              voided_at   = NOW(),
              voided_by   = $1,
              void_reason = $2
        WHERE id = $3
        RETURNING id, is_voided, voided_at, voided_by, void_reason`,
      [req.user.id, reason, expenseId]
    );
    const voided = voidRows[0];
    const amount = parseFloat(expense.amount);

    // 5. Give the money back to the register ledger.
    //    a) admin expense → void its linked "out" entry
    //    b) session expense whose session is already closed (its ledger row already
    //       had the expense deducted) → add a linked "in" refund entry
    //    c) session expense of a still-open session → nothing to do, the live total updates itself
    const { rows: outRows } = await client.query(
      `UPDATE register_ledger
          SET is_voided = TRUE, voided_at = NOW(), voided_by = $1, void_reason = $2
        WHERE expense_id = $3 AND direction = 'out' AND is_voided = FALSE
        RETURNING id`,
      [req.user.id, `Expense #${expense.id} voided: ${reason}`.slice(0, 500), expense.id]
    );

    if (outRows.length === 0 && expense.session_id) {
      const { rows: sessRows } = await client.query(
        `SELECT 1 FROM register_ledger
          WHERE session_id = $1 AND source = 'session' AND is_voided = FALSE`,
        [expense.session_id]
      );
      if (sessRows[0]) {
        await client.query(
          `INSERT INTO register_ledger
             (store_id, user_id, source, direction, entry_date, description,
              total_amount, created_by, expense_id)
           VALUES ($1, $2, 'manual', 'in', CURRENT_DATE, $3, $4, $2, $5)`,
          [expense.store_id, req.user.id, `Refund of voided expense #${expense.id}`, amount, expense.id]
        );
      }
    }

    // 6. Audit log — inside the same transaction.
    await auditWithin(client, {
      userId:    req.user.id,
      action:    'VOID',
      table:     'register_expenses',
      recordId:  expense.id,
      oldValues: { is_voided: false },
      newValues: {
        is_voided:   true,
        void_reason: reason,
        store_id:    expense.store_id,
        amount,
      },
      description: `Voided register expense #${expense.id}`,
      ip:          req.clientIp,
    });

    return {
      id:          voided.id,
      is_voided:   voided.is_voided,
      voided_at:   voided.voided_at,
      voided_by:   voided.voided_by,
      void_reason: voided.void_reason,
    };
  });

  sendSuccess(res, result, 200, 'Register expense voided.');
});

module.exports = {
  createExpense,
  listMyExpenses,
  listAllExpenses,
  voidExpense,
  getRegisterCashInfo,
};