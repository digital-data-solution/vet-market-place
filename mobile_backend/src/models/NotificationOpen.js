import mongoose from 'mongoose';

/**
 * Records that a specific user tapped a specific AdminNotification push —
 * the "who is clicking" half of admin-sent notifications. One row per
 * (notification, user) pair, so re-tapping the same notification doesn't
 * inflate the count. See api/notifications.controller.js (track) and
 * api/admin.notifications.controller.js (read, for the admin history view).
 */
const notificationOpenSchema = new mongoose.Schema({
  notification: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminNotification', required: true },
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  openedAt:     { type: Date, default: Date.now },
});

notificationOpenSchema.index({ notification: 1, user: 1 }, { unique: true });

export default mongoose.model('NotificationOpen', notificationOpenSchema);
