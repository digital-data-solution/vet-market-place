import mongoose from 'mongoose';

const professionalSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    role: {
      type: String,
      enum: ['vet', 'kennel'],
      required: [true, 'Role is required'],
      index: true,
    },
    
    // Vet-specific fields
    vcnNumber: {
      type: String,
      trim: true,
      uppercase: true,
      unique: true,
      sparse: true, // Allows null values but enforces uniqueness when present
      validate: {
        validator: function(v) {
          // Only validate if role is vet
          if (this.role === 'vet') {
            return v && v.length > 0;
          }
          return true;
        },
        message: 'VCN number is required for veterinarians'
      }
    },
    
    // Common fields
    businessName: {
      type: String,
      trim: true,
      maxlength: [150, 'Business name cannot exceed 150 characters'],
    },
    address: {
      type: String,
      required: [true, 'Address is required'],
      trim: true,
    },
    specialization: {
      type: String,
      trim: true,
      maxlength: [200, 'Specialization cannot exceed 200 characters'],
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
      default: false,
      index: true,
    },
    verificationStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    verifiedAt: {
      type: Date,
    },
    adminNotes: {
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
    consultationFee: {
      type: Number,
      min: 0,
    },
    availability: {
      type: String,
      trim: true,
    },
    
    // Profile visibility
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for efficient queries
professionalSchema.index({ role: 1, isVerified: 1 });
professionalSchema.index({ location: '2dsphere' });
professionalSchema.index({ vcnNumber: 1 }, { sparse: true });
professionalSchema.index({ name: 'text', businessName: 'text', specialization: 'text' });

// Pre-save middleware: Auto-approve kennels, vets need admin approval
professionalSchema.pre('save', function(next) {
  if (this.isNew) {
    if (this.role === 'kennel') {
      this.isVerified = true;
      this.verificationStatus = 'approved';
      this.verifiedAt = new Date();
    } else if (this.role === 'vet') {
      this.isVerified = false;
      this.verificationStatus = 'pending';
    }
  }
  next();
});

// Virtual for full display name
professionalSchema.virtual('displayName').get(function() {
  return this.businessName || this.name;
});

const Professional = mongoose.model('Professional', professionalSchema);

export default Professional;