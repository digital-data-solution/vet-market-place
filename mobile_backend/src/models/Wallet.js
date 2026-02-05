import mongoose from 'mongoose';

const walletSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  balance: { type: Number, default: 0 },
  escrowBalance: { type: Number, default: 0 }, // Funds held until service is done
  currency: { type: String, default: 'NGN' },
}, { timestamps: true });

export default mongoose.model('Wallet', walletSchema);