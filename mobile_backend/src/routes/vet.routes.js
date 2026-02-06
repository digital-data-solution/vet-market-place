import express from 'express';
import { getNearbyProfessionals, searchProfessionals } from '../api/vet.controller.js';
import { protect, authorize } from '../middlewares/authMiddleware.js';

const router = express.Router();

// GET /api/v1/professionals/nearby?lng=3.3792&lat=6.5244&distance=5&type=vet
router.get('/nearby', protect, getNearbyProfessionals);

// GET /api/v1/professionals/search?q=smith&lng=&lat=&distance=
// Vet-to-vet search: allow only vets and admins
router.get('/search', protect, authorize('vet', 'admin'), searchProfessionals);

export default router;