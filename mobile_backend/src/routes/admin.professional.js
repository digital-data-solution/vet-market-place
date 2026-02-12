import express from 'express';
import {
  listPendingProfessionals,
  reviewProfessional,
  getAllProfessionals,
  updateProfessionalByAdmin,
  deleteProfessionalByAdmin,
  getProfessionalStats,
} from '../api/admin.professional.controller.js';
import { protect, authorize } from '../middlewares/authMiddleware.js';

const router = express.Router();

// All admin routes require authentication and admin role
router.use(protect);
router.use(authorize('admin'));

// Admin routes
router.get('/stats', getProfessionalStats); // Get professional statistics
router.get('/pending', listPendingProfessionals); // List pending verifications
router.get('/all', getAllProfessionals); // Get all professionals (including unverified)
router.post('/review/:id', reviewProfessional); // Approve or reject a professional
router.put('/:id', updateProfessionalByAdmin); // Update any professional profile
router.delete('/:id', deleteProfessionalByAdmin); // Delete any professional profile

export default router;