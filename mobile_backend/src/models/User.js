import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

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
  location: {
    type:        { type: String, default: 'Point' },
    coordinates: { type: [Number], index: '2dsphere' },
  },
  subscription: {
    plan:             { type: String, enum: ['user_monthly', 'basic'], default: null },
    status:           { type: String, enum: ['active', 'pending', 'cancelled', 'expired', 'inactive'], default: 'inactive' },
    startDate:        Date,
    endDate:          Date,
    paymentReference: String,
    amount:           Number,

    // ── ADDED: explicit field so Mongoose doesn't strip it on save ──────────
    // Grace window logic in subscriptionMiddleware.js and subscription.controller.js
    // both check this field first before falling back to createdAt/updatedAt.
    // Without this declared, Mongoose silently drops paymentInitiatedAt when
    // saving user.subscription, breaking the 30-minute grace window anchor.
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
}, { timestamps: true });

userSchema.index({ supabaseId: 1 }, { unique: true, sparse: true });

userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  if (this.password === 'supabase_managed') return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

export default mongoose.model('User', userSchema);