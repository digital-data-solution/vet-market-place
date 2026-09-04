import mongoose from 'mongoose';

// Xpress Vet Help Videos — admin-curated "how to use the app" tutorials,
// hosted on YouTube (not self-hosted — no video storage/bandwidth cost, and
// YouTube's own search is a free extra discovery channel) and embedded
// in-app via react-native-webview (already a dependency, so this stays
// OTA-eligible — no new native module). Same "draft, then a human decides
// to publish" pattern as BlogPost/CoursePublishDraft.
const helpVideoSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 160 },

  description: { type: String, trim: true, default: '', maxlength: 500 },

  // Accepts any standard YouTube URL shape (watch?v=, youtu.be/, embed/);
  // youtubeVideoId is derived from it at save time (see pre-validate below)
  // so the app never has to parse the URL itself — it just builds
  // https://www.youtube.com/embed/<youtubeVideoId> for the WebView.
  youtubeUrl:      { type: String, required: true, trim: true },
  youtubeVideoId:  { type: String, required: true, trim: true },

  // Free-text grouping shown as section headers in the app (e.g. "Getting
  // Started", "Business Suite", "Selling on Xpress Market") — admin decides
  // the taxonomy, no fixed enum, same philosophy as BlogPost.tags.
  category: { type: String, trim: true, default: 'General', maxlength: 60 },

  // Manual sort order within a category, ascending. Ties broken by
  // createdAt so a fresh video with no explicit order still lands
  // predictably (newest last within its category).
  order: { type: Number, default: 0 },

  status: { type: String, enum: ['draft', 'published'], default: 'draft', index: true },
  publishedAt: { type: Date, default: null },

  viewCount: { type: Number, default: 0 },

  createdByEmail: { type: String, default: null },
}, { timestamps: true });

helpVideoSchema.index({ status: 1, category: 1, order: 1 });

function extractYouTubeId(url) {
  if (!url) return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = String(url).match(re);
    if (m) return m[1];
  }
  return null;
}

// Mongoose 9 dropped callback-style (next) hooks — a plain function (or one
// returning a promise) is all that's needed; throwing rejects validation.
helpVideoSchema.pre('validate', function preValidate() {
  if (this.isModified('youtubeUrl') || !this.youtubeVideoId) {
    const id = extractYouTubeId(this.youtubeUrl);
    if (!id) throw new Error('Could not parse a YouTube video ID from that URL.');
    this.youtubeVideoId = id;
  }
});

helpVideoSchema.statics.extractYouTubeId = extractYouTubeId;

export default mongoose.model('HelpVideo', helpVideoSchema);
