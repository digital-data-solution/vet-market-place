import mongoose from 'mongoose';

// Durable work queue for outbound email — see jobs/emailQueueWorker.js for the
// worker that drains it. Chosen over an in-memory/Bull-Redis queue because
// Redis on this project has been unreliable (see the known-gotchas memory
// note), so a Mongo-backed queue (same DB the app already depends on) is the
// more durable option: a record survives a dyno restart mid-send, whereas an
// in-memory queue would just lose it.
//
// A row is claimed atomically (status 'queued' → 'processing' via
// findOneAndUpdate) so this stays safe even if the worker ever runs on more
// than one instance. Once every configured provider has been tried and
// failed in a single pass, the row goes back to 'queued' with a backed-off
// nextAttemptAt rather than 'failed' — it only becomes permanently 'failed'
// after maxAttempts passes, each of which already tried every provider.
//
// This is intentionally separate from EmailLog: EmailLog is the permanent,
// TTL'd (60d) audit trail + delivery-webhook correlation record, written
// once a row here reaches a terminal state. This collection is short-lived
// working state only, pruned faster (14d) since nothing depends on it once
// a send has resolved one way or the other.
const emailQueueSchema = new mongoose.Schema({
  to:      { type: String, required: true },
  subject: { type: String, required: true },
  html:    { type: String, required: true },
  text:    { type: String },

  // Which provider a call-site asked for (e.g. Xpress Market/Pet Mart mail
  // pins 'brevo' to keep volume off the outreach-critical Resend domain).
  // null means "no preference" — the worker tries Resend first, Brevo as
  // fallback, matching the original default behavior before this queue
  // existed.
  preferredProvider: { type: String, enum: ['resend', 'brevo', null], default: null },

  status: {
    type: String,
    enum: ['queued', 'processing', 'sent', 'failed'],
    default: 'queued',
    index: true,
  },

  attempts:    { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  // Every attempt tries every configured provider before this advances —
  // so "attempts" counts full passes, not individual provider calls.
  nextAttemptAt: { type: Date, default: Date.now, index: true },

  lastError:    { type: String, default: null },
  // Per-provider errors from the most recent pass, for debugging exactly
  // which leg failed and why (e.g. distinguishing a 429 rate-limit from an
  // auth/config error) without needing full request logs.
  lastAttemptErrors: {
    resend: { type: String, default: null },
    brevo:  { type: String, default: null },
  },

  providerUsed:   { type: String, default: null }, // which one actually delivered it
  resendEmailId:  { type: String, default: null }, // only set when providerUsed === 'resend'
  sentAt:         { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
}, { timestamps: false });

emailQueueSchema.index({ status: 1, nextAttemptAt: 1 }); // worker's claim query
emailQueueSchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 3600 }); // 14 days

export default mongoose.model('EmailQueue', emailQueueSchema);
