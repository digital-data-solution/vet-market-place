import express from 'express';
import {
  getJobBoardMeta,
  browseJobPostings,
  getJobPosting,
  myJobPostings,
  createJobPosting,
  updateJobPosting,
  markFilled,
  renewJobPosting,
  deleteJobPosting,
  reportJobPosting,
  createJobBoostPayment,
} from '../api/jobBoard.controller.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

// ─── Public (no auth) — same posture as Xpress Market: browse without login ───
router.get('/meta', getJobBoardMeta);
router.get('/', browseJobPostings);

// ─── Authenticated ──────────────────────────────────────────────────────────
// NOTE: /mine must be registered before /:id so it isn't captured as an id.
router.get('/mine', protect, myJobPostings);

router.post('/', protect, createJobPosting);
router.put('/:id', protect, updateJobPosting);
router.post('/:id/filled', protect, markFilled);
router.post('/:id/renew', protect, renewJobPosting);
router.delete('/:id', protect, deleteJobPosting);
router.post('/:id/report', protect, reportJobPosting);
router.post('/:id/boost', protect, createJobBoostPayment);

// Public single-posting view — LAST so the specific routes above win.
router.get('/:id', getJobPosting);

export default router;
