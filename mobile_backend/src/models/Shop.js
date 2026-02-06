import mongoose from 'mongoose';

const shopSchema = new mongoose.Schema({
  name: { type: String, required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  address: String,
  contact: String,
  services: [String],
  isVerified: { type: Boolean, default: false },
  location: {
    type: { type: String, default: 'Point' },
    coordinates: { type: [Number], index: '2dsphere' } // [lng, lat]
  }
}, { timestamps: true });

export default mongoose.model('Shop', shopSchema);
