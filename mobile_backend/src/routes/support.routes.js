import express from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { sendSupportMessage, getMyThread } from '../api/support.controller.js';

const router = express.Router();

router.post('/',   protect, sendSupportMessage);
router.get('/',    protect, getMyThread);

export default router;
