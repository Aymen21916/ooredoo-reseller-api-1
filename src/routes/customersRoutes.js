'use strict';

const express = require('express');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const customersController = require('../controllers/customersController');
const { authenticate } = require('../middleware/authenticate');
const { authorize } = require('../middleware/authorize');

const router = express.Router();

// All authenticated users (admin + cashier) need access for the sale flow.
router.use(authenticate);

// 1. STATIC ROUTES (Must come first!)
router.get('/lookup',  customersController.lookupByPhone);
router.get('/',        customersController.listCustomers);
router.post('/',       customersController.createCustomer);
router.post('/bulk-upload', authorize('admin'), upload.single('file'), customersController.bulkUpload);
router.get('/pop-reminders', customersController.getPopReminders);

// 2. DYNAMIC ID ROUTES (Must come after static routes!)
router.get('/:id',     customersController.getCustomer);
router.patch('/:id',   authorize('admin'), customersController.updateCustomer);
router.delete('/:id',  authorize('admin'), customersController.deleteCustomer);
router.get('/:id/purchases', customersController.getCustomerPurchases);
router.get('/:id/loyalty-ledger', customersController.getCustomerLoyaltyLedger);
router.post('/:id/adjust-points', authorize('admin'), customersController.adjustCustomerPoints);

module.exports = router;