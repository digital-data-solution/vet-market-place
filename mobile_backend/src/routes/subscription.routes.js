
import express from 'express';
import { createSubscription, getUserSubscription, handlePaystackWebhook } from '../api/subscription.controller.js';
import { protect } from '../middlewares/authMiddleware.js';
import { premiumOnly } from '../middlewares/premiumMiddleware.js';

const router = express.Router();

// POST /api/subscription/create
router.post('/create', protect, createSubscription);

// GET /api/subscription/me
router.get('/me', protect, getUserSubscription);

// Example: Protect a premium-only endpoint
router.get('/premium-feature', protect, premiumOnly, (req, res) => {
	res.json({ message: 'You have access to premium features!' });
});

// POST /api/subscription/activate (for Paystack webhook)
// Use raw body parser to verify Paystack signature
router.post('/activate', express.raw({ type: 'application/json' }), handlePaystackWebhook);

export default router;