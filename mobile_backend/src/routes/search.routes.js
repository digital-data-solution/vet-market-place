import express from 'express';
import { getUnifiedNearby } from '../api/search.controller.js';
import { protect } from '../middlewares/authMiddleware.js';
import { enforceSubscription } from '../middlewares/subscriptionMiddleware.js';

const router = express.Router();

// Same paywall as the existing per-type /nearby endpoints (professional,
// shop, kennel) — GPS nearby search is a paid feature (see PLAN_PRICING in
// subscription.controller.js). This endpoint just combines them into one
// distance-sorted call instead of three.
router.get('/nearby', protect, enforceSubscription, getUnifiedNearby);

export default router;
