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
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

// Public routes
router.get('/nearby', getNearbyProfessionals); // Search nearby professionals
router.get('/list', listProfessionals); // List all verified professionals
router.get('/:id', getProfessional); // Get specific professional by ID

// Protected routes (require authentication)
router.use(protect); // All routes below require authentication

router.post('/onboard', onboardProfessional); // Create professional profile
router.get('/me/profile', getMyProfessionalProfile); // Get own professional profile
router.put('/me/profile', updateProfessional); // Update own professional profile
router.delete('/me/profile', deleteProfessional); // Delete own professional profile

export default router;