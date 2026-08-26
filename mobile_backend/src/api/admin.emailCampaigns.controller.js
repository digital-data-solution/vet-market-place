/**
 * admin.emailCampaigns.controller.js
 *
 * Admin-composed one-off marketing emails — sent to a single picked user, an
 * intelligent segment, or everyone reachable by email. The email counterpart
 * to admin.notifications.controller.js's push composer. Segment definitions
 * are shared with push (GET /api/admin/notifications/segments) — no
 * duplicate registry here.
 */
import User from '../models/User.js';
import AdminEmailCampaign from '../models/AdminEmailCampaign.js';
import { dispatchAdminEmailCampaign, resolveEmailTargetFilter } from '../services/adminEmailCampaign.service.js';
import logger from '../lib/logger.js';

/**
 * POST /api/admin/email-campaigns
 * Body: { subject, body, targetType: 'user'|'segment'|'all', targetUserId?, segmentKey? }
 * Sends immediately — no scheduling support yet.
 */
export const createEmailCampaign = async (req, res) => {
  try {
    const { subject, body, targetType, targetUserId, segmentKey } = req.body;

    if (!subject?.trim() || !body?.trim()) {
      return res.status(400).json({ success: false, message: 'Subject and body are required.' });
    }
    if (!['user', 'segment', 'all'].includes(targetType)) {
      return res.status(400).json({ success: false, message: 'targetType must be one of: user, segment, all.' });
    }
    if (targetType === 'user' && !targetUserId) {
      return res.status(400).json({ success: false, message: 'targetUserId is required for targetType "user".' });
    }
    if (targetType === 'segment' && !segmentKey) {
      return res.status(400).json({ success: false, message: 'segmentKey is required for targetType "segment".' });
    }

    const campaign = await AdminEmailCampaign.create({
      subject: subject.trim(),
      body: body.trim(),
      targetType,
      targetUserId: targetType === 'user' ? targetUserId : null,
      segmentKey: targetType === 'segment' ? segmentKey : null,
      createdByEmail: req.user?.email || null,
    });

    const sent = await dispatchAdminEmailCampaign(campaign._id);

    return res.status(201).json({ success: true, data: sent });
  } catch (error) {
    logger.error('createEmailCampaign error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to send email campaign.' });
  }
};

/**
 * GET /api/admin/email-campaigns?status=sent
 */
export const listEmailCampaigns = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const campaigns = await AdminEmailCampaign.find(filter)
      .populate('targetUserId', 'name email')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return res.json({ success: true, data: campaigns });
  } catch (error) {
    logger.error('listEmailCampaigns error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load email campaigns.' });
  }
};

/**
 * GET /api/admin/email-campaigns/preview-count?targetType=segment&segmentKey=role_vet
 * Same shape as the push composer's preview — lets the admin see how many
 * people they're about to email before they hit Send.
 */
export const previewEmailReach = async (req, res) => {
  try {
    const { targetType, targetUserId, segmentKey } = req.query;
    const filter = await resolveEmailTargetFilter({ targetType, targetUserId, segmentKey });
    const count = await User.countDocuments({
      ...filter,
      marketingOptOut: { $ne: true },
      email: { $nin: [null, ''] },
    });
    return res.json({ success: true, data: { count } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};
