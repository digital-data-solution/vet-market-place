import mongoose from 'mongoose';

// An escrow agreement: a buyer pays for a service, funds are held until the
// buyer confirms completion, then released to the provider minus platform
// commission. This is the object commission revenue is earned on.
const bookingSchema = new mongoose.Schema({
  buyer:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

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

  fundedAt:   { type: Date },
  releasedAt: { type: Date },
  refundedAt: { type: Date },
}, { timestamps: true });

export default mongoose.model('Booking', bookingSchema);
