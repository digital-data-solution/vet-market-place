import express from 'express';
import {
  listPendingProfessionals,
  reviewProfessional,
  getAllProfessionals,
  updateProfessionalByAdmin,
  deleteProfessionalByAdmin,
  getProfessionalStats,
} from '../api/admin.professional.controller.js';
import { adminProtect, requireModule, requireModuleRead } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

// All admin routes require authentication and admin role
router.use(adminProtect);

// Admin routes — all gated to the 'verifications' module.
router.get('/stats', requireModuleRead('verifications'), getProfessionalStats); // Get professional statistics
router.get('/pending', requireModuleRead('verifications'), listPendingProfessionals); // List pending verifications
router.get('/all', requireModuleRead('verifications'), getAllProfessionals); // Get all professionals (including unverified)
router.post('/review/:id', requireModule('verifications'), reviewProfessional); // Approve or reject a professional
router.put('/:id', requireModule('verifications'), updateProfessionalByAdmin); // Update any professional profile
router.delete('/:id', requireModule('verifications'), deleteProfessionalByAdmin); // Delete any professional profile

export default router;