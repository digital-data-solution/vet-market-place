import mongoose from 'mongoose';

// One row per human visit that arrived via a tagged link (?src=ig / fb / yt
// ...) — answers "is social actually sending people to the site?", which
// BlogPost.viewCount alone can't (it doesn't know where a visitor came from).
// Written by app.js's recordShareClick() on the /b/, /l/ and SPA routes.
// Link-preview crawlers are skipped there so they don't count as clicks.
const shareClickSchema = new mongoose.Schema({
  src:  { type: String, required: true, index: true }, // 'ig' | 'fb' | 'yt' | 'bio' ...
  path: { type: String, required: true },              // e.g. '/b/canine-distemper', '/Blog'
  createdAt: { type: Date, default: Date.now },
});

// Same 1-year retention as BlogPostView — enough for month-over-month trends.
shareClickSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });

export default mongoose.model('ShareClick', shareClickSchema);
