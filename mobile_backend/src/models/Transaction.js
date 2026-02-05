import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
  wallet: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true },
  amount: { type: Number, required: true },
  type: {
    type: String,
    enum: ['deposit', 'withdrawal', 'payment_escrow', 'payment_release', 'commission'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'reversed'],
    default: 'pending'
  },
  reference: { type: String, unique: true }, // Paystack/Flutterwave reference
  metadata: {
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
    description: String
  }
}, { timestamps: true });

export default mongoose.model('Transaction', transactionSchema);