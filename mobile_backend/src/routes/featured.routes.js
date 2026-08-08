import express from 'express';
import {
  getFeaturedPricing,
  getMyFeaturedStatus,
  createFeaturedPayment,
} from '../api/featured.controller.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

// Never serve stale boost state (mirrors subscription.routes.js)
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Public — boost package pricing
router.get('/pricing', getFeaturedPricing);

// Authenticated — current boost status + start a boost payment
router.use(protect);
router.get('/me', getMyFeaturedStatus);
router.post('/pay', createFeaturedPayment);

export default router;
