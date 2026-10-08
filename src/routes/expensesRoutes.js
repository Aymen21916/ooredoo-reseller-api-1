'use strict';

const express = require('express');
const expensesController = require('../controllers/expensesController');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// ─── Protected Routes ────────────────────────────────────────────────────────
// All register-expense endpoints require an authenticated user. Note: we
// intentionally do NOT apply a blanket `authorize('admin')` here (unlike the
// existing `financesRoutes`), because cashiers must reach `POST /`,
// `GET /me`, and `POST /:id/void`. Per-route role restrictions follow the
// authorization matrix in the design document.
router.use(authenticate);

// ─── Admin-only endpoints ────────────────────────────────────────────────────
// Declared before the parameterised `:id/void` route so the bare `/` GET
// resolves to the admin list handler.
router.get('/', authorize('admin'), expensesController.listAllExpenses);

// ─── Register cash (cashier: own store + open session / admin: ?store_id=) ───
router.get('/register-cash', authorize('cashier', 'admin'), expensesController.getRegisterCashInfo);

// ─── Cashier-only endpoint ───────────────────────────────────────────────────
router.get('/me', authorize('cashier'), expensesController.listMyExpenses);

// ─── Cashier + admin endpoints (handlers branch on role internally) ──────────
router.post('/', authorize('cashier', 'admin'), expensesController.createExpense);
router.post('/:id/void', authorize('cashier', 'admin'), expensesController.voidExpense);

module.exports = router;