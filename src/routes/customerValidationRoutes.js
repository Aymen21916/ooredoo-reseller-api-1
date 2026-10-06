'use strict';

const express = require('express');
const controller = require('../controllers/customerValidationController');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

router.use(authenticate);

// Both roles: the header notification / badge
router.get('/alerts', controller.getAlerts);

// Cashier: send the correct information for one of their customers marked "not valid"
router.post('/corrections', authorize('cashier'), controller.createCorrection);

// Admin: review everything
router.get('/', authorize('admin'), controller.listForReview);
router.post('/corrections/:id/resolve', authorize('admin'), controller.resolveCorrection);
router.put('/:customerId', authorize('admin'), controller.setStatus);

module.exports = router;