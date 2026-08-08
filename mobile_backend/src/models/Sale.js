import mongoose from 'mongoose';

// ─────────────────────────────────────────────────────────────────────────────
// SALE — one point-of-sale transaction (a receipt). Recording a sale decrements
// each line item's stock (via a StockMovement) so inventory stays live, and is
// stamped with the staff member who made it for per-rep tracking.
// ─────────────────────────────────────────────────────────────────────────────
const saleItemSchema = new mongoose.Schema(
  {
    product:     { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true }, // snapshot
    quantity:    { type: Number, required: true, min: 1 },
    unitPrice:   { type: Number, required: true, min: 0 },
    unitCost:    { type: Number, default: 0 },      // snapshot for profit reporting
    lineTotal:   { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const saleSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    items:    { type: [saleItemSchema], required: true },
    subtotal: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    total:    { type: Number, required: true, min: 0 },
    costTotal:{ type: Number, default: 0 }, // sum of unitCost*qty — for profit
    amountPaid: { type: Number, default: 0, min: 0 },

    paymentMethod: {
      type: String,
      enum: ['cash', 'transfer', 'card', 'wallet', 'credit'],
      default: 'cash',
    },

    // Light CRM — capture the customer if the shop wants to.
    customerName:  { type: String, trim: true, default: null },
    customerPhone: { type: String, trim: true, default: null },

    // Attribution — who rang it up. null == the owner sold directly.
    staff:     { type: mongoose.Schema.Types.ObjectId, ref: 'StaffMember', default: null },
    staffName: { type: String, default: 'Owner' },

    note: { type: String, trim: true, default: null },
  },
  { timestamps: true },
);

saleSchema.index({ owner: 1, createdAt: -1 });
saleSchema.index({ owner: 1, staff: 1, createdAt: -1 });
saleSchema.index({ owner: 1, customerPhone: 1 });

export default mongoose.model('Sale', saleSchema);
