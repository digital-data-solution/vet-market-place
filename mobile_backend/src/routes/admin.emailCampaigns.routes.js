import express from 'express';
import { createEmailCampaign, listEmailCampaigns, previewEmailReach } from '../api/admin.emailCampaigns.controller.js';
import { adminProtect, requireModule, requireModuleRead } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

router.use(adminProtect);

router.get('/preview-count', requireModuleRead('emailcampaigns'), previewEmailReach);
router.get('/',              requireModuleRead('emailcampaigns'), listEmailCampaigns);
router.post('/',             requireModule('emailcampaigns'), createEmailCampaign);

export default router;
