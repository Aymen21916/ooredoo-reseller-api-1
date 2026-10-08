'use strict';

const express = require('express');
const controller = require('../controllers/cardPaymentsController');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// Cashiers record the card payments of their own open session.
router.use(authenticate, authorize('cashier'));

router.post('/', controller.createCardPayment);
router.get('/me', controller.listMyCardPayments);
router.post('/:id/void', controller.voidCardPayment);

module.exports = router;
