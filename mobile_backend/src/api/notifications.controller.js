/**
 * notifications.controller.js
 *
 * User-facing endpoint(s) for the notification system — currently just tap
 * tracking. Admin-side compose/send/segments live in
 * api/admin.notifications.controller.js instead.
 */

import mongoose from 'mongoose';
import AdminNotification from '../models/AdminNotification.js';
import NotificationOpen from '../models/NotificationOpen.js';
import logger from '../lib/logger.js';

/**
 * POST /api/notifications/track-open
 * Body: { notificationId }
 * Called by the client when the user taps a push that carries an
 * adminNotificationId in its data payload (native: notification response
 * listener; web: service worker → page bridge — see utils/notifications.ts).
 * Idempotent — re-tapping the same notification doesn't inflate the count
 * (unique index on notification+user in the NotificationOpen model).
 */
export const trackOpen = async (req, res) => {
  try {
    const { notificationId } = req.body;
    if (!notificationId || !mongoose.Types.ObjectId.isValid(notificationId)) {
      return res.status(400).json({ success: false, message: 'Valid notificationId is required.' });
    }

    const exists = await AdminNotification.exists({ _id: notificationId });
    if (!exists) return res.status(404).json({ success: false, message: 'Notification not found.' });

    await NotificationOpen.updateOne(
      { notification: notificationId, user: req.user._id },
      { $setOnInsert: { openedAt: new Date() } },
      { upsert: true },
    );

    return res.json({ success: true });
  } catch (error) {
    logger.error('trackOpen error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to record open.' });
  }
};
