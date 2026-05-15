import express from 'express';
import {
  createUserSubscription,
  createProfessionalSubscription,
  getUserSubscription,
  cancelSubscription,
  verifyPayment,
  getSubscriptionStats,
  getPricing,
} from '../api/subscription.controller.js';
import {
  enforceSubscription,
  professionalOnly,
  attachSubscription,
  checkExpiryWarning,
} from '../middlewares/subscriptionMiddleware.js';
import { protect, authorize } from '../middlewares/authMiddleware.js';

const router = express.Router();

// Public
router.get('/pricing', getPricing);

// Authenticated
router.use(protect);
router.get('/me', attachSubscription, checkExpiryWarning, getUserSubscription);
router.post('/user', createUserSubscription);
router.post('/professional', createProfessionalSubscription);
router.get('/verify', verifyPayment);
router.delete('/cancel', cancelSubscription);

// Admin
router.get('/stats', authorize('admin'), getSubscriptionStats);

// Gated features
router.get('/features/basic', enforceSubscription, (req, res) => {
  res.json({ success: true, message: 'Access granted to basic feature.' });
});
router.get('/features/professional', professionalOnly, (req, res) => {
  res.json({ success: true, message: 'Access granted to professional feature.' });
});

export default router;
