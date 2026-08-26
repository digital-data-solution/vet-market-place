import express from 'express';
import { createEmailCampaign, listEmailCampaigns, previewEmailReach } from '../api/admin.emailCampaigns.controller.js';
import { adminProtect } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

router.use(adminProtect);

router.get('/preview-count', previewEmailReach);
router.get('/',              listEmailCampaigns);
router.post('/',             createEmailCampaign);

export default router;
