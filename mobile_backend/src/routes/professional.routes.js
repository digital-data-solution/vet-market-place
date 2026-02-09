import express from 'express';
import { onboardProfessional, updateProfessional, getProfessional } from '../api/professional.controller.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/onboard', onboardProfessional);

// PATCH /api/v1/professional/:id to update profile
router.patch('/:id', protect, updateProfessional);
// GET /api/v1/professional/:id to get profile
router.get('/:id', protect, getProfessional);

export default router;
