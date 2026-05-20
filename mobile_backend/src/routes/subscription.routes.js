import express from 'express';
import {
  createUserSubscription,
  createProfessionalSubscription,
  getUserSubscription,
  cancelSubscription,
  cancelPendingSubscription,
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

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Returns plan pricing in NGN — safe to call unauthenticated
router.get('/pricing', getPricing);

// NOTE: Webhook is intentionally NOT here.
// It is mounted directly in app.js with express.raw() before express.json():
//
//   import { handlePaystackWebhook } from './api/subscription.controller.js';
//   app.post(
//     '/api/subscriptions/webhook',
//     express.raw({ type: 'application/json' }),
//     handlePaystackWebhook,
//   );

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATED ROUTES
// ─────────────────────────────────────────────────────────────────────────────
router.use(protect);

// Get the calling user's current subscription
router.get('/me', attachSubscription, checkExpiryWarning, getUserSubscription);

// Initiate payment — pet owners
router.post('/user', createUserSubscription);

// Initiate payment — professionals / shop owners
router.post('/professional', createProfessionalSubscription);

// Paystack redirect callback (manual verify fallback — webhook is primary)
router.get('/verify', verifyPayment);

// Called by the app when user cancels/abandons the payment WebView.
// Clears any pending subscription record so the UI resets to the Subscribe button.
router.post('/cancel-pending', cancelPendingSubscription);

// Cancel active subscription — soft cancel; access retained until billing period ends
router.delete('/cancel', cancelSubscription);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', authorize('admin'), getSubscriptionStats);

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLE GATED FEATURE ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Any subscriber (pet owner or professional) can access
router.get('/features/basic', enforceSubscription, (req, res) => {
  res.json({ success: true, message: 'Access granted to basic feature.' });
});

// Professional / shop subscribers only
router.get('/features/professional', professionalOnly, (req, res) => {
  res.json({ success: true, message: 'Access granted to professional feature.' });
});

export default router;