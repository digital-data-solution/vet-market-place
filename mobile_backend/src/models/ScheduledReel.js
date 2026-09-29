import mongoose from 'mongoose';

/**
 * A ready-made Reel (already on Cloudinary) with a fixed go-live time —
 * first used for the 11 narrated vet-tip videos built 2026-09-29
 * (VETFRESH/instagram-videos). Unlike BlogPost/Listing, nothing here is
 * derived from site content: the video and captions are final as stored.
 * Drained by jobs/scheduledReelWorker.js.
 */
const scheduledReelSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, trim: true }, // e.g. "01-mange-ringworm"
  videoUrl: { type: String, required: true },
  captionInstagram: { type: String, required: true },
  captionFacebook: { type: String, required: true },
  postAt: { type: Date, required: true, index: true },

  instagramStatus: { type: String, enum: ['pending', 'processing', 'posted', 'failed'], default: 'pending', index: true },
  instagramMediaId: { type: String, default: null },
  instagramUrl: { type: String, default: null },
  instagramError: { type: String, default: null },
  instagramPostedAt: { type: Date, default: null },

  facebookStatus: { type: String, enum: ['none', 'posted', 'failed'], default: 'none' },
  facebookUrl: { type: String, default: null },
  facebookError: { type: String, default: null },
}, { timestamps: true });

export default mongoose.models.ScheduledReel || mongoose.model('ScheduledReel', scheduledReelSchema);
