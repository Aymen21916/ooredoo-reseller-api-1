'use strict';

const express = require('express');
const reportsController = require('../controllers/reportsController');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// ─── Cashier-or-admin sub-router ─────────────────────────────────────────────
// The date-range report and the cashier ranking are the `/api/reports/*`
// endpoints cashiers may hit. Scope for `/range` is enforced server-side by
// `getDateRangeReport` (cashiers only see their own data per Requirement
// 4.5/4.12), so role-level access just needs to allow both roles through.
// Mounted first so the path matches before the admin-only sub-router gets a
// chance to reject the request.
const rangeRouter = express.Router();
rangeRouter.use(authenticate, authorize('cashier', 'admin'));
rangeRouter.get('/range', reportsController.getDateRangeReport);
rangeRouter.get('/cashiers/ranking', reportsController.getCashierRanking); // ?by=product|sim|storm|app_installation
router.use(rangeRouter);

// ─── Admin-only sub-router ───────────────────────────────────────────────────
// Every other `/api/reports/*` endpoint stays admin-only.
const adminRouter = express.Router();
adminRouter.use(authenticate, authorize('admin'));

// Static paths declared FIRST so they win against the parameterised
// `/:id` and `/:id/export.csv` routes below.
adminRouter.get('/preview',     reportsController.previewDailyReport);
adminRouter.post('/generate',   reportsController.generateDailyReport);
adminRouter.get('/monthly',     reportsController.getMonthlySummary);
adminRouter.get('/top',         reportsController.getTopRollup);
adminRouter.get('/stats',       reportsController.getStatistics);       // sales, cashiers, expenses, advances, profit
adminRouter.get('/audit',       reportsController.getAuditLog);
adminRouter.get('/cashier/:id', reportsController.getCashierHistory);

// Report-id-scoped paths (most specific first)
adminRouter.get('/:id/export.csv', reportsController.exportReportCsv);

adminRouter.get('/',     reportsController.getReports);
adminRouter.get('/:id',  reportsController.getReportById);
router.use(adminRouter);

module.exports = router;