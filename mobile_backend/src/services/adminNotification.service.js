/**
 * adminNotification.service.js
 *
 * Resolves an AdminNotification's target (single user / segment / everyone)
 * to a concrete recipient list and dispatches it via the Expo batch push
 * endpoint, then records delivery counts back onto the document.
 *
 * Called two ways:
 *  - Immediately from the controller, when an admin sends with no
 *    scheduledFor (or one already in the past).
 *  - From jobs/adminNotificationDispatch.js, the cron sweep that picks up
 *    anything scheduled for later.
 * Both paths funnel through dispatchAdminNotification so counts/status are
 * always recorded the same way regardless of when the send actually fires.
 */

import User from '../models/User.js';
import AdminNotification from '../models/AdminNotification.js';
import { resolveSegmentFilter } from './notificationSegments.service.js';
import { sendPushBatch, sendWebPushBatch } from './pushNotification.service.js';
import logger from '../lib/logger.js';

/**
 * Resolves the User filter for a notification's target. Exported separately
 * so the controller can preview a recipient count before actually sending.
 */
export async function resolveTargetFilter(notif) {
  if (notif.targetType === 'user') {
    if (!notif.targetUserId) throw new Error('targetUserId is required for targetType "user".');
    return { _id: notif.targetUserId };
  }
  if (notif.targetType === 'segment') {
    const filter = await resolveSegmentFilter(notif.segmentKey);
    if (!filter) throw new Error(`Unknown segment: ${notif.segmentKey}`);
    return filter;
  }
  // 'all' — still respects marketing opt-out, same as the 'all' segment would.
  return { marketingOptOut: { $ne: true } };
}

export async function dispatchAdminNotification(notificationId) {
  const notif = await AdminNotification.findById(notificationId);
  if (!notif || ['sent', 'cancelled', 'sending'].includes(notif.status)) return notif;

  notif.status = 'sending';
  await notif.save();

  try {
    const filter = await resolveTargetFilter(notif);
    const recipients = await User.find(filter).select('pushToken webPushSubscription').lean();

    // Every push carries the notification's own id so the client can report
    // taps back (see api/notifications.controller.js) — that's the "who is
    // clicking" half of this feature, read via NotificationOpen.
    const data = { ...(notif.data || {}), adminNotificationId: String(notif._id) };

    const expoRecipients = recipients.filter((u) => u.pushToken);
    const webRecipients  = recipients.filter((u) => u.webPushSubscription?.endpoint);
    const reachable = new Set([...expoRecipients, ...webRecipients].map((u) => String(u._id)));

    const expoMessages = expoRecipients.map((u) => ({
      to: u.pushToken, title: notif.title, body: notif.body, data,
    }));
    const webItems = webRecipients.map((u) => ({
      subscription: u.webPushSubscription, userId: u._id, title: notif.title, body: notif.body, data,
    }));

    const [expoResult, webResult] = await Promise.all([
      sendPushBatch(expoMessages),
      sendWebPushBatch(webItems),
    ]);

    if (webResult.expiredUserIds.length) {
      await User.updateMany(
        { _id: { $in: webResult.expiredUserIds } },
        { $set: { webPushSubscription: { endpoint: null, keys: {} } } },
      );
    }

    const sent   = expoResult.sent + webResult.sent;
    const errors = [...expoResult.errors, ...webResult.errors];

    notif.recipientCount = recipients.length;
    notif.skippedCount   = recipients.length - reachable.size;
    notif.sentCount      = sent;
    notif.failedCount    = errors.length;
    notif.status         = 'sent';
    notif.sentAt         = new Date();
    if (errors.length) {
      notif.error = errors.slice(0, 5).map((e) => e.message).join('; ');
    }
    await notif.save();

    logger.info('Admin notification dispatched', {
      id: notif._id,
      targetType: notif.targetType,
      segmentKey: notif.segmentKey,
      recipientCount: notif.recipientCount,
      sentCount: sent,
      skippedCount: notif.skippedCount,
      failedCount: errors.length,
    });
  } catch (err) {
    notif.status = 'failed';
    notif.error  = err.message;
    await notif.save();
    logger.error('Admin notification dispatch failed', { id: notificationId, error: err.message });
  }

  return notif;
}

export default { resolveTargetFilter, dispatchAdminNotification };
