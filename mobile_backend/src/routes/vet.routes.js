import express from 'express';
import { getNearbyProfessionals } from '../api/vet.controller.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

// GET /api/v1/professionals/nearby?lng=3.3792&lat=6.5244&distance=5&type=vet
router.get('/nearby', protect, getNearbyProfessionals);

export default router;