import SupportThread from '../models/SupportThread.js';
import { sendSupportMessageAlert } from '../services/email.service.js';
import { getBotReply } from '../lib/supportBot.js';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'contact@xpressdigitalanddatasolutions.online';

// POST /api/support — user sends a message (creates thread if none exists)
export const sendSupportMessage = async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: 'Message text is required.' });
    }
    if (text.trim().length > 2000) {
      return res.status(400).json({ success: false, message: 'Message too long (max 2000 characters).' });
    }

    const userId    = req.user._id;
    const userName  = req.user.name  || req.user.email?.split('@')[0] || 'User';
    const userEmail = req.user.email || '';
    const userRole  = req.user.role  || 'pet_owner';

    const now = new Date();
    const botReply = getBotReply(text.trim());

    // Detect explicit escalation request — user wants a human regardless of bot match
    const ESCALATION_KEYWORDS = ['human', 'real person', 'agent', 'talk to someone', 'speak to', 'escalate', 'no bot'];
    const wantsHuman = ESCALATION_KEYWORDS.some(k => text.trim().toLowerCase().includes(k));
    const effectiveBotReply = wantsHuman ? null : botReply;
    const finalMessages = [{ text: text.trim(), senderRole: 'user' }];
    if (effectiveBotReply) finalMessages.push({ text: effectiveBotReply, senderRole: 'bot' });

    const thread = await SupportThread.findOneAndUpdate(
      { userId },
      {
        $set: {
          userName,
          userEmail,
          userRole,
          lastMessageAt: now,
          needsHuman: !effectiveBotReply,
          // Always reopen if resolved — new message means new issue
          status: 'open',
        },
        $push: { messages: { $each: finalMessages } },
      },
      { upsert: true, new: true },
    );

    // Only alert admin when the bot couldn't handle it (or user escalated)
    if (!effectiveBotReply) {
      sendSupportMessageAlert(ADMIN_EMAIL, {
        userName,
        userEmail,
        userRole,
        text: text.trim(),
        threadId: thread._id.toString(),
      }).catch(() => {});
    }

    return res.status(201).json({ success: true, data: thread, botReplied: !!effectiveBotReply });
  } catch (err) {
    console.error('sendSupportMessage error:', err);
    return res.status(500).json({ success: false, message: 'Failed to send message.' });
  }
};

// GET /api/support — user gets their own support thread
export const getMyThread = async (req, res) => {
  try {
    const thread = await SupportThread.findOne({ userId: req.user._id }).lean();
    return res.json({ success: true, data: thread || null });
  } catch (err) {
    console.error('getMyThread error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch thread.' });
  }
};
