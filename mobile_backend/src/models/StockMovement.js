import mongoose from 'mongoose';

// ─────────────────────────────────────────────────────────────────────────────
// STOCK MOVEMENT — the immutable audit trail. This is the theft-reduction spine.
//
// EVERY change to a product's quantity writes one of these, recording who did
// it, when, why, and the exact before/after numbers. These records are
// APPEND-ONLY: the controller never exposes an update or delete for them, so
// nobody — not even a rep with an account — can quietly rewrite history. The
// owner reads this ledger to see, and attribute, every unit that moved.
// ─────────────────────────────────────────────────────────────────────────────
const stockMovementSchema = new mongoose.Schema(
  {
    owner:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    // Snapshot of the name so the ledger stays readable even if the product is
    // later renamed or deleted.
    productName: { type: String, required: true },

    type: {
      type: String,
      enum: ['initial', 'restock', 'sale', 'return', 'adjustment', 'damage'],
      required: true,
    },
    quantityChange: { type: Number, required: true }, // signed: +restock/return, -sale/damage
    quantityBefore: { type: Number, required: true },
    quantityAfter:  { type: Number, required: true },

    unitCost:  { type: Number, default: null }, // snapshot for restock (profit calc)
    unitPrice: { type: Number, default: null }, // snapshot for sale
    reason:    { type: String, default: null }, // required by controller for adjustment/damage

    // Attribution — who moved the stock. null staff == the owner acted directly.
    staff:     { type: mongoose.Schema.Types.ObjectId, ref: 'StaffMember', default: null },
    staffName: { type: String, default: 'Owner' },

    // Links a movement back to the Sale it belonged to (for sale movements).
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale', default: null },
  },
  { timestamps: true }, // createdAt is the ledger timestamp; docs are never updated
);

stockMovementSchema.index({ owner: 1, createdAt: -1 });
stockMovementSchema.index({ product: 1, createdAt: -1 });
stockMovementSchema.index({ owner: 1, staff: 1, createdAt: -1 });

export default mongoose.model('StockMovement', stockMovementSchema);
