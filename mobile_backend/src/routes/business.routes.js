import express from 'express';
import {
  getBusinessPricing,
  getBusinessStatus,
  createBusinessPayment,
  listProducts,
  createProduct,
  getProduct,
  updateProduct,
  deleteProduct,
  restockProduct,
  adjustProduct,
  listProductMovements,
  listMovements,
  createSale,
  listSales,
  getSale,
  getSalesSummary,
  listCustomers,
  listStaff,
  createStaff,
  updateStaff,
  deleteStaff,
  verifyStaffPin,
} from '../api/business.controller.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/pricing', getBusinessPricing); // public — safe to show unauthenticated

router.use(protect);

router.get('/status', getBusinessStatus);
router.post('/pay',   createBusinessPayment);

// Inventory
router.get('/products',              listProducts);
router.post('/products',             createProduct);
router.get('/products/:id',          getProduct);
router.put('/products/:id',          updateProduct);
router.delete('/products/:id',       deleteProduct);
router.post('/products/:id/restock', restockProduct);
router.post('/products/:id/adjust',  adjustProduct);
router.get('/products/:id/movements', listProductMovements);

// Audit log (all products)
router.get('/movements', listMovements);

// Point of sale
router.post('/sales',        createSale);
router.get('/sales',         listSales);
router.get('/sales/summary', getSalesSummary);
router.get('/sales/:id',     getSale);

// Customers (light CRM)
router.get('/customers', listCustomers);

// Staff / sales reps
router.get('/staff',            listStaff);
router.post('/staff',           createStaff);
router.post('/staff/verify-pin', verifyStaffPin);
router.put('/staff/:id',        updateStaff);
router.delete('/staff/:id',     deleteStaff);

export default router;
