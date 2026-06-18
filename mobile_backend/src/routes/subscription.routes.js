import express from 'express';
import {
  createUserSubscription,
  upgradeUserSubscription,
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
// SHARED MIDDLEWARE — disable HTTP caching for all subscription routes
// Prevents 304 Not Modified responses from serving stale subscription state
// (e.g. showing "pending" after payment has been confirmed as "active")
// ─────────────────────────────────────────────────────────────────────────────
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

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

// Upgrade pet owner plan (no cancel required — keeps access until upgrade payment clears)
router.post('/upgrade', upgradeUserSubscription);

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