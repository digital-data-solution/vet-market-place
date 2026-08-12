import express from 'express';
import {
  getBusinessPricing,
  getBusinessStatus,
  createBusinessPayment,
  createSeatPayment,
  listProducts,
  createProduct,
  getProduct,
  updateProduct,
  deleteProduct,
  restockProduct,
  adjustProduct,
  listProductMovements,
  listExpiring,
  writeOffBatch,
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
  staffLogin,
  staffMe,
} from '../api/business.controller.js';
import businessAuth from '../middlewares/businessAuth.js';

const router = express.Router();

// Public — safe unauthenticated
router.get('/pricing', getBusinessPricing);
router.post('/staff/login', staffLogin); // individual staff sign-in → scoped token

// Everything below requires owner (Supabase) OR staff (scoped) auth
router.use(businessAuth);

router.get('/status', getBusinessStatus);
router.post('/pay',        createBusinessPayment);
router.post('/seats/pay',  createSeatPayment);

// Inventory
router.get('/products',               listProducts);
router.post('/products',              createProduct);
router.get('/products/:id',           getProduct);
router.put('/products/:id',           updateProduct);
router.delete('/products/:id',        deleteProduct);
router.post('/products/:id/restock',  restockProduct);
router.post('/products/:id/adjust',   adjustProduct);
router.get('/products/:id/movements', listProductMovements);

// Batches / expiry (FEFO)
router.get('/batches/expiring',            listExpiring);
router.post('/batches/:batchId/write-off', writeOffBatch);

// Audit log
router.get('/movements', listMovements);

// Point of sale
router.post('/sales',        createSale);
router.get('/sales',         listSales);
router.get('/sales/summary', getSalesSummary);
router.get('/sales/:id',     getSale);

// Customers
router.get('/customers', listCustomers);

// Staff / sales reps
router.get('/staff',             listStaff);
router.post('/staff',            createStaff);
router.get('/staff/me',          staffMe);
router.post('/staff/verify-pin', verifyStaffPin);
router.put('/staff/:id',         updateStaff);
router.delete('/staff/:id',      deleteStaff);

export default router;
