import express from 'express';
import { protect, authorize } from '../middlewares/authMiddleware.js';
import { submitVCN, listPendingVets, reviewVet } from '../api/vetVerification.controller.js';

const router = express.Router();

// Vet submits VCN and documents
router.post('/submit', protect, submitVCN);

// Admin routes
router.get('/pending', protect, authorize('admin'), listPendingVets);
router.post('/review/:id', protect, authorize('admin'), reviewVet);

export default router;
