import express from 'express';
import {
  getJobBoardStats,
  listJobReports,
  adminListJobPostings,
  adminRemoveJobPosting,
  dismissJobReport,
} from '../api/admin.jobBoard.controller.js';
import { adminProtect, requireModule, requireModuleRead } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

router.use(adminProtect);

router.get('/stats',                requireModuleRead('jobs'), getJobBoardStats);
router.get('/reports',              requireModuleRead('jobs'), listJobReports);
router.get('/postings',             requireModuleRead('jobs'), adminListJobPostings);
router.post('/postings/:id/remove', requireModule('jobs'), adminRemoveJobPosting);
router.post('/reports/:id/dismiss', requireModule('jobs'), dismissJobReport);

export default router;
