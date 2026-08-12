import mongoose from 'mongoose';

// A user-generated marketplace listing — either a live animal for sale ("pet")
// or a physical product ("product", the "Pet Mart"). Xpress Vet only connects
// buyers and sellers; it is NOT a party to the transaction. Buyers may contact
// the seller directly or pay through the in-app escrow (Booking) for protection.
//
// Design notes:
//  • `seller` is the tenant key — every owner-scoped query filters on it (IDOR-safe).
//  • Listings auto-expire (expiresAt) to keep the market fresh; renewing bumps it.
//  • Moderation: reportCount / isFlagged drive the admin takedown queue.
//  • featuredUntil (+ lastFeaturedReference idempotency guard) mirrors the
//    Professional/Shop "boost" pattern so Paystack activation is identical.

const listingImageSchema = new mongoose.Schema(
  {
    url:      { type: String, required: true },
    publicId: { type: String, default: null },
  },
  { _id: false },
);

// Categories are validated loosely (free text allowed) but these power the
// filter chips in the app.
export const PET_CATEGORIES     = ['dog', 'cat', 'bird', 'fish', 'reptile', 'rabbit', 'poultry', 'livestock', 'other'];
export const PRODUCT_CATEGORIES = ['food', 'accessories', 'health', 'grooming', 'equipment', 'housing', 'other'];

const listingSchema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  kind: { type: String, enum: ['pet', 'product'], required: true, index: true },

  title:       { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, required: true, trim: true, maxlength: 3000 },

  price:    { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'NGN' },
  negotiable: { type: Boolean, default: false },

  category: { type: String, trim: true, default: 'other' },

  // Pet-specific (optional)
  species:  { type: String, trim: true, maxlength: 60 },
  breed:    { type: String, trim: true, maxlength: 80 },
  ageText:  { type: String, trim: true, maxlength: 40 },   // e.g. "3 months", "1 year"
  sex:      { type: String, enum: ['male', 'female', 'unknown', null], default: null },
  // Welfare / trust declaration (vaccinations, health, dewormed, etc.)
  healthInfo: { type: String, trim: true, maxlength: 1000 },

  // Product-specific (optional)
  condition: { type: String, enum: ['new', 'used', null], default: null },
  quantity:  { type: Number, min: 0, default: 1 },

  images: { type: [listingImageSchema], default: [] },

  // Contact snapshot — captured at create time so a shared listing always has
  // a way to reach the seller even if their profile changes.
  contactPhone:    { type: String, trim: true, default: null },
  contactWhatsapp: { type: String, trim: true, default: null },

  // Location — GeoJSON point for "near me" browsing + human-readable text.
  // NOTE: no `default: 'Point'` on `type` — a default would make Mongoose
  // materialise `location: { type: 'Point' }` with NO coordinates whenever a
  // seller lists without granting GPS. A 2dsphere index rejects that malformed
  // point, so EVERY GPS-less listing would fail to save. Leaving it undefined
  // means the whole `location` object is simply absent (index skips it).
  location: {
    type:        { type: String, enum: ['Point'] },
    coordinates: { type: [Number], default: undefined }, // [lng, lat]
  },
  address: { type: String, trim: true, maxlength: 200, default: null },
  city:    { type: String, trim: true, maxlength: 80,  default: null },

  status: {
    type: String,
    enum: ['active', 'sold', 'expired', 'removed'],
    default: 'active',
    index: true,
  },

  // Boost / featured (one-off Paystack payment) — same shape as Professional/Shop.
  featuredUntil:         { type: Date, index: true },
  lastFeaturedReference: { type: String, default: null },

  views: { type: Number, default: 0 },

  // The seller must accept the marketplace/seller agreement to publish.
  riskAccepted: { type: Boolean, default: false },

  // Moderation
  reportCount: { type: Number, default: 0 },
  isFlagged:   { type: Boolean, default: false, index: true },
  removedReason: { type: String, default: null },

  // Freshness — listing hidden from browse once past this; renew to extend.
  expiresAt: { type: Date, index: true },
}, { timestamps: true });

listingSchema.index({ location: '2dsphere' });
listingSchema.index({ title: 'text', description: 'text', breed: 'text', species: 'text' });
listingSchema.index({ kind: 1, status: 1, createdAt: -1 });

// Convenience virtual — is the boost currently active?
listingSchema.virtual('isFeaturedNow').get(function () {
  return !!(this.featuredUntil && this.featuredUntil > new Date());
});

export default mongoose.model('Listing', listingSchema);
