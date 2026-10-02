import mongoose from 'mongoose';

/**
 * A finished Short (already on Cloudinary) for Xpress Vet's YouTube channel
 * with its own title/description/tags and go-live time — first used for the
 * trending-topic + vet-tip Shorts (2026-10-02). Separate from ScheduledReel so
 * YouTube-only videos never reach Instagram. Drained by jobs/youtubeShortsWorker.js,
 * which uploads each as private with publishAt so YouTube flips it public itself.
 */
const youTubeShortSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, trim: true }, // e.g. "t1-christmas-broilers"
  videoUrl: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  tags: { type: [String], default: [] },
  publishAt: { type: Date, required: true, index: true },

  status: { type: String, enum: ['pending', 'processing', 'uploaded', 'failed'], default: 'pending', index: true },
  videoId: { type: String, default: null },
  url: { type: String, default: null },
  error: { type: String, default: null },
  uploadedAt: { type: Date, default: null },
}, { timestamps: true });

export default mongoose.models.YouTubeShort || mongoose.model('YouTubeShort', youTubeShortSchema);
