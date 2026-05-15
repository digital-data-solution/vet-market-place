import mongoose from 'mongoose';

const shopSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Shop name is required'],
      trim: true,
      maxlength: [100, 'Shop name cannot exceed 100 characters'],
      index: true,
    },
    ownerName: {
      type: String,
      trim: true,
      maxlength: [100, 'Owner name cannot exceed 100 characters'],
    },
    address: {
      type: String,
      required: [true, 'Address is required'],
      trim: true,
    },
    
    // Contact information
    phone: {
      type: String,
      trim: true,
      match: [/^[\d\s\+\-\(\)]+$/, 'Please provide a valid phone number'],
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    
    // Business details
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Description cannot exceed 500 characters'],
    },
    services: {
      type: [String],
      default: [],
    },
    
    // Geolocation
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        index: '2dsphere',
      },
    },
    
    // Verification status
    isVerified: {
      type: Boolean,
      default: true, // Auto-verify shops (set to false for manual verification)
      index: true,
    },
    
    // Business hours
    hours: {
      type: String,
      trim: true,
    },
    
    // Additional metadata
    rating: {
      type: Number,
      min: 0,
      max: 5,
      default: 0,
    },
    reviewCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    
    // Profile visibility
    isActive: {
      type: Boolean,
      default: true,
    },
    
    // Images
    images: [{
      type: String, // URLs to shop images
    }],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for efficient queries
shopSchema.index({ location: '2dsphere' });
shopSchema.index({ isVerified: 1, isActive: 1 });
shopSchema.index({ name: 'text', description: 'text', services: 'text' });

// Virtual for contact info
shopSchema.virtual('contact').get(function() {
  return this.phone || this.email;
});

const Shop = mongoose.model('Shop', shopSchema);

export default Shop;