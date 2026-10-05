'use strict';

const express = require('express');
const controller = require('../controllers/registerLedgerController');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// Everything here is admin-only.
router.use(authenticate, authorize('admin'));

router.get('/filters', controller.getFilters);
router.get('/', controller.listLedger);
router.post('/manual', controller.createManualEntry);
router.post('/:id/void', controller.voidEntry);

module.exports = router;