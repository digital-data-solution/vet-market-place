import express from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { checkUpsell, dismissUpsell, getMarketplaceStats } from '../api/upsell.controller.js';

const router = express.Router();

// GET  /api/v1/upsell/stats — public, no auth — listing counts for marketplace ticker
router.get('/stats', getMarketplaceStats);

// GET  /api/v1/upsell/check?trigger=search|image_limit
router.get('/check',    protect, checkUpsell);

// POST /api/v1/upsell/dismiss
router.post('/dismiss', protect, dismissUpsell);

export default router;
