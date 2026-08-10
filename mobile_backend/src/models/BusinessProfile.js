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

    // Extra identity for a professional-looking receipt / profile header.
    city:    { type: String, trim: true, maxlength: 80,  default: null },
    country: { type: String, trim: true, maxlength: 60,  default: null }, // e.g. "Saudi Arabia"
    website: { type: String, trim: true, maxlength: 200, default: null },

    // ── TAX (self-service — the business owns this) ──────────────────────────
    // The clinic sets its own tax because it knows its country's law better than
    // we do. We only carry the numbers and print them on the receipt. Xpress Vet
    // does NOT collect or remit any tax — that stays the business's obligation
    // (surfaced as a disclaimer in the app). In Saudi Arabia the receipt tax is
    // VAT (15%); Zakat is a separate yearly wealth tax, not a per-receipt line.
    tax: {
      enabled:   { type: Boolean, default: false },
      name:      { type: String, trim: true, maxlength: 20, default: 'VAT' }, // VAT | GST | Sales Tax | Zakat...
      rate:      { type: Number, min: 0, max: 100, default: 0 },  // percent, e.g. 15
      number:    { type: String, trim: true, maxlength: 40, default: null },  // tax/VAT registration number shown on receipt
      inclusive: { type: Boolean, default: false }, // true = displayed prices already include tax
    },
  },
  { timestamps: true },
);

export default mongoose.model('BusinessProfile', businessProfileSchema);
