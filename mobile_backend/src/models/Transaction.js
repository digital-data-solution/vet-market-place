import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
  // Owning wallet. Optional: platform-commission rows are not tied to a user wallet.
  wallet: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet' },

  // Denormalised owner for easy history queries.
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  // The other party in an escrow/transfer (payer<->provider).
  counterparty: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  amount: { type: Number, required: true },
  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'payment_escrow', 'payment_release', 'commission', 'refund'],
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'reversed'],
    default: 'pending',
  },

  // Paystack (or internal) reference. Sparse+unique so many internal rows can omit it.
  reference: { type: String, unique: true, sparse: true },

  // Linked escrow agreement, if any.
  booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', index: true },

  metadata: {
    serviceId:   { type: mongoose.Schema.Types.ObjectId },
    description: String,
  },
}, { timestamps: true });

export default mongoose.model('Transaction', transactionSchema);
