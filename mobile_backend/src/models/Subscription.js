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
    //   'user_premium' (₦1,500/mo) – pet owner: full contact details + GPS search
    //   'user_plus'    (₦3,500/mo) – pet owner: Premium + badge + priority support
    //   'starter'      (₦2,500/mo) – professional listed in search results
    //   'pro'          (₦5,000/mo) – professional featured + sorted first
    //   'basic' / 'user_monthly'   – legacy aliases kept for existing records
    plan: {
      type: String,
      enum: ['user_premium', 'user_plus', 'starter', 'pro', 'basic', 'user_monthly'],
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
    paymentInitiatedAt:      { type: Date },
    abandonedReminderSentAt: { type: Date, default: null },

    // ── Auto-renew (opt-in) ──────────────────────────────────────────────────
    // authorizationCode is only ever set when Paystack marks the card used to
    // pay as `reusable: true` (card channel only — bank transfer/USSD/QR never
    // qualify). autoRenew can only be toggled on when a code is present; see
    // setAutoRenew in subscription.controller.js. jobs/autoRenewSubscriptions.js
    // charges this code on the day the subscription is due to expire.
    authorizationCode:      { type: String, default: null },
    cardLast4:              { type: String, default: null },
    cardBrand:              { type: String, default: null },
    autoRenew:              { type: Boolean, default: false },
    autoRenewFailCount:     { type: Number, default: 0 },
    lastAutoRenewAttemptAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Compound index: fast lookup for active subscription checks
subscriptionSchema.index({ user: 1, status: 1, endDate: 1 });

export default mongoose.model('Subscription', subscriptionSchema);