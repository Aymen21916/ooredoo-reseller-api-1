'use strict';

const express = require('express');
const settingsController = require('../controllers/settingsController');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');
const printSettingsController = require('../controllers/printSettingsController');

const router = express.Router();

router.use(authenticate);

// Cashiers need to GET settings to calculate points, but only Admins can UPDATE them
router.get('/loyalty', settingsController.getLoyaltySettings);
router.patch('/loyalty', authorize('admin'), settingsController.updateLoyaltySettings);
router.get('/barcode-print', printSettingsController.getBarcodePrintSettings);
router.put('/barcode-print', authorize('admin'), printSettingsController.updateBarcodePrintSettings);

module.exports = router;