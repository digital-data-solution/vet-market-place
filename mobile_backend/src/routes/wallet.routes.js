import express from 'express';
import {
  getWallet,
  getTransactions,
  getBookings,
  fundWallet,
  payProvider,
  releaseEscrow,
  refundEscrow,
  getBanks,
  requestWithdrawal,
} from '../api/wallet.controller.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

// Never serve stale wallet balances
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

router.use(protect);

router.get('/',             getWallet);
router.get('/transactions', getTransactions);
router.get('/bookings',     getBookings);
router.get('/banks',        getBanks);

router.post('/fund',            fundWallet);
router.post('/pay',             payProvider);
router.post('/withdraw',        requestWithdrawal);
router.post('/bookings/:id/release', releaseEscrow);
router.post('/bookings/:id/refund',  refundEscrow);

export default router;
