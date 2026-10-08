'use strict';

const express = require('express');
const advancesController = require('../controllers/advancesController');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// ─── Protected Routes ────────────────────────────────────────────────────────
// All advance endpoints require an authenticated user. Per-route role
// restrictions follow the authorization matrix in the design document.
router.use(authenticate);

// ─── Admin-only endpoints ────────────────────────────────────────────────────
// Declared before the cashier+admin endpoints so that `/repayment`,
// `/cashier/:id`, and the bare `/` GET resolve to their admin handlers
// instead of being captured by `POST /:id/void`.
router.post('/repayment', authorize('admin'), advancesController.createRepayment);
router.get('/', authorize('admin'), advancesController.getAllAdvances);
router.get('/cashier/:id', authorize('admin'), advancesController.getCashierAdvances);
router.get('/salary', authorize('admin'), advancesController.getPayroll);
router.post('/salary/payments', authorize('admin'), advancesController.createSalaryPayment);
router.post('/salary/payments/:id/void', authorize('admin'), advancesController.voidSalaryPayment);
router.put('/salary/base', authorize('admin'), advancesController.setBaseSalary);
router.patch('/salary/app-commission', authorize('admin'), advancesController.setAppCommissionEnabled);
router.get('/settings', authorize('admin'), advancesController.getPayrollSettings);
router.put('/settings', authorize('admin'), advancesController.updatePayrollSettings);

// ─── Cashier + admin endpoints (handlers branch on role internally) ──────────
router.post('/', authorize('cashier', 'admin'), advancesController.createAdvance);
router.get('/me', authorize('cashier', 'admin'), advancesController.getMyAdvances);
router.get('/salary/me', authorize('cashier'), advancesController.getMyPayroll);
router.post('/:id/void', authorize('cashier', 'admin'), advancesController.voidAdvance);


module.exports = router;
