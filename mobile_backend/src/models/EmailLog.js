import mongoose from 'mongoose';

// Every outbound email attempt, success or failure — not open/click tracking
// (that would need a Resend webhook + signature verification, deliberately
// not built without a way to test it against live traffic). This answers a
// more basic but load-bearing question: are emails actually leaving the
// building at all? Auto-expires so it never grows unbounded.
const emailLogSchema = new mongoose.Schema({
  to:      { type: String, required: true },
  subject: { type: String, required: true },
  status:  { type: String, enum: ['sent', 'failed', 'skipped'], required: true, index: true },
  error:   { type: String },
  createdAt: { type: Date, default: Date.now }, // indexed below (TTL) — don't double-declare with index:true
}, { timestamps: false });

emailLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 }); // 60 days

export default mongoose.model('EmailLog', emailLogSchema);
