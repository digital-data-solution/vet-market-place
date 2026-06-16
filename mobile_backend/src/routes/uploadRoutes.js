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
import { uploadToCloudinary, deleteFromCloudinary } from '../lib/cloudinaryUpload.js';
import User                                         from '../models/User.js';
import cache                                        from '../lib/cache.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Upload limits per role per plan
// plan keys match user.subscription.plan enum values + 'free' default
// ─────────────────────────────────────────────────────────────────────────────
const MEDIA_LIMITS = {
  vet: {
    free:        3,
    basic:       5,
    starter:     10,
    pro:         30,
  },
  kennel_owner: {
    free:        5,
    basic:       8,
    starter:     15,
    pro:         50,
  },
  shop_owner: {
    free:        5,
    basic:       8,
    starter:     20,
    pro:         75,
  },
  // Service professionals — portfolio-light roles
  groomer: {
    free:        4,
    basic:       8,
    starter:     15,
    pro:         40,
  },
  trainer: {
    free:        4,
    basic:       8,
    starter:     15,
    pro:         40,
  },
  pet_sitter: {
    free:        4,
    basic:       8,
    starter:     15,
    pro:         40,
  },
  // Transport / logistics
  pet_transport: {
    free:        5,
    basic:       10,
    starter:     20,
    pro:         50,
  },
  // Business-heavy roles
  cremation_service: {
    free:        5,
    basic:       10,
    starter:     20,
    pro:         50,
  },
  agro_vet_supplier: {
    free:        5,
    basic:       10,
    starter:     25,
    pro:         75,
  },
  insurance_provider: {
    free:        3,
    basic:       6,
    starter:     12,
    pro:         30,
  },
  pet_pharmacy: {
    free:        4,
    basic:       8,
    starter:     15,
    pro:         40,
  },
  rescue_center: {
    free:        5,
    basic:       10,
    starter:     20,
    pro:         50,
  },
  pet_hotel: {
    free:        5,
    basic:       8,
    starter:     15,
    pro:         50,
  },
  farm: {
    free:        5,
    basic:       10,
    starter:     25,
    pro:         75,
  },
  pet_owner: {
    free:         2,
    user_premium: 8,
  },
};

// Legacy pet_owner plan names can end up on professional accounts (subscription created
// before plan renaming). Normalize them to the equivalent professional tier so limits
// resolve correctly instead of falling back to 'free'.
const PROFESSIONAL_ROLES = new Set([
  'vet', 'kennel_owner', 'shop_owner',
  'groomer', 'trainer', 'pet_sitter',
  'pet_transport', 'cremation_service', 'agro_vet_supplier', 'insurance_provider',
  'pet_pharmacy', 'rescue_center', 'pet_hotel', 'farm',
]);
function normalizePlan(role, plan) {
  if (PROFESSIONAL_ROLES.has(role) && (plan === 'user_monthly' || plan === 'user_premium')) {
    return 'basic';
  }
  if (role === 'pet_owner' && plan === 'user_monthly') {
    return 'user_premium';
  }
  return plan;
}

function getLimitsForUser(role, plan) {
  const normalized  = normalizePlan(role, plan);
  const roleLimits  = MEDIA_LIMITS[role] ?? MEDIA_LIMITS.pet_owner;
  const maxImages   = roleLimits[normalized] ?? roleLimits.free;
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
      currentPlan: normalizePlan(role, plan),
      maxImages,
      usedImages:  (user.mediaImages ?? []).filter(m => m.url).length,
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

    // Build a user-unique publicId server-side — never trust the client value.
    // Using the same publicId per user means re-uploads overwrite in-place (no orphaned assets)
    // and each user's asset is isolated at profiles/profile-<userId>.
    const publicId = `profile-${req.user._id}`;

    const uploadResult = await uploadToCloudinary(req.file.buffer, {
      folder: 'profiles',
      publicId,
    });

    // Persist on user document so profile screens can read it without a separate call
    await User.findByIdAndUpdate(req.user._id, {
      profileImage:     uploadResult.url,
      profileImagePath: uploadResult.publicId,
    });

    // Invalidate professional profile cache so the next fetch returns the new profileImage
    await cache.del(`professional:${req.user._id}`);

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

    // Invalidate professional profile cache so next fetch returns fresh mediaImages
    await cache.del(`professional:${req.user._id}`);

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
    // Accept imageUrl from query string (preferred — some proxies strip DELETE bodies)
    // or fall back to req.body for backwards compatibility.
    const imageUrl = (req.query.imageUrl || req.body?.imageUrl || '').trim();

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

    // Invalidate professional profile cache so next fetch returns updated mediaImages
    await cache.del(`professional:${req.user._id}`);

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