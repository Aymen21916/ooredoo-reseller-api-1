'use strict';

const express = require('express');
const financesController = require('../controllers/financesController');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// All finance routes require an authenticated admin.
router.use(authenticate, authorize('admin'));

// ─── Global Pool & Ooredoo Integrations ──────────────────────────────────────
router.get('/pool', financesController.getPool);
router.post('/pool/sync', financesController.syncPoolWithOoredoo);
router.post('/pool/convert/ussd', financesController.autoConvertPoints); // Trigger *582#
router.put('/pool', financesController.updatePool); // Manual Recharges/Rewards

// ─── Daily Reconciliation ───────────────────────────────────────────────────
router.get('/reconciliation/today', financesController.getDailyReconciliation);
router.get('/manual-ledger', financesController.getManualLedger);

// ─── Store Registers ────────────────────────────────────────────────────────
router.get('/registers', financesController.getRegisters);
router.put('/registers/:id', financesController.updateRegister);

module.exports = router;