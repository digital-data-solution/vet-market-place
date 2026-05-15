import express from 'express';
import { protect, authorize } from '../middlewares/authMiddleware.js';
import {
  submitVCN,
  listPendingVets,
  reviewVet,
  getVetVerification,
  getMyVerificationStatus,
} from '../api/vetVerification.controller.js';

const router = express.Router();

// ── Vet routes ──────────────────────────────────────────────────────────────

// POST /api/v1/vet-verification/submit
// Vet submits their VCN number + supporting document links
router.post('/submit', protect, authorize('vet'), submitVCN);

// GET /api/v1/vet-verification/status
// FIX #1a: Register before /:id so "status" is not swallowed as a param
router.get('/status', protect, authorize('vet'), getMyVerificationStatus);

// ── Admin routes ─────────────────────────────────────────────────────────────

// GET /api/v1/vet-verification/pending
// FIX #1b: Register before /:id for the same reason
router.get('/pending', protect, authorize('admin'), listPendingVets);

// POST /api/v1/vet-verification/review/:id
router.post('/review/:id', protect, authorize('admin'), reviewVet);

// GET /api/v1/vet-verification/:id
// FIX #1c: Must come LAST — wildcard param would match /status and /pending above
router.get('/:id', protect, authorize('admin'), getVetVerification);

export default router;