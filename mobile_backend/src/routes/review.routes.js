import { Router } from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
  createOrUpdateReview,
  listReviews,
  checkEligibility,
  respondToReview,
} from '../api/review.controller.js';

const router = Router();

// Public
router.get('/:targetType/:targetId', listReviews);

// Authenticated
router.use(protect);

router.post('/',                              createOrUpdateReview);
router.get('/eligibility/:targetType/:targetId', checkEligibility);
router.post('/:reviewId/respond',             respondToReview);

export default router;
