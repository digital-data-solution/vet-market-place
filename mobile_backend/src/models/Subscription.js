import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  plan: { type: String, enum: ['basic', 'premium'], default: 'basic' },
  amount: { 
    type: Number, 
    required: true,
    default: function() { return this.plan === 'premium' ? 10000 : 5000; } // ₦5,000 basic, ₦10,000 premium
  },
  status: { type: String, enum: ['active', 'inactive', 'expired'], default: 'active' },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, required: true },
  paymentReference: { type: String } // Paystack reference
}, { timestamps: true });

export default mongoose.model('Subscription', subscriptionSchema);