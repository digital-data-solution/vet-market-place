/**
 * review.controller.js
 *
 * Handlers for the review system.
 *
 * POST   /api/v1/reviews                            — create or update own review
 * GET    /api/v1/reviews/:targetType/:targetId       — paginated public review list
 * GET    /api/v1/reviews/eligibility/:targetType/:targetId — eligibility + existing review
 * POST   /api/v1/reviews/:reviewId/respond           — professional/shop owner response
 */

import mongoose                      from 'mongoose';
import Review                        from '../models/Review.js';
import Professional                  from '../models/Professional.js';
import Shop                          from '../models/Shop.js';
import User                          from '../models/User.js';
import logger                        from '../lib/logger.js';
import { hasContactedProfessional }  from '../lib/reviewEligibility.js';
import { logActivity }               from '../lib/activityLogger.js';

const { Types } = mongoose;

// ─── Constants ────────────────────────────────────────────────────────────────

const TARGET_MODEL = {
  professional: Professional,
  shop:         Shop,
};

// The field on the target document that holds the owner's User ObjectId
const OWNER_FIELD = {
  professional: 'userId',
  shop:         'owner',
};

const VALID_TARGET_TYPES = new Set(['professional', 'shop']);

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Recomputes average rating and total review count from all reviews for a
 * target and persists the result directly to the Professional/Shop document.
 * Always reflects the true aggregate — safe to call after any write.
 */
async function recalculateRating(targetType, targetId) {
  const [agg] = await Review.aggregate([
    { $match: { targetType, targetId: new Types.ObjectId(targetId) } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);

  const rating      = agg ? Math.round(agg.avg * 10) / 10 : 0;
  const reviewCount = agg?.count ?? 0;

  await TARGET_MODEL[targetType].findByIdAndUpdate(targetId, { rating, reviewCount });
}

/**
 * Resolves the supabaseId of the owner of a Professional/Shop document.
 * Returns null if the owner cannot be found.
 */
async function resolveOwnerSupabaseId(targetType, targetDoc) {
  const ownerObjectId = targetDoc[OWNER_FIELD[targetType]];
  if (!ownerObjectId) return null;

  const owner = await User.findById(ownerObjectId).select('supabaseId').lean();
  return owner?.supabaseId ?? null;
}

// ─── POST / ───────────────────────────────────────────────────────────────────

/**
 * Create or update the authenticated user's review for a Professional/Shop.
 * Uses upsert so an edit replaces the original review without creating a duplicate.
 * After write, rating/reviewCount on the target document are recalculated.
 */
export const createOrUpdateReview = async (req, res) => {
  try {
    const { targetType, targetId, rating, comment } = req.body;

    // ── Validate input ───────────────────────────────────────────────────────
    if (!VALID_TARGET_TYPES.has(targetType)) {
      return res.status(400).json({
        success: false,
        message: `targetType must be one of: ${[...VALID_TARGET_TYPES].join(', ')}`,
      });
    }
    if (!targetId || !Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ success: false, message: 'Invalid targetId.' });
    }
    const ratingNum = Number(rating);
    if (!rating || isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ success: false, message: 'Rating must be a number between 1 and 5.' });
    }

    // ── Target must exist ────────────────────────────────────────────────────
    const target = await TARGET_MODEL[targetType].findById(targetId).lean();
    if (!target) {
      return res.status(404).json({ success: false, message: 'Listing not found.' });
    }

    // ── Block self-review ────────────────────────────────────────────────────
    const ownerObjectId = target[OWNER_FIELD[targetType]]?.toString();
    if (ownerObjectId === req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You cannot review your own listing.' });
    }

    // ── Eligibility: must have messaged the professional/shop owner ──────────
    const reviewerSupabaseId = req.user.supabaseId;
    if (!reviewerSupabaseId) {
      return res.status(403).json({
        success: false,
        message: 'Your account is missing a Supabase ID. Please re-login and try again.',
      });
    }

    const ownerSupabaseId = await resolveOwnerSupabaseId(targetType, target);
    if (!ownerSupabaseId) {
      return res.status(422).json({
        success: false,
        message: 'Could not verify listing owner. Please try again later.',
      });
    }

    const eligible = await hasContactedProfessional(reviewerSupabaseId, ownerSupabaseId);
    if (!eligible) {
      return res.status(403).json({
        success: false,
        message: 'You can only review a professional or shop you have previously messaged.',
        code:    'ELIGIBILITY_FAILED',
      });
    }

    // ── Upsert review (preserves professionalResponse on edit) ───────────────
    const review = await Review.findOneAndUpdate(
      {
        reviewer:   req.user._id,
        targetType,
        targetId:   new Types.ObjectId(targetId),
      },
      {
        $set: {
          rating:  Math.round(ratingNum * 10) / 10,
          comment: comment?.trim() || null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // ── Recalculate aggregate on the target document ──────────────────────────
    await recalculateRating(targetType, targetId);

    logger.info('Review upserted', {
      reviewId:   review._id,
      targetType,
      targetId,
      reviewerId: req.user._id,
      rating:     ratingNum,
    });

    logActivity(req.user._id, req.user.role, 'review.submitted', {
      targetType,
      targetId,
      rating: ratingNum,
    }, req);

    return res.status(200).json({ success: true, data: review });
  } catch (err) {
    logger.error('createOrUpdateReview error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to save review.' });
  }
};

// ─── GET /:targetType/:targetId ───────────────────────────────────────────────

/**
 * Public paginated list of reviews for a Professional or Shop.
 * Populated with the reviewer's name and profile image.
 * Sorted newest first.
 */
export const listReviews = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 10);

    if (!VALID_TARGET_TYPES.has(targetType)) {
      return res.status(400).json({ success: false, message: 'Invalid targetType.' });
    }
    if (!Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ success: false, message: 'Invalid targetId.' });
    }

    const filter = { targetType, targetId: new Types.ObjectId(targetId) };

    const [reviews, total] = await Promise.all([
      Review.find(filter)
        .populate('reviewer', 'name profileImage')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Review.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data:       reviews,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    logger.error('listReviews error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch reviews.' });
  }
};

// ─── GET /eligibility/:targetType/:targetId ───────────────────────────────────

/**
 * Lightweight check used by the frontend to decide whether to show the
 * "Write a Review" button. Returns eligibility flag + the user's existing
 * review if one exists (so the form can be pre-filled for edits).
 * Requires authentication.
 */
export const checkEligibility = async (req, res) => {
  try {
    const { targetType, targetId } = req.params;

    if (!VALID_TARGET_TYPES.has(targetType)) {
      return res.status(400).json({ success: false, message: 'Invalid targetType.' });
    }
    if (!Types.ObjectId.isValid(targetId)) {
      return res.status(400).json({ success: false, message: 'Invalid targetId.' });
    }

    const reviewerSupabaseId = req.user.supabaseId;
    if (!reviewerSupabaseId) {
      return res.json({ success: true, eligible: false, existingReview: null });
    }

    const target = await TARGET_MODEL[targetType].findById(targetId).lean();
    if (!target) {
      return res.json({ success: true, eligible: false, existingReview: null });
    }

    // Block self-check
    const ownerObjectId = target[OWNER_FIELD[targetType]]?.toString();
    if (ownerObjectId === req.user._id.toString()) {
      return res.json({ success: true, eligible: false, existingReview: null });
    }

    const ownerSupabaseId = await resolveOwnerSupabaseId(targetType, target);
    const eligible = ownerSupabaseId
      ? await hasContactedProfessional(reviewerSupabaseId, ownerSupabaseId)
      : false;

    // Fetch any existing review this user has already left
    const existingReview = eligible
      ? await Review.findOne({
          reviewer:   req.user._id,
          targetType,
          targetId:   new Types.ObjectId(targetId),
        }).lean()
      : null;

    return res.json({ success: true, eligible, existingReview });
  } catch (err) {
    logger.error('checkEligibility error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to check eligibility.' });
  }
};

// ─── POST /:reviewId/respond ──────────────────────────────────────────────────

/**
 * Professional or shop owner adds/updates their response to a review.
 * Ownership is verified by checking that the review's target belongs to req.user.
 */
export const respondToReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { response } = req.body;

    if (!Types.ObjectId.isValid(reviewId)) {
      return res.status(400).json({ success: false, message: 'Invalid reviewId.' });
    }
    if (!response || !response.trim()) {
      return res.status(400).json({ success: false, message: 'Response text is required.' });
    }
    if (response.trim().length > 1000) {
      return res.status(400).json({ success: false, message: 'Response must be 1000 characters or fewer.' });
    }

    const review = await Review.findById(reviewId);
    if (!review) {
      return res.status(404).json({ success: false, message: 'Review not found.' });
    }

    // ── Verify ownership ─────────────────────────────────────────────────────
    const target = await TARGET_MODEL[review.targetType].findById(review.targetId).lean();
    if (!target) {
      return res.status(404).json({ success: false, message: 'Listing not found.' });
    }

    const ownerObjectId = target[OWNER_FIELD[review.targetType]]?.toString();
    if (ownerObjectId !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only the listing owner can respond to reviews.',
      });
    }

    review.professionalResponse   = response.trim();
    review.professionalResponseAt = new Date();
    await review.save();

    logger.info('Review response saved', { reviewId, responderId: req.user._id });

    return res.json({ success: true, data: review });
  } catch (err) {
    logger.error('respondToReview error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to save response.' });
  }
};
