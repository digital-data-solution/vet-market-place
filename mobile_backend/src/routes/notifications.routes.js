import express from 'express';
import { trackOpen } from '../api/notifications.controller.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/track-open', protect, trackOpen);

export default router;
