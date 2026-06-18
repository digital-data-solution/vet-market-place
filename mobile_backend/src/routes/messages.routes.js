import express from 'express';
import { protect }               from '../middlewares/authMiddleware.js';
import { enforceSubscription }   from '../middlewares/subscriptionMiddleware.js';
import { supabaseAdmin }         from '../lib/supabase.js';
import logger                    from '../lib/logger.js';
import { logActivity }           from '../lib/activityLogger.js';
import User                      from '../models/User.js';

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

// GET /api/messages/conversations
// Returns grouped conversations for the logged-in user, with partner name + avatar.
// Uses service-role Supabase client — no RLS dependency.
router.get('/conversations', protect, enforceSubscription, async (req, res) => {
  const userId = req.user.supabaseId;

  if (!userId) {
    return res.status(400).json({
      success: false,
      message: 'Supabase ID not found on account. Re-login may resolve this.',
    });
  }

  try {
    const { data: messages, error } = await supabaseAdmin
      .from('messages')
      .select('*')
      .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Fetch conversations Supabase error', { error: error.message, userId });
      return res.status(500).json({ success: false, message: 'Failed to fetch conversations.' });
    }

    // Group by conversation partner — keep only the most recent message per partner
    const seen = new Map();
    for (const msg of messages ?? []) {
      const otherId = msg.from_user_id === userId ? msg.to_user_id : msg.from_user_id;
      if (!seen.has(otherId)) seen.set(otherId, msg);
    }

    if (seen.size === 0) {
      return res.json({ success: true, data: [] });
    }

    // Resolve partner names + avatars from MongoDB
    const partnerSupabaseIds = Array.from(seen.keys());
    const partners = await User.find({ supabaseId: { $in: partnerSupabaseIds } })
      .select('supabaseId name profileImage')
      .lean();

    const partnerMap = Object.fromEntries(partners.map(p => [p.supabaseId, p]));

    const conversations = Array.from(seen.entries()).map(([otherId, msg]) => {
      const partner = partnerMap[otherId];
      return {
        otherUserId:     otherId,
        otherUserName:   partner?.name    ?? 'Unknown User',
        otherUserAvatar: partner?.profileImage ?? null,
        lastMessage:     msg.message_text,
        lastMessageAt:   msg.created_at,
        hasUnread:       msg.to_user_id === userId && !msg.read_status,
      };
    });

    return res.json({ success: true, data: conversations });
  } catch (err) {
    logger.error('Fetch conversations error', { error: err.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to fetch conversations.' });
  }
});

export default router;
