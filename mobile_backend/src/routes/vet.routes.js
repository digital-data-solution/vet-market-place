import express from 'express';
import { getNearbyProfessionals, listProfessionals } from '../api/professional.controller.js';
import { protect } from '../middlewares/authMiddleware.js';
import { enforceSubscription } from '../middlewares/subscriptionMiddleware.js';

const router = express.Router();

// GET /api/v1/professionals/nearby?lng=3.3792&lat=6.5244&distance=5&type=vet
router.get('/nearby', protect, enforceSubscription, getNearbyProfessionals);

// GET /api/v1/professionals/list?role=vet&limit=50
router.get('/list', protect, enforceSubscription, listProfessionals);

export default router;