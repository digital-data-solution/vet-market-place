import express from 'express';
import { protect, authorize } from '../middlewares/authMiddleware.js';
import { enforceSubscription } from '../middlewares/subscriptionMiddleware.js';
import {
  onboardKennel,
  listKennels,
  getNearbyKennels,
  getKennel,
  getMyKennelProfile,
  updateKennel,
  deleteKennel,
} from '../api/kennel.controller.js';

const router = express.Router();

// Public routes — no auth needed to browse kennels
router.get('/list', enforceSubscription, listKennels);
router.get('/nearby', enforceSubscription, getNearbyKennels);

// Private — kennel owner routes
// Static paths BEFORE /:id wildcard
router.get('/me', protect, getMyKennelProfile);
router.post('/onboard', protect, onboardKennel);
router.put('/profile', protect, authorize('kennel_owner'), updateKennel);
router.delete('/profile', protect, authorize('kennel_owner'), deleteKennel);

// Wildcard last
router.get('/:id', getKennel);

export default router;