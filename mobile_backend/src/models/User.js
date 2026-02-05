import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: {
    type: String,
    enum: ['pet_owner', 'vet', 'kennel_owner', 'admin'],
    default: 'pet_owner'
  },
  location: {
    type: { type: String, default: 'Point' },
    coordinates: { type: [Number], index: '2dsphere' } // [longitude, latitude]
  },
  // Professional Verification Fields
  isVerified: { type: Boolean, default: false },
  vetDetails: {
    vcnNumber: { type: String }, // Veterinary Council of Nigeria ID
    licenseExpiry: Date,
    specialization: [String]
  },
  kennelDetails: {
    cacNumber: { type: String }, // Corporate Affairs Commission Number
    capacity: Number
  }
}, { timestamps: true });

// Pre-save Middleware: Auto-hash password
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

// Compare password method
userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

export default mongoose.model('User', userSchema);
