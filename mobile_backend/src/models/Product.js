import mongoose from 'mongoose';

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT — one inventory item (a thing the business stocks and sells).
// Tenant-isolated by `owner` (the User._id of the shop owner / vet). Stock
// quantity is the single source of truth for "how many left"; it is ONLY ever
// mutated through the business.controller helpers, each of which writes a
// matching StockMovement so every change is attributable (theft reduction).
// ─────────────────────────────────────────────────────────────────────────────
const productSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    name:     { type: String, required: true, trim: true, maxlength: 140 },
    sku:      { type: String, trim: true, default: null },   // optional shop code
    barcode:  { type: String, trim: true, default: null },
    category: { type: String, trim: true, default: null },
    unit:     { type: String, trim: true, default: 'unit' }, // bag / tin / sachet / kg …
    photo:    { type: String, default: null },

    costPrice: { type: Number, default: 0, min: 0 },  // what the owner paid (for profit calc)
    sellPrice: { type: Number, required: true, min: 0 }, // what customers pay

    quantity:           { type: Number, default: 0 },     // current stock on hand (roll-up of all active batches when tracked)
    lowStockThreshold:  { type: Number, default: 5, min: 0 },

    // Batch / lot + expiry tracking (opt-in per product — a vaccine needs it, a
    // leash doesn't). When on, each restock creates a Batch and sales deplete
    // batches in `stockPolicy` order. `quantity` above stays the roll-up total,
    // so all existing low-stock / reporting logic keeps working unchanged.
    trackBatches: { type: Boolean, default: false },
    stockPolicy:  { type: String, enum: ['FEFO', 'FIFO'], default: 'FEFO' }, // FEFO = earliest-expiry-first (vet/pharmacy default)

    isActive: { type: Boolean, default: true }, // soft delete — keeps sales history intact
  },
  { timestamps: true },
);

productSchema.index({ owner: 1, isActive: 1 });
productSchema.index({ owner: 1, name: 'text', sku: 'text', category: 'text' });

export default mongoose.model('Product', productSchema);
