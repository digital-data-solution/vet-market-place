import express from 'express';
import {
  onboardProfessional,
  updateProfessional,
  getMyProfessionalProfile,
  getProfessional,
  listProfessionals,
  getNearbyProfessionals,
  deleteProfessional,
} from '../api/professional.controller.js';

import {
  submitVCN,
  listPendingVets,
  reviewVet,
  getVetVerification,
  getMyVerificationStatus,
} from '../api/vetVerification.controller.js';

import { protect, authorize } from '../middlewares/authMiddleware.js';
import { enforceSubscription } from '../middlewares/subscriptionMiddleware.js';

const router = express.Router();

// Professional profile routes
router.post('/onboard', protect, onboardProfessional);
router.get('/me', protect, getMyProfessionalProfile);
router.put('/profile', protect, updateProfessional);
router.delete('/profile', protect, deleteProfessional);

// Search & discovery — static paths BEFORE /:id wildcard
router.get('/list', enforceSubscription, listProfessionals);
router.get('/nearby', enforceSubscription, getNearbyProfessionals);
router.get('/:id', enforceSubscription, getProfessional);

// VCN verification — static paths BEFORE /:id wildcard
router.post('/vet-verification/submit', protect, authorize('vet'), submitVCN);
router.get('/vet-verification/status', protect, authorize('vet'), getMyVerificationStatus);
router.get('/vet-verification/pending', protect, authorize('admin'), listPendingVets);
router.post('/vet-verification/review/:id', protect, authorize('admin'), reviewVet);
router.get('/vet-verification/:id', protect, authorize('admin'), getVetVerification);

export default router;