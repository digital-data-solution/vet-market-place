import mongoose from 'mongoose';

/**
 * CoursePublishDraft — an inert record created when Xpress Digital Academy's
 * course-publish webhook fires (see api/academyWebhook.controller.js).
 *
 * This is deliberately a passive inbox, never a trigger: receiving one never
 * notifies anyone. An admin reviews it on the dashboard and, if they want to
 * tell vets/breeders about it, manually composes a real push notification via
 * the existing admin-notification tooling (services/adminNotification.service.js)
 * — same "draft, never auto-send" rule already used for the WhatsApp-drafts
 * Telegram pipeline.
 */
const coursePublishDraftSchema = new mongoose.Schema(
  {
    event: { type: String, default: 'course.published' },
    line:  { type: String, default: null }, // e.g. 'VET' — Academy may have other lines later

    courseName:       { type: String, required: true, trim: true },
    slug:             { type: String, default: null, trim: true },
    priceNgn:         { type: Number, default: null },
    pricingModel:     { type: String, default: null }, // e.g. 'PAID' | 'FREE'
    shortDescription: { type: String, default: null },
    category:         { type: String, default: null },
    courseUrl:        { type: String, required: true },
    publishedAt:      { type: Date, default: Date.now },

    // Full original webhook body, kept for audit/debugging regardless of
    // which fields we parsed out above.
    rawPayload: { type: mongoose.Schema.Types.Mixed, default: {} },

    status: {
      type:    String,
      enum:    ['draft', 'dismissed', 'notified'],
      default: 'draft',
    },
    // Set once an admin dismisses it or links it to a sent AdminNotification.
    reviewedAt:      { type: Date, default: null },
    reviewedByEmail: { type: String, default: null },
    notificationId:  { type: mongoose.Schema.Types.ObjectId, ref: 'AdminNotification', default: null },
  },
  { timestamps: true },
);

coursePublishDraftSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model('CoursePublishDraft', coursePublishDraftSchema);
