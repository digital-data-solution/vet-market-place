import express from 'express';
import {
  createUserSubscription,
  createProfessionalSubscription,
  getUserSubscription,
  cancelSubscription,
  verifyPayment,
  handlePaystackWebhook,
  getSubscriptionStats,
  getPricing
} from '../api/subscription.controller.js';
import { 
  enforceSubscription, 
  premiumOnly, 
  enterpriseOnly,
  attachSubscription 
} from '../middlewares/subscriptionMiddleware.js';
import { protect, authorize } from '../middlewares/authMiddleware.js';

const router = express.Router();

// Public routes
router.get('/pricing', getPricing);

// Webhook (must be BEFORE express.json middleware - use express.raw)
// In your main app.js, add: app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }), subscriptionRoutes);
router.post('/webhook', handlePaystackWebhook);

// Protected routes (require authentication)
router.use(protect); // All routes below require auth

// Get current user's subscription
router.get('/me', getUserSubscription);

// Create subscription - routes based on user type
router.post('/user', createUserSubscription); // For pet owners
router.post('/professional', createProfessionalSubscription); // For professionals/shops

// Verify payment after Paystack redirect
router.get('/verify', verifyPayment);

// Cancel subscription
router.delete('/cancel', cancelSubscription);

// Admin only - statistics
router.get('/stats', authorize('admin'), getSubscriptionStats);

// Example protected routes showing middleware usage
router.get('/features/basic', enforceSubscription, (req, res) => {
  res.json({ 
    success: true, 
    message: 'Access granted to basic feature',
    subscription: req.subscription
  });
});

router.get('/features/premium', premiumOnly, (req, res) => {
  res.json({ 
    success: true, 
    message: 'Access granted to premium feature' 
  });
});

router.get('/features/enterprise', enterpriseOnly, (req, res) => {
  res.json({ 
    success: true, 
    message: 'Access granted to enterprise feature' 
  });
});

export default router;