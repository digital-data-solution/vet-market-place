import mongoose from 'mongoose';

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS PROFILE — per-business receipt identity + settings.
//
// Each owner customises how their receipts look: their own logo, header name,
// address, phone and footer note. Read when building a printable receipt
// (business.reports.controller.js). One doc per owner (tenant = User._id).
// ─────────────────────────────────────────────────────────────────────────────
const businessProfileSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

    headerName:  { type: String, trim: true, maxlength: 120, default: null }, // shop/clinic name on the receipt
    logoUrl:     { type: String, default: null },   // Cloudinary URL uploaded from the app
    addressLine: { type: String, trim: true, maxlength: 200, default: null },
    phone:       { type: String, trim: true, maxlength: 40, default: null },
    email:       { type: String, trim: true, maxlength: 120, default: null },
    footerNote:  { type: String, trim: true, maxlength: 300, default: 'Thank you for your patronage!' },
    receiptPrefix: { type: String, trim: true, maxlength: 8, default: null }, // e.g. "XV" → receipt no. XV-000123

    // Business day timezone offset in minutes from UTC. Nigeria (WAT) = +60,
    // Saudi Arabia (AST) = +180. Lets "today" and day-close respect the shop's
    // local midnight, not UTC — essential for international deployments.
    tzOffsetMinutes: { type: Number, default: 60 },

    // Currency + language so the same product works for a Lagos shop (₦, en) or
    // a Riyadh clinic (SAR, ar). Formatting/labels are applied client-side; these
    // just carry the business's choice. currencySymbol is what prints on receipts.
    currency:       { type: String, trim: true, uppercase: true, maxlength: 3, default: 'NGN' },
    currencySymbol: { type: String, trim: true, maxlength: 4, default: '₦' },
    locale:         { type: String, trim: true, maxlength: 5, default: 'en' }, // preferred UI/receipt language
  },
  { timestamps: true },
);

export default mongoose.model('BusinessProfile', businessProfileSchema);
