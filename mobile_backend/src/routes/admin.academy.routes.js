import express from 'express';
import { listCourseDrafts, dismissCourseDraft } from '../api/admin.academy.controller.js';
import { adminProtect } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

router.use(adminProtect);

router.get('/course-drafts',            listCourseDrafts);
router.post('/course-drafts/:id/dismiss', dismissCourseDraft);

export default router;
