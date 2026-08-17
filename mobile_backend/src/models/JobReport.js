import mongoose from 'mongoose';

// A user report/flag against a JobPosting — feeds the admin moderation queue.
// Deliberately a SEPARATE model from models/Report.js (which requires a
// `listing` ref) rather than a shared/generic one — keeps the existing
// Xpress Market moderation dashboard queries untouched and low-risk.
const jobReportSchema = new mongoose.Schema({
  jobPosting: { type: mongoose.Schema.Types.ObjectId, ref: 'JobPosting', required: true, index: true },
  reporter:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  reason: {
    type: String,
    enum: ['scam', 'fake_job', 'discriminatory', 'wrong_category', 'offensive', 'filled', 'other'],
    default: 'other',
  },
  note: { type: String, trim: true, maxlength: 500, default: null },

  status: {
    type: String,
    enum: ['open', 'reviewed', 'actioned', 'dismissed'],
    default: 'open',
    index: true,
  },

  resolvedAt: { type: Date },
}, { timestamps: true });

export default mongoose.model('JobReport', jobReportSchema);
