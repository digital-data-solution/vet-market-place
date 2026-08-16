import mongoose from 'mongoose';

// Every outbound email attempt, success or failure, plus — as of 2026-08-16 —
// delivery/open/click tracking via the Resend webhook (routes/webhooks.routes.js,
// signature-verified with svix). resendEmailId is how an incoming webhook event
// finds its way back to the row that sent it; it's null for Brevo sends (no
// webhook wired up for that provider) and for the "skipped" no-provider-key case.
// Auto-expires so it never grows unbounded.
const emailLogSchema = new mongoose.Schema({
  to:      { type: String, required: true },
  subject: { type: String, required: true },
  status:  { type: String, enum: ['sent', 'failed', 'skipped'], required: true, index: true },
  error:   { type: String },

  resendEmailId: { type: String, default: null, index: true },

  deliveredAt:  { type: Date, default: null },
  openedAt:     { type: Date, default: null }, // first open
  openCount:    { type: Number, default: 0 },
  clickedAt:    { type: Date, default: null }, // first click
  clickCount:   { type: Number, default: 0 },
  lastClickUrl: { type: String, default: null },
  bouncedAt:    { type: Date, default: null },
  bounceReason: { type: String, default: null },
  complainedAt: { type: Date, default: null }, // marked as spam

  createdAt: { type: Date, default: Date.now }, // indexed below (TTL) — don't double-declare with index:true
}, { timestamps: false });

emailLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 }); // 60 days

export default mongoose.model('EmailLog', emailLogSchema);
