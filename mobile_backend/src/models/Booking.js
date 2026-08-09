import mongoose from 'mongoose';

// An escrow agreement: a buyer pays for a service, funds are held until the
// buyer confirms completion, then released to the provider minus platform
// commission. This is the object commission revenue is earned on.
const bookingSchema = new mongoose.Schema({
  buyer:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  // What is being paid for. 'service' = paying a registered professional/shop
  // (the original flow); 'listing' = buying a marketplace item (pet/product),
  // where `listing` points at the item and `provider` is the seller (any user).
  kind:    { type: String, enum: ['service', 'listing'], default: 'service' },
  listing: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', default: null },

  amount:           { type: Number, required: true },     // total the buyer pays
  commissionRate:   { type: Number, required: true },     // e.g. 0.10
  commissionAmount: { type: Number, required: true },     // platform cut
  providerAmount:   { type: Number, required: true },     // amount - commission

  description: { type: String, trim: true, maxlength: 300 },

  status: {
    type: String,
    enum: ['pending_payment', 'funded', 'released', 'refunded', 'cancelled', 'disputed'],
    default: 'pending_payment',
    index: true,
  },

  // If still 'funded' when this passes, the auto-release job pays the
  // provider automatically — protects providers from buyers who never
  // tap Release. Cleared (not enforced) once disputed.
  autoReleaseAt: { type: Date, index: true },

  // Set when the buyer reports a problem instead of releasing — freezes
  // the booking so neither side can self-serve release/refund; only an
  // admin can resolve it from here. See admin.wallet.controller.js.
  disputeReason: { type: String, trim: true, maxlength: 500 },
  disputedAt:    { type: Date },
  disputedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  adminNote:     { type: String, trim: true, maxlength: 500 },

  fundedAt:   { type: Date },
  releasedAt: { type: Date },
  refundedAt: { type: Date },
}, { timestamps: true });

export default mongoose.model('Booking', bookingSchema);
