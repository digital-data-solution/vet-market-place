import express from 'express';
import { protect }                                       from '../middlewares/authMiddleware.js';
import { enforceSubscription, attachSubscription }       from '../middlewares/subscriptionMiddleware.js';
import { requireKennelOwner }  from '../middlewares/ownershipMiddleware.js';
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

// ─── Public browse routes ─────────────────────────────────────────────────────
router.get('/list',   protect, attachSubscription,   listKennels);
router.get('/nearby', protect, enforceSubscription,  getNearbyKennels);

// ─── Owner routes ─────────────────────────────────────────────────────────────
router.get('/me',      protect, getMyKennelProfile);
router.post('/onboard', protect, onboardKennel);                        // creates ownership
router.put('/profile',  protect, requireKennelOwner, updateKennel);     // must own kennel
router.delete('/profile', protect, requireKennelOwner, deleteKennel);   // must own kennel

// ─── Wildcard last ────────────────────────────────────────────────────────────
router.get('/:id', protect, attachSubscription, getKennel);

export default router;