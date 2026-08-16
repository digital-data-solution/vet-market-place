import mongoose from 'mongoose';

/**
 * AdminNotification — an admin-composed push notification, sent now or
 * scheduled for later, to one specific user, an intelligent segment
 * (see services/notificationSegments.service.js), or everyone reachable.
 *
 * Dispatch happens either immediately (api/admin.notifications.controller.js,
 * on create when scheduledFor is absent/past) or via the cron sweep in
 * jobs/adminNotificationDispatch.js for anything scheduled for later.
 */
const adminNotificationSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body:  { type: String, required: true, trim: true, maxlength: 500 },
    // Arbitrary payload merged into the push `data` field (e.g. a deep link).
    data: { type: mongoose.Schema.Types.Mixed, default: {} },

    targetType: {
      type:     String,
      enum:     ['user', 'segment', 'all'],
      required: true,
    },
    // Only set when targetType === 'user'
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Only set when targetType === 'segment' — key into the segment registry
    segmentKey: { type: String, default: null },

    // null/absent = send immediately on create. Otherwise the dispatch cron
    // picks it up once scheduledFor <= now.
    scheduledFor: { type: Date, default: null },

    status: {
      type:    String,
      enum:    ['scheduled', 'sending', 'sent', 'failed', 'cancelled'],
      default: 'scheduled',
    },

    recipientCount: { type: Number, default: 0 }, // matched the segment/target
    sentCount:      { type: Number, default: 0 }, // push actually attempted+succeeded
    skippedCount:   { type: Number, default: 0 }, // matched but had no push token
    failedCount:    { type: Number, default: 0 }, // push attempt errored

    sentAt: { type: Date, default: null },
    error:  { type: String, default: null },

    createdByEmail: { type: String, default: null }, // admin who composed it, for audit
  },
  { timestamps: true },
);

adminNotificationSchema.index({ status: 1, scheduledFor: 1 });
adminNotificationSchema.index({ createdAt: -1 });

export default mongoose.model('AdminNotification', adminNotificationSchema);
