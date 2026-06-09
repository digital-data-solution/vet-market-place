import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // Plan tiers:
    //   'starter' (₦2,500/mo) – professional listed in search
    //   'pro'     (₦5,000/mo) – professional featured + sorted first
    //   'basic'               – legacy alias for 'starter' (kept for existing records)
    plan: {
      type: String,
      enum: ['starter', 'pro', 'basic'],
      default: 'starter',
    },

    amount: {
      type: Number,
      required: true,
      default: 2500,
    },

    status: {
      type: String,
      enum: ['pending', 'active', 'expired', 'cancelled', 'inactive'],
      default: 'pending',
    },

    startDate: { type: Date },
    endDate:   { type: Date, required: true },

    paymentReference: { type: String, index: true },

    // ── ADDED: explicit field so Mongoose doesn't strip it on save ──────────
    // Grace window logic in subscriptionMiddleware.js and subscription.controller.js
    // both check this field first before falling back to createdAt/updatedAt.
    // Without this field declared here, Mongoose silently drops it when saving
    // a new Subscription document, breaking the 30-minute grace window anchor.
    paymentInitiatedAt: { type: Date },
  },
  { timestamps: true },
);

// Compound index: fast lookup for active subscription checks
subscriptionSchema.index({ user: 1, status: 1, endDate: 1 });

export default mongoose.model('Subscription', subscriptionSchema);