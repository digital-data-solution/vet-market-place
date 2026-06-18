import express from 'express';
import {
  onboardProfessional,
  updateProfessional,
  getMyProfessionalProfile,
  getMyStats,
  getProfessional,
  listProfessionals,
  getNearbyProfessionals,
  deleteProfessional,
  regeocodeAll,
} from '../api/professional.controller.js';

import {
  submitVCN,
  listPendingVets,
  reviewVet,
  getVetVerification,
  getMyVerificationStatus,
} from '../api/vetVerification.controller.js';

import { protect, authorize }                         from '../middlewares/authMiddleware.js';
import { enforceSubscription, attachSubscription }   from '../middlewares/subscriptionMiddleware.js';
import { requireProfessionalOwner }                  from '../middlewares/ownershipMiddleware.js';

const router = express.Router();

// ─── Static routes first ──────────────────────────────────────────────────────
router.post('/onboard', protect, onboardProfessional);                            // creates ownership
router.get('/me',       protect, getMyProfessionalProfile);
router.get('/me/stats', protect, getMyStats);
router.put('/profile',  protect, requireProfessionalOwner, updateProfessional);   // must own profile
router.delete('/profile', protect, requireProfessionalOwner, deleteProfessional); // must own profile

router.get('/list',   protect, attachSubscription,   listProfessionals);
router.get('/nearby', protect, enforceSubscription, getNearbyProfessionals);

// ─── Admin utilities ──────────────────────────────────────────────────────────
router.post('/admin/regeocode', protect, authorize('admin'), regeocodeAll);

// ─── Vet verification ─────────────────────────────────────────────────────────
router.post('/vet-verification/submit',    protect, authorize('vet'), submitVCN);
router.get('/vet-verification/status',     protect, authorize('vet'), getMyVerificationStatus);
router.get('/vet-verification/pending',    protect, authorize('admin'), listPendingVets);
router.post('/vet-verification/review/:id', protect, authorize('admin'), reviewVet);
router.get('/vet-verification/:id',        protect, authorize('admin'), getVetVerification);

// ─── Wildcard last ────────────────────────────────────────────────────────────
router.get('/:id', protect, attachSubscription, getProfessional);

export default router;