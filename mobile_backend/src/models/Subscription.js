import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // 'basic' = professional listing plan (₦3,000/month)
    // No other professional plans exist — premiumOnly/enterpriseOnly middleware
    // has been removed from active use since those tiers don't exist.
    plan: {
      type: String,
      enum: ['basic'],
      default: 'basic',
    },

    amount: {
      type: Number,
      required: true,
      default: 3000, // ₦3,000 — matches PLAN_PRICING.basic in controller
    },

    status: {
      type: String,
      // 'pending'   — payment initialized, not yet confirmed
      // 'active'    — payment confirmed, access granted
      // 'expired'   — past endDate
      // 'cancelled' — user cancelled (access retained until endDate)
      enum: ['pending', 'active', 'expired', 'cancelled'],
      default: 'pending',
    },

    startDate: { type: Date },
    endDate: { type: Date, required: true },

    paymentReference: { type: String, index: true },
  },
  { timestamps: true }
);

// Compound index: fast lookup for active subscription checks
subscriptionSchema.index({ user: 1, status: 1, endDate: 1 });

export default mongoose.model('Subscription', subscriptionSchema);