import express from 'express';
import {
  createUserSubscription,
  createProfessionalSubscription,
  getUserSubscription,
  cancelSubscription,
  verifyPayment,
  handlePaystackWebhook,
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

// Paystack webhook — MUST receive raw body (Buffer), not parsed JSON.
// Wire this up in app.js BEFORE express.json(), like so:
//
//   app.use(
//     '/api/subscriptions/webhook',
//     express.raw({ type: 'application/json' }),
//     subscriptionRoutes,
//   );
//
// All other subscription routes run under express.json() as normal.
router.post('/webhook', handlePaystackWebhook);

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATED ROUTES
// All routes below require a valid JWT via the protect middleware.
// ─────────────────────────────────────────────────────────────────────────────
router.use(protect);

// Get the calling user's current subscription (works for both user types)
// attachSubscription + checkExpiryWarning enrich the response automatically.
router.get(
  '/me',
  attachSubscription,
  checkExpiryWarning,
  getUserSubscription,
);

// Initiate payment — pet owners
router.post('/user', createUserSubscription);

// Initiate payment — professionals / shop owners
router.post('/professional', createProfessionalSubscription);

// Paystack redirect callback (manual verify fallback — webhook is the primary path)
router.get('/verify', verifyPayment);

// Cancel — soft cancel; access retained until billing period ends
router.delete('/cancel', cancelSubscription);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', authorize('admin'), getSubscriptionStats);

// ─────────────────────────────────────────────────────────────────────────────
// EXAMPLE GATED FEATURE ROUTES
// Swap these out for your real route handlers.
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