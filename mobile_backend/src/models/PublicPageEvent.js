import mongoose from 'mongoose';

// Visits to the public no-login vet pages, and taps on a vet's Call/WhatsApp
// buttons. Answers "how many farmers did the site send each vet, and from
// where (Google, WhatsApp share, Instagram...)?" — the proof we need before
// asking vets to pay for anything. See scripts/public-page-stats.mjs.
const publicPageEventSchema = new mongoose.Schema({
  kind:  { type: String, enum: ['view', 'call', 'whatsapp'], required: true },
  path:  { type: String, required: true },          // e.g. '/poultry-vets/oyo', '/v/<id>'
  vetId: { type: String, default: null, index: true }, // set for /v/:id views and taps
  src:   { type: String, required: true },          // 'google' | 'fb' | 'ig' | 'direct' | a ?src tag
  createdAt: { type: Date, default: Date.now },
});

// Two years: enough to show a vet a year-on-year comparison.
publicPageEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 365 * 24 * 3600 });

export default mongoose.model('PublicPageEvent', publicPageEventSchema);
