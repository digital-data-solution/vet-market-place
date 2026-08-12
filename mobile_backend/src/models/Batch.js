import mongoose from 'mongoose';

// ─────────────────────────────────────────────────────────────────────────────
// BATCH — one received lot of a batch-tracked Product (Product.trackBatches).
// Enables FEFO (earliest-expiry-first, the vet/pharmacy default) and FIFO
// (earliest-received-first) consumption, plus expiry alerts. Each restock of a
// tracked product creates one Batch; sales deplete batches in the product's
// stockPolicy order. `quantity` here is the REMAINING units in this lot; the
// sum of a product's active batch quantities equals Product.quantity.
// Tenant-isolated by `owner` (the business owner's User._id).
// ─────────────────────────────────────────────────────────────────────────────
const batchSchema = new mongoose.Schema(
  {
    owner:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    productName: { type: String, default: '' }, // denormalised for expiry reports

    lotNumber:  { type: String, trim: true, default: null }, // manufacturer lot/batch no.
    expiryDate: { type: Date, default: null },               // null = non-expiring lot

    quantity:  { type: Number, default: 0, min: 0 }, // units remaining in this lot
    received:  { type: Number, default: 0, min: 0 }, // units originally received (audit)
    costPrice: { type: Number, default: 0, min: 0 }, // per-unit cost for this lot

    isActive: { type: Boolean, default: true }, // false once depleted or written off
  },
  { timestamps: true },
);

batchSchema.index({ owner: 1, product: 1, quantity: 1 });
batchSchema.index({ owner: 1, product: 1, expiryDate: 1 }); // FEFO ordering
batchSchema.index({ owner: 1, product: 1, createdAt: 1 });  // FIFO ordering
batchSchema.index({ owner: 1, expiryDate: 1, quantity: 1 }); // expiry report

export default mongoose.model('Batch', batchSchema);
