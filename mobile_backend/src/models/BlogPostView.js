import mongoose from 'mongoose';

// One row per (post, visitor, day) — lets blog.controller.js tell a genuinely
// new visitor from a refresh/re-visit before deciding whether to increment
// BlogPost.viewCount, without ever storing a raw IP address. Purely a
// dedupe ledger, nothing here is ever read back except by its unique index.
const blogPostViewSchema = new mongoose.Schema({
  post:    { type: mongoose.Schema.Types.ObjectId, ref: 'BlogPost', required: true },
  ipHash:  { type: String, required: true },
  day:     { type: String, required: true }, // 'YYYY-MM-DD', server-local date the view happened
  createdAt: { type: Date, default: Date.now },
});

// The uniqueness constraint IS the dedupe logic — a second view from the same
// visitor on the same day fails this index and is caught, not counted again.
blogPostViewSchema.index({ post: 1, ipHash: 1, day: 1 }, { unique: true });

// Auto-expire after a year — this collection only needs to answer "has this
// visitor already been counted today", nothing older than a day is ever
// queried, so there's no reason to keep it forever.
blogPostViewSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });

export default mongoose.model('BlogPostView', blogPostViewSchema);
