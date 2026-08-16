/**
 * admin.notifications.controller.js
 *
 * Admin-composed push notifications — send to a single picked user, an
 * intelligent segment, or everyone; now or scheduled for later.
 * See services/adminNotification.service.js for dispatch and
 * services/notificationSegments.service.js for the segment registry.
 */

import User from '../models/User.js';
import AdminNotification from '../models/AdminNotification.js';
import NotificationOpen from '../models/NotificationOpen.js';
import { listSegmentDefinitions, resolveSegmentFilter, reachableFilter } from '../services/notificationSegments.service.js';
import { resolveTargetFilter, dispatchAdminNotification } from '../services/adminNotification.service.js';
import logger from '../lib/logger.js';

/**
 * GET /api/admin/notifications/segments
 * Returns every defined segment with a live "matches" count and a
 * "reachable" count (matches that also have a saved push token), so the
 * admin can see the real audience size before sending.
 */
export const listSegments = async (_req, res) => {
  try {
    const definitions = listSegmentDefinitions();
    const segments = await Promise.all(
      definitions.map(async (def) => {
        try {
          const filter = await resolveSegmentFilter(def.key);
          const [matches, reachable] = await Promise.all([
            User.countDocuments(filter),
            User.countDocuments(reachableFilter(filter)),
          ]);
          return { ...def, matches, reachable };
        } catch (err) {
          logger.error('Segment count failed', { segment: def.key, error: err.message });
          return { ...def, matches: null, reachable: null };
        }
      }),
    );
    return res.json({ success: true, data: segments });
  } catch (error) {
    logger.error('listSegments error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load segments.' });
  }
};

/**
 * POST /api/admin/notifications
 * Body: { title, body, targetType: 'user'|'segment'|'all', targetUserId?,
 *         segmentKey?, data?, scheduledFor? (ISO string, omit to send now) }
 */
export const createNotification = async (req, res) => {
  try {
    const { title, body, targetType, targetUserId, segmentKey, data, scheduledFor } = req.body;

    if (!title?.trim() || !body?.trim()) {
      return res.status(400).json({ success: false, message: 'Title and body are required.' });
    }
    if (!['user', 'segment', 'all'].includes(targetType)) {
      return res.status(400).json({ success: false, message: 'targetType must be "user", "segment", or "all".' });
    }
    if (targetType === 'user' && !targetUserId) {
      return res.status(400).json({ success: false, message: 'targetUserId is required when targetType is "user".' });
    }
    if (targetType === 'segment' && !segmentKey) {
      return res.status(400).json({ success: false, message: 'segmentKey is required when targetType is "segment".' });
    }
    if (targetType === 'user') {
      const target = await User.findById(targetUserId).select('_id').lean();
      if (!target) return res.status(404).json({ success: false, message: 'User not found.' });
    }
    if (targetType === 'segment' && !(await resolveSegmentFilter(segmentKey))) {
      return res.status(400).json({ success: false, message: `Unknown segment "${segmentKey}".` });
    }

    const scheduledDate = scheduledFor ? new Date(scheduledFor) : null;
    if (scheduledFor && isNaN(scheduledDate?.getTime())) {
      return res.status(400).json({ success: false, message: 'scheduledFor must be a valid date/time.' });
    }
    const isFuture = scheduledDate && scheduledDate.getTime() > Date.now() + 5000; // small grace window

    const notif = await AdminNotification.create({
      title: title.trim(),
      body: body.trim(),
      data: data && typeof data === 'object' ? data : {},
      targetType,
      targetUserId: targetType === 'user' ? targetUserId : null,
      segmentKey: targetType === 'segment' ? segmentKey : null,
      scheduledFor: isFuture ? scheduledDate : null,
      status: 'scheduled',
      createdByEmail: req.user?.email || null,
    });

    if (!isFuture) {
      const dispatched = await dispatchAdminNotification(notif._id);
      return res.status(201).json({ success: true, data: dispatched, sentNow: true });
    }

    logger.info('Admin notification scheduled', { id: notif._id, scheduledFor: scheduledDate });
    return res.status(201).json({ success: true, data: notif, sentNow: false });
  } catch (error) {
    logger.error('createNotification error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to create notification.' });
  }
};

/**
 * GET /api/admin/notifications/preview-count
 * Query: same shape as createNotification's target fields — lets the UI show
 * "this will reach N people" before the admin commits to sending.
 */
export const previewRecipientCount = async (req, res) => {
  try {
    const { targetType, targetUserId, segmentKey } = req.query;
    if (!['user', 'segment', 'all'].includes(targetType)) {
      return res.status(400).json({ success: false, message: 'targetType must be "user", "segment", or "all".' });
    }
    const filter = await resolveTargetFilter({ targetType, targetUserId, segmentKey });
    const [matches, reachable] = await Promise.all([
      User.countDocuments(filter),
      User.countDocuments(reachableFilter(filter)),
    ]);
    return res.json({ success: true, data: { matches, reachable } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || 'Failed to preview recipient count.' });
  }
};

/**
 * GET /api/admin/notifications
 * Paginated send history (sent, scheduled, failed, cancelled).
 */
export const listNotifications = async (req, res) => {
  try {
    const { page = 1, limit = 30, status } = req.query;
    const filter = status ? { status } : {};
    const [data, total] = await Promise.all([
      AdminNotification.find(filter)
        .populate('targetUserId', 'name email')
        .sort({ createdAt: -1 })
        .skip((+page - 1) * +limit)
        .limit(+limit)
        .lean(),
      AdminNotification.countDocuments(filter),
    ]);

    // "Who is clicking" — open counts for this page only (cheap: page size is
    // capped at `limit`, one countDocuments per row via Promise.all).
    const openCounts = await Promise.all(
      data.map((n) => NotificationOpen.countDocuments({ notification: n._id })),
    );
    data.forEach((n, i) => { n.openedCount = openCounts[i]; });

    return res.json({ success: true, data, total, page: +page, totalPages: Math.ceil(total / +limit) });
  } catch (error) {
    logger.error('listNotifications error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch notifications.' });
  }
};

/**
 * GET /api/admin/notifications/:id/opens
 * The actual "who is clicking" list for one notification — who tapped it
 * and when, newest first.
 */
export const listNotificationOpens = async (req, res) => {
  try {
    const opens = await NotificationOpen.find({ notification: req.params.id })
      .populate('user', 'name email role')
      .sort({ openedAt: -1 })
      .limit(500)
      .lean();
    return res.json({ success: true, data: opens });
  } catch (error) {
    logger.error('listNotificationOpens error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch opens.' });
  }
};

/**
 * PATCH /api/admin/notifications/:id/cancel
 * Only works while still 'scheduled' — once dispatch starts there's nothing
 * to cancel.
 */
export const cancelNotification = async (req, res) => {
  try {
    const notif = await AdminNotification.findById(req.params.id);
    if (!notif) return res.status(404).json({ success: false, message: 'Notification not found.' });
    if (notif.status !== 'scheduled') {
      return res.status(400).json({ success: false, message: `Cannot cancel a notification that is already "${notif.status}".` });
    }
    notif.status = 'cancelled';
    await notif.save();
    return res.json({ success: true, data: notif });
  } catch (error) {
    logger.error('cancelNotification error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to cancel notification.' });
  }
};
