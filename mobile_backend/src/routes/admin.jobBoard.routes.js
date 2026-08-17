import express from 'express';
import {
  getJobBoardStats,
  listJobReports,
  adminListJobPostings,
  adminRemoveJobPosting,
  dismissJobReport,
} from '../api/admin.jobBoard.controller.js';
import { adminProtect } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

router.use(adminProtect);

router.get('/stats',                getJobBoardStats);
router.get('/reports',              listJobReports);
router.get('/postings',             adminListJobPostings);
router.post('/postings/:id/remove', adminRemoveJobPosting);
router.post('/reports/:id/dismiss', dismissJobReport);

export default router;
