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
    plan:             { type: String, enum: ['user_premium', 'user_monthly'], default: null },
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
  freeSearchUsed: { type: Boolean, default: false },
}, { timestamps: true });

userSchema.index({ supabaseId: 1 }, { unique: true, sparse: true });
userSchema.index({ location: '2dsphere' });

userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  if (this.password === 'supabase_managed') return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

export default mongoose.model('User', userSchema);