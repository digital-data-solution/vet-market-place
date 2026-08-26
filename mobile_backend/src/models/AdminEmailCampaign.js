import mongoose from 'mongoose';

/**
 * AdminEmailCampaign — an admin-composed marketing email, sent immediately
 * to one user, a segment, or everyone reachable by email. The email
 * counterpart to AdminNotification (push) — same segment registry
 * (services/notificationSegments.service.js), same "admin composes, admin
 * reviews, admin clicks Send" flow, queued through the existing Resend+Brevo
 * EmailQueue so delivery gets the same automatic failover as every other
 * email in the app.
 *
 * No scheduling support (unlike AdminNotification) — immediate send only,
 * kept deliberately simple for now.
 */
const adminEmailCampaignSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true, maxlength: 150 },
    // Plain text from the composer textarea — wrapped in the branded HTML
    // template (services/email.service.js's layout()) on send, so the admin
    // never has to write HTML.
    body: { type: String, required: true, trim: true, maxlength: 5000 },

    targetType: {
      type:     String,
      enum:     ['user', 'segment', 'all'],
      required: true,
    },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    segmentKey:   { type: String, default: null },

    status: {
      type:    String,
      enum:    ['sending', 'sent', 'failed'],
      default: 'sending',
    },

    recipientCount: { type: Number, default: 0 }, // matched the segment/target and wasn't opted out
    skippedCount:   { type: Number, default: 0 }, // matched but had no email address, or the individual send errored

    sentAt: { type: Date, default: null },
    error:  { type: String, default: null },

    createdByEmail: { type: String, default: null }, // admin who composed it, for audit
  },
  { timestamps: true },
);

adminEmailCampaignSchema.index({ createdAt: -1 });

export default mongoose.model('AdminEmailCampaign', adminEmailCampaignSchema);
