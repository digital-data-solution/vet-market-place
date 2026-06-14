import express from 'express';
import { protect }               from '../middlewares/authMiddleware.js';
import { enforceSubscription }   from '../middlewares/subscriptionMiddleware.js';
import { supabaseAdmin }         from '../lib/supabase.js';
import logger                    from '../lib/logger.js';
import { logActivity }           from '../lib/activityLogger.js';

const router = express.Router();

// POST /api/messages/send
// Server-side send: enforces subscription before inserting into Supabase,
// so the subscription gate cannot be bypassed by calling Supabase directly.
// Rate-limited by messageLimiter in app.js (30 req/min per user).
router.post('/send', protect, enforceSubscription, async (req, res) => {
  const fromUserId = req.user.supabaseId;
  const { toUserId, text } = req.body;

  if (!fromUserId) {
    return res.status(400).json({
      success: false,
      message: 'Sender Supabase ID not found on account. Re-login may resolve this.',
    });
  }
  if (!toUserId || typeof toUserId !== 'string' || !toUserId.trim()) {
    return res.status(400).json({ success: false, message: 'toUserId is required.' });
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ success: false, message: 'Message text is required.' });
  }

  const trimmedText = text.trim();
  if (trimmedText.length > 2000) {
    return res.status(400).json({ success: false, message: 'Message exceeds maximum length (2000 characters).' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('messages')
      .insert({
        from_user_id: fromUserId,
        to_user_id:   toUserId,
        message_text: trimmedText,
        read_status:  false,
      })
      .select()
      .single();

    if (error) {
      logger.error('Send message Supabase error', { error: error.message, fromUserId, toUserId });
      return res.status(500).json({ success: false, message: 'Failed to send message.' });
    }

    logActivity(req.user._id || req.user.id, req.user.role, 'message.sent', {
      toSupabaseId: toUserId,
    }, req);

    return res.status(201).json({ success: true, data });
  } catch (error) {
    logger.error('Send message error', { error: error.message, fromUserId, toUserId });
    return res.status(500).json({ success: false, message: 'Failed to send message.' });
  }
});

export default router;
