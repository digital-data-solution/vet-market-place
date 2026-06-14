import express from 'express';
import { protect } from '../middlewares/authMiddleware.js';
import { logActivity } from '../lib/activityLogger.js';

const router = express.Router();

const VALID_METHODS = new Set(['phone', 'whatsapp', 'email']);
const VALID_TARGET_TYPES = new Set(['professional', 'kennel', 'shop']);

/**
 * POST /api/v1/track/contact-tap
 * Lightweight fire-and-forget endpoint called by the mobile app just before
 * Linking.openURL() — tracks which contact methods users actually tap.
 * Always returns 200 immediately regardless of logging outcome.
 * Body: { targetId, targetType, method }
 *   targetType: 'professional' | 'kennel' | 'shop'
 *   method:     'phone' | 'whatsapp' | 'email'
 */
router.post('/contact-tap', protect, (req, res) => {
  const { targetId, targetType, method } = req.body;

  // Respond immediately — client is about to open a URL and shouldn't wait
  res.status(200).json({ success: true });

  if (
    typeof targetId === 'string' && targetId.trim() &&
    VALID_TARGET_TYPES.has(targetType) &&
    VALID_METHODS.has(method)
  ) {
    logActivity(req.user._id || req.user.id, req.user.role, 'contact.tapped', {
      targetId,
      targetType,
      method,
    }, req);
  }
});

export default router;
