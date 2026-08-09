import mongoose from 'mongoose';

// ─────────────────────────────────────────────────────────────────────────────
// DAY CLOSE — an end-of-day snapshot ("Z report"). One per owner per business
// day. Closing the day freezes that day's numbers so monthly balancing is just
// a sum of closes — no re-litigating past days.
//
// The `variance` field is the anti-argument feature: the system knows how much
// cash SHOULD be in the drawer; the owner enters what they COUNTED; the
// difference is recorded plainly. No disputes, just a number.
// ─────────────────────────────────────────────────────────────────────────────
const dayCloseSchema = new mongoose.Schema(
  {
    owner:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    dateStr: { type: String, required: true }, // business day 'YYYY-MM-DD' in the shop's timezone

    salesCount:    { type: Number, default: 0 },
    gross:         { type: Number, default: 0 }, // sum of subtotals (before discount)
    discountTotal: { type: Number, default: 0 },
    net:           { type: Number, default: 0 }, // sum of totals (what customers paid)
    costTotal:     { type: Number, default: 0 },
    profit:        { type: Number, default: 0 }, // net - costTotal

    // Money in by method (net totals attributed to how they paid)
    byMethod: {
      cash:     { type: Number, default: 0 },
      transfer: { type: Number, default: 0 },
      card:     { type: Number, default: 0 },
      wallet:   { type: Number, default: 0 },
      credit:   { type: Number, default: 0 },
    },
    // Per-staff attribution for the day
    byStaff: [{ staffName: String, count: Number, revenue: Number, _id: false }],

    // Cash reconciliation
    openingFloat: { type: Number, default: 0 },  // cash placed in the drawer at open
    expectedCash: { type: Number, default: 0 },  // openingFloat + cash sales
    countedCash:  { type: Number, default: null }, // what the owner physically counted
    variance:     { type: Number, default: 0 },  // countedCash - expectedCash (negative = short)

    closedByName: { type: String, default: 'Owner' },
    closedAt:     { type: Date,   default: Date.now },
    note:         { type: String, trim: true, maxlength: 300, default: null },
  },
  { timestamps: true },
);

dayCloseSchema.index({ owner: 1, dateStr: 1 }, { unique: true }); // one close per day, re-close overwrites
dayCloseSchema.index({ owner: 1, closedAt: -1 });

export default mongoose.model('DayClose', dayCloseSchema);
