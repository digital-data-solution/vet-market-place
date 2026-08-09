import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const mediaImageSchema = new mongoose.Schema(
  {
    url:      { type: String, required: true },
    publicId: { type: String, required: true },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema({
  supabaseId: { type: String, unique: true, sparse: true },
  name:       { type: String, required: true },
  email:      { type: String, required: true, unique: true },
  password:   { type: String, required: true },
  role: {
    type:    String,
    enum:    ['pet_owner', 'vet', 'kennel_owner', 'shop_owner', 'admin'],
    default: 'pet_owner',
  },
  // Admin-dashboard access — independent of `role`, so a user can be e.g.
  // both a `vet` in the marketplace app and an admin of the dashboard.
  isAdmin: { type: Boolean, default: false },

  // Contact + bio. Must be declared or Mongoose (strict mode) silently drops
  // them on $set — the reason phone edits never persisted before.
  phone: { type: String, default: null },
  bio:   { type: String, default: null },

  // Profile photo (single, managed by ProfileImageUploader)
  profileImage:     { type: String, default: null },
  profileImagePath: { type: String, default: null }, // Cloudinary publicId for overwrite

  // Gallery images (array, managed by MediaUploader)
  mediaImages: { type: [mediaImageSchema], default: [] },

  location: {
    type:        { type: String, default: 'Point' },
    coordinates: { type: [Number] },
  },
  subscription: {
    // 'user_premium' = current paid plan (₦1,500/mo)
    // 'user_monthly' = legacy alias kept for existing records
    plan:             { type: String, enum: ['user_premium', 'user_monthly', 'user_plus'], default: null },
    status:           { type: String, enum: ['active', 'pending', 'cancelled', 'expired', 'inactive'], default: 'inactive' },
    startDate:        Date,
    endDate:          Date,
    paymentReference: String,
    amount:           Number,

    // Grace window anchor — must be declared or Mongoose silently drops it on save
    paymentInitiatedAt: Date,
  },
  isVerified: { type: Boolean, default: false },
  vetDetails: {
    vcnNumber:      String,
    licenseExpiry:  Date,
    specialization: [String],
  },
  vetVerification: {
    status:     { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    documents:  { type: [String], default: [] },
    adminNotes: String,
    verifiedAt: Date,
  },
  kennelDetails: {
    cacNumber: String,
    capacity:  Number,
  },
  freeSearchUsed:         { type: Boolean, default: false },
  lastLoginAt:            { type: Date,    default: null },

  // Referral system
  referralCode:           { type: String, unique: true, sparse: true },
  referredBy:             { type: String, default: null },
  referralRewardsEarned:  { type: Number, default: 0 },
  referralRewardApplied:  { type: Boolean, default: false },

  // UTM attribution — captured at first registration / first sync
  utm: {
    source:   { type: String, default: null },
    campaign: { type: String, default: null },
    medium:   { type: String, default: null },
  },

  // Re-engagement email gate — tracks when last re-engagement email was sent
  reEngagementSentAt: { type: Date, default: null },

  // Marketing email preferences. Missing/undefined on existing docs reads as
  // false, so pre-existing users keep receiving marketing mail by default —
  // matches how it already worked before this field existed. Set true only
  // via the public unsubscribe link (see routes/email.routes.js).
  marketingOptOut: { type: Boolean, default: false },
  // One-time promo gates — each fires at most once per user, ever.
  walletPromoSentAt: { type: Date, default: null },

  // Expo push notification token — saved from the device after permission granted
  pushToken: { type: String, default: null },

  // Business Suite add-on (inventory + POS + staff/reps). Same one-off-extend
  // pattern as Professional.practiceAddon / featuredUntil — paid time stacks
  // from the later of (now, existing activeUntil). Free tier still works up to
  // BUSINESS_FREE_PRODUCT_LIMIT products with no reps — see business.controller.js.
  businessAddon: {
    activeUntil:          { type: Date, default: null },
    lastPaymentReference: { type: String, default: null },
    // Paid staff seats beyond the free BUSINESS_INCLUDED_SEATS. Extended by
    // activateBusinessSeats (per-seat billing). seatRefs guards idempotency so
    // the same Paystack reference is never counted twice.
    seatsPaid:            { type: Number, default: 0 },
    seatRefs:             { type: [String], default: [] },
  },
  // One-time "try the Business Suite" promo email gate — fires at most once.
  businessPromoSentAt: { type: Date, default: null },

  // Enterprise hold — a big "whale" whose usage outgrew their plan. When active,
  // the app blocks NEW records (reads still work, so no data is lost) until they
  // move to an Enterprise plan. Set by admin (admin.grants) after usage flags
  // them or if they under-declared their size, forcing a pricing conversation.
  enterpriseHold: {
    active: { type: Boolean, default: false },
    reason: { type: String, default: null },
    setAt:  { type: Date, default: null },
  },
}, { timestamps: true });

userSchema.index({ supabaseId: 1 }, { unique: true, sparse: true });
userSchema.index({ location: '2dsphere' });

userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  if (this.password === 'supabase_managed') return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.pre('save', async function () {
  if (this.referralCode) return;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code, exists;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    exists = await this.constructor.exists({ referralCode: code });
  } while (exists);
  this.referralCode = code;
});

userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

export default mongoose.model('User', userSchema);