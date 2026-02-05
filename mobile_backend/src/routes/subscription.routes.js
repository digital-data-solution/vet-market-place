import express from 'express';
import { createSubscription, getUserSubscription, activateSubscription } from '../api/subscription.controller.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

// POST /api/subscription/create
router.post('/create', protect, createSubscription);

// GET /api/subscription/me
router.get('/me', protect, getUserSubscription);

// POST /api/subscription/activate (for webhook)
router.post('/activate', activateSubscription);

export default router;