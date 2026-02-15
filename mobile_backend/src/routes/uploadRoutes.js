import { protect as authenticate } from '../middlewares/authMiddleware.js';
import express from 'express';
import multer from 'multer';
import { uploadToCloudinary, deleteFromCloudinary } from '../utils/cloudinaryHelper.js';

const router = express.Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Only allow images
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

/**
 * POST /api/upload/media
 * Upload multiple images to Cloudinary (for vets/kennels/shops)
 * Protected route - requires authentication
 */
router.post('/media', authenticate, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided',
      });
    }

    const userId = req.user.id;
    const folder = req.body.folder || 'general'; // vet, kennel, shop, or general

    // Upload to Cloudinary
    const cloudinaryUrl = await uploadToCloudinary(req.file.buffer, folder);

    // Optionally: Save reference in database
    // await db.query('INSERT INTO media (user_id, url, type) VALUES ($1, $2, $3)', 
    //   [userId, cloudinaryUrl, folder]);

    res.status(200).json({
      success: true,
      url: cloudinaryUrl,
      message: 'Image uploaded successfully',
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload image',
    });
  }
});

/**
 * DELETE /api/upload/delete
 * Delete an image from Cloudinary
 * Protected route - requires authentication
 */
router.delete('/delete', authenticate, async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        message: 'Image URL is required',
      });
    }

    // Extract public_id from Cloudinary URL
    // Example URL: https://res.cloudinary.com/demo/image/upload/v1234567890/vet/image_name.jpg
    const urlParts = imageUrl.split('/');
    const uploadIndex = urlParts.findIndex((part) => part === 'upload');
    
    if (uploadIndex === -1) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Cloudinary URL',
      });
    }

    // Get public_id (includes folder path)
    const publicIdWithExt = urlParts.slice(uploadIndex + 2).join('/');
    const publicId = publicIdWithExt.replace(/\.[^/.]+$/, ''); // Remove extension

    // Delete from Cloudinary
    await deleteFromCloudinary(publicId);

    // Optionally: Remove reference from database
    // await db.query('DELETE FROM media WHERE url = $1 AND user_id = $2', 
    //   [imageUrl, req.user.id]);

    res.status(200).json({
      success: true,
      message: 'Image deleted successfully',
    });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete image',
    });
  }
});

/**
 * POST /api/upload
 * Upload single profile image (used by ProfileImageUploader)
 * Protected route - requires authentication
 */
router.post('/', authenticate, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided',
      });
    }

    const userId = req.user.id;

    // Upload to Cloudinary in 'profiles' folder
    const cloudinaryUrl = await uploadToCloudinary(req.file.buffer, 'profiles');

    res.status(200).json({
      success: true,
      url: cloudinaryUrl,
      message: 'Profile image uploaded successfully',
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload profile image',
    });
  }
});

/**
 * GET /api/upload/limits
 * Get upload limits based on user's subscription plan
 * Protected route - requires authentication
 */
router.get('/limits', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const userType = req.user.role; // 'vet', 'kennel_owner', 'shop_owner'

    // Get user's subscription plan from database
    // This is a simplified example - adjust based on your DB schema
    // const subscription = await db.query(
    //   'SELECT plan FROM subscriptions WHERE user_id = $1 AND is_active = true',
    //   [userId]
    // );

    // For demo purposes, return limits
    const MEDIA_LIMITS = {
      vet: { free: 3, basic: 10, premium: 30, enterprise: 100 },
      kennel_owner: { free: 5, basic: 15, premium: 50, enterprise: 150 },
      shop_owner: { free: 5, basic: 20, premium: 75, enterprise: 200 },
    };

    const plan = 'free'; // Replace with actual plan from DB
    const limits = MEDIA_LIMITS[userType] || MEDIA_LIMITS.vet;

    res.status(200).json({
      success: true,
      limits: limits,
      currentPlan: plan,
      maxImages: limits[plan],
    });
  } catch (error) {
    console.error('Limits error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get upload limits',
    });
  }
});

export default router;