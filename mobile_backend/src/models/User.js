import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  supabaseId: { type: String, unique: true, sparse: true },  // Supabase UUID
  name:       { type: String, required: true },
  email:      { type: String, required: true, unique: true },
  password:   { type: String, required: true },              // 'supabase_managed' for OAuth users
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
  },
  isVerified: { type: Boolean, default: false },
  vetDetails: {
    vcnNumber:      String,
    licenseExpiry:  Date,
    specialization: [String],
  },
  vetVerification: {
    status:    { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    documents: { type: [String], default: [] },
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
  // Don't hash the placeholder value
  if (this.password === 'supabase_managed') return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

export default mongoose.model('User', userSchema);