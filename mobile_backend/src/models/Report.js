import mongoose from 'mongoose';

// A user report/flag against a marketplace Listing — feeds the admin
// moderation queue. Keeping this separate (vs. an embedded array) makes the
// "open reports" dashboard query cheap and preserves a full audit trail even
// after a listing is taken down.
const reportSchema = new mongoose.Schema({
  listing:  { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true, index: true },
  reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  reason: {
    type: String,
    enum: ['scam', 'prohibited', 'animal_welfare', 'wrong_category', 'offensive', 'sold', 'other'],
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

export default mongoose.model('Report', reportSchema);
