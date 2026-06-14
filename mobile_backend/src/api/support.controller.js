import SupportThread from '../models/SupportThread.js';
import { sendSupportMessageAlert } from '../services/email.service.js';

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

    const thread = await SupportThread.findOneAndUpdate(
      { userId },
      {
        $set:   { userName, userEmail, userRole, lastMessageAt: now },
        $push:  { messages: { text: text.trim(), senderRole: 'user' } },
        $setOnInsert: { status: 'open' },
      },
      { upsert: true, new: true },
    );

    // Email admin immediately — fire and forget
    sendSupportMessageAlert(ADMIN_EMAIL, {
      userName,
      userEmail,
      userRole,
      text: text.trim(),
      threadId: thread._id.toString(),
    }).catch(() => {});

    return res.status(201).json({ success: true, data: thread });
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
