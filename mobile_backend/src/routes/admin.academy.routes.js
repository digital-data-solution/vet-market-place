import express from 'express';
import { listCourseDrafts, dismissCourseDraft } from '../api/admin.academy.controller.js';
import { adminProtect, requireModule, requireModuleRead } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

router.use(adminProtect);

router.get('/course-drafts',            requireModuleRead('academy'), listCourseDrafts);
router.post('/course-drafts/:id/dismiss', requireModule('academy'), dismissCourseDraft);

export default router;
