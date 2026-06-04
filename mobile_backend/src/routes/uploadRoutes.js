/**
 * upload.routes.js
 *
 * POST   /api/upload              — single profile image (ProfileImageUploader)
 * POST   /api/upload/media        — single media image per call (MediaUploader loops this)
 * DELETE /api/upload/delete       — delete one image (ownership-checked)
 * GET    /api/upload/limits       — real plan limits + current usage for the authed user
 *
 * All routes require a valid Supabase JWT (protect middleware sets req.user).
 *
 * Fixes applied vs previous version:
 *  - user.subscription?.plan   instead of user.subscriptionPlan (field doesn't exist)
 *  - mediaImages push/pull     now matches { url, publicId } sub-document schema
 *  - profileImage / profileImagePath persisted on POST /api/upload
 *  - ownership check on DELETE uses mediaImages sub-document array
 *  - req.user._id used consistently (Mongoose document from authMiddleware)
 */

import express from 'express';
import multer  from 'multer';

import { protect }                                  from '../middlewares/authMiddleware.js';
import { uploadToCloudinary, deleteFromCloudinary } from '../utils/cloudinaryHelper.js';
import User                                         from '../models/User.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Upload limits per role per plan
// plan keys match user.subscription.plan enum values + 'free' default
// ─────────────────────────────────────────────────────────────────────────────
const MEDIA_LIMITS = {
  vet: {
    free:         3,
    user_monthly: 10,
    basic:        30,
  },
  kennel_owner: {
    free:         5,
    user_monthly: 15,
    basic:        50,
  },
  shop_owner: {
    free:         5,
    user_monthly: 20,
    basic:        75,
  },
  pet_owner: {
    free:         2,
    user_monthly: 5,
    basic:        10,
  },
};

function getLimitsForUser(role, plan) {
  const roleLimits = MEDIA_LIMITS[role] ?? MEDIA_LIMITS.pet_owner;
  const maxImages  = roleLimits[plan]   ?? roleLimits.free;
  return { roleLimits, maxImages };
}

// ─────────────────────────────────────────────────────────────────────────────
// Multer — memory storage, 5 MB cap, images only
// ─────────────────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed.'));
  },
});

/**
 * singleImage(fieldName)
 * Wraps multer.single() and converts MulterError into a clean JSON response
 * so every route doesn't repeat the same boilerplate.
 */
function singleImage(fieldName = 'image') {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        const msg =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'File is too large. Maximum size is 5 MB.'
            : err.message || 'File upload error.';
        return res.status(400).json({ success: false, message: msg });
      }

      return res.status(400).json({
        success: false,
        message: err.message || 'File upload error.',
      });
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/upload/limits
// Returns the plan limits table + current plan + images used.
// MediaUploader fetches this on mount instead of using hardcoded values.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/limits', protect, async (req, res) => {
  try {
    const user = await User
      .findById(req.user._id)
      .select('role subscription mediaImages');

    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    // subscription.plan is null by default — treat null as 'free'
    const plan = user.subscription?.plan || 'free';
    const role = user.role               || 'pet_owner';

    const { roleLimits, maxImages } = getLimitsForUser(role, plan);

    return res.status(200).json({
      success:     true,
      currentPlan: plan,
      maxImages,
      usedImages:  user.mediaImages?.length ?? 0,
      // Full limits table so the frontend can render the plan comparison footer
      limits:      roleLimits,
    });
  } catch (error) {
    console.error('Limits error:', error);
    return res.status(500).json({ success: false, message: 'Failed to get upload limits.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload
// Single profile image — ProfileImageUploader.
// Accepts optional publicId body field for deterministic Cloudinary overwrite.
// Persists profileImage + profileImagePath on the user document.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', protect, singleImage('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided.' });
    }

    // Frontend sends publicId = `profile-${userId}` for deterministic overwrite
    const publicId = req.body.publicId || undefined;

    const uploadResult = await uploadToCloudinary(req.file.buffer, {
      folder: 'profiles',
      publicId,
    });

    // Persist on user document so profile screens can read it without a separate call
    await User.findByIdAndUpdate(req.user._id, {
      profileImage:     uploadResult.url,
      profileImagePath: uploadResult.publicId,
    });

    return res.status(200).json({
      success:  true,
      url:      uploadResult.url,
      publicId: uploadResult.publicId,
      message:  'Profile image uploaded successfully.',
    });
  } catch (error) {
    console.error('Profile upload error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload profile image.',
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload/media
// Single media image — MediaUploader calls this once per selected image.
// Enforces plan limit before uploading.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/media', protect, singleImage('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided.' });
    }

    // ── Plan limit enforcement ────────────────────────────────────────────────
    const user = await User
      .findById(req.user._id)
      .select('role subscription mediaImages');

    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const plan          = user.subscription?.plan || 'free';
    const role          = user.role               || 'pet_owner';
    const { maxImages } = getLimitsForUser(role, plan);
    const currentCount  = user.mediaImages?.length ?? 0;

    if (currentCount >= maxImages) {
      return res.status(402).json({
        success:      false,
        limitReached: true,
        currentPlan:  plan,
        maxImages,
        message: `Upload limit reached. Your ${plan} plan allows ${maxImages} images. Upgrade to upload more.`,
      });
    }

    // ── Cloudinary upload ─────────────────────────────────────────────────────
    const folder       = req.body.folder || role;
    const uploadResult = await uploadToCloudinary(req.file.buffer, { folder });

    // ── Persist sub-document on user ──────────────────────────────────────────
    await User.findByIdAndUpdate(req.user._id, {
      $push: {
        mediaImages: {
          url:      uploadResult.url,
          publicId: uploadResult.publicId,
        },
      },
    });

    return res.status(200).json({
      success:  true,
      url:      uploadResult.url,
      publicId: uploadResult.publicId,
      message:  'Image uploaded successfully.',
    });
  } catch (error) {
    console.error('Media upload error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload image.',
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/upload/delete
// Deletes from Cloudinary + removes sub-document from user.mediaImages.
// Ownership check: imageUrl must exist in the requesting user's array.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/delete', protect, async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ success: false, message: 'imageUrl is required.' });
    }

    // ── Ownership check ───────────────────────────────────────────────────────
    const user = await User.findById(req.user._id).select('mediaImages');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const owned = user.mediaImages?.some((m) => m.url === imageUrl);
    if (!owned) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to delete this image.',
      });
    }

    // ── Cloudinary delete ─────────────────────────────────────────────────────
    const deleted = await deleteFromCloudinary(imageUrl);
    if (!deleted) {
      // Not found in Cloudinary — still clean up the DB reference
      console.warn('Image not found in Cloudinary, removing DB reference:', imageUrl);
    }

    // ── Remove sub-document from user ─────────────────────────────────────────
    await User.findByIdAndUpdate(req.user._id, {
      $pull: { mediaImages: { url: imageUrl } },
    });

    return res.status(200).json({ success: true, message: 'Image deleted successfully.' });
  } catch (error) {
    console.error('Delete error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete image.',
    });
  }
});

export default router;