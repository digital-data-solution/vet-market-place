import mongoose from 'mongoose';

// Xpress Vet Job Board — a directory, not a feed. Deliberately two-sided from
// day one so it stays useful even when fresh postings are sparse:
//   'position'      — a verified clinic/shop/kennel posting an open role
//   'seeking_work'  — any user posting their own availability (vet, vet tech,
//                      groomer, receptionist, etc.) for clinics to browse
//
// Kept intentionally lightweight, same philosophy as Xpress Market: contact
// happens off-platform (phone/WhatsApp) — no CV upload, no application
// tracking. That's the whole reason this can ship in a weekend instead of a
// quarter; only build a real ATS-style flow later if real demand proves it.
//
// Design notes (mirrors models/Listing.js on purpose — same proven shape):
//  • `poster` is the tenant key — every owner-scoped query filters on it.
//  • Postings auto-expire (expiresAt) to keep the board fresh; renewing bumps it.
//  • Moderation: reportCount / isFlagged drive the admin takedown queue
//    (see models/JobReport.js — a separate model from marketplace Report so
//    the existing Xpress Market moderation queries are never touched).
//  • featuredUntil (+ lastFeaturedReference idempotency guard) mirrors the
//    Listing/Professional/Shop "boost" pattern so Paystack activation is identical.

export const ROLE_CATEGORIES = [
  'vet', 'vet_tech', 'groomer', 'trainer', 'pet_sitter', 'receptionist',
  'kennel_assistant', 'driver', 'sales_rep', 'manager', 'other',
];

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'locum', 'contract'];

const jobPostingSchema = new mongoose.Schema({
  poster: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  kind: { type: String, enum: ['position', 'seeking_work'], required: true, index: true },

  title:       { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, required: true, trim: true, maxlength: 3000 },

  roleCategory: { type: String, enum: [...ROLE_CATEGORIES, ''], default: '' },

  employmentType: { type: String, enum: [...EMPLOYMENT_TYPES, null], default: null },
  experienceText: { type: String, trim: true, maxlength: 100, default: null }, // e.g. "3+ years", "Entry level"
  salaryText:     { type: String, trim: true, maxlength: 100, default: null }, // e.g. "₦150,000 - ₦250,000/month", "Negotiable"

  // Contact snapshot — same pattern as Listing, so a shared posting always has
  // a way to reach the poster even if their profile changes later.
  contactPhone:    { type: String, trim: true, default: null },
  contactWhatsapp: { type: String, trim: true, default: null },

  // Location — GeoJSON point for "near me" browsing + human-readable text.
  // NOTE: no `default: 'Point'` on `type` — see models/Listing.js for why
  // that default silently breaks every GPS-less save on a 2dsphere index.
  location: {
    type:        { type: String, enum: ['Point'] },
    coordinates: { type: [Number], default: undefined }, // [lng, lat]
  },
  address: { type: String, trim: true, maxlength: 200, default: null },
  city:    { type: String, trim: true, maxlength: 80,  default: null },

  status: {
    type: String,
    enum: ['active', 'filled', 'expired', 'removed'],
    default: 'active',
    index: true,
  },

  // Boost / featured (one-off Paystack payment) — identical shape to Listing.
  featuredUntil:         { type: Date, index: true },
  lastFeaturedReference: { type: String, default: null },

  views: { type: Number, default: 0 },

  // Moderation
  reportCount:   { type: Number, default: 0 },
  isFlagged:     { type: Boolean, default: false, index: true },
  removedReason: { type: String, default: null },

  // Freshness — hidden from browse once past this; renew to extend.
  expiresAt: { type: Date, index: true },
}, { timestamps: true });

jobPostingSchema.index({ location: '2dsphere' });
jobPostingSchema.index({ title: 'text', description: 'text' });
jobPostingSchema.index({ kind: 1, status: 1, createdAt: -1 });

jobPostingSchema.virtual('isFeaturedNow').get(function () {
  return !!(this.featuredUntil && this.featuredUntil > new Date());
});

export default mongoose.model('JobPosting', jobPostingSchema);
