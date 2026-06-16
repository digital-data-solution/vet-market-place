import mongoose from 'mongoose';

const professionalSchema = new mongoose.Schema(
  {
    // Images (profile photos)
    images: [{
      type: String,
    }],
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
      enum: [
        'vet',
        'kennel',
        'groomer',
        'trainer',
        'pet_sitter',
        'pet_transport',
        'cremation_service',
        'agro_vet_supplier',
        'insurance_provider',
        'pet_pharmacy',
        'rescue_center',
        'pet_hotel',
        'farm',
      ],
      required: [true, 'Role is required'],
      index: true,
    },

    // Vet-specific fields
    vcnNumber: {
      type: String,
      trim: true,
      uppercase: true,
      unique: true,
      sparse: true,
      validate: {
        validator: function(v) {
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

    // Identity / compliance documents submitted at onboarding
    verificationDocuments: {
      governmentIdType:   { type: String, trim: true },  // NIN / BVN / Passport
      governmentIdNumber: { type: String, trim: true },
      cacNumber:          { type: String, trim: true },  // CAC reg for business roles
      professionalCertNumber: { type: String, trim: true }, // groomer/trainer cert
      additionalNotes:    { type: String, trim: true },
    },

    // Profile visibility
    isActive: {
      type: Boolean,
      default: true,
    },

    // Analytics
    profileViews: {
      type:    Number,
      default: 0,
      min:     0,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ============================================================================
// INDEXES
// ============================================================================

professionalSchema.index({ role: 1, isVerified: 1 });
professionalSchema.index({ location: '2dsphere' });
professionalSchema.index({ name: 'text', businessName: 'text', specialization: 'text' });

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Roles that require admin review before going live.
// Higher-risk or credential-dependent roles sit in pending until an admin approves.
const REQUIRES_ADMIN_REVIEW = new Set([
  'vet',               // VCN verification required
  'insurance_provider', // regulatory approval required
  'pet_transport',     // animals in transit — liability risk
  'cremation_service', // handling deceased animals — trust-sensitive
  'agro_vet_supplier', // sells medications/supplements — regulatory risk
  'pet_pharmacy',      // NAFDAC/PCN pharmacy license required
  'rescue_center',     // animal welfare body registration required
  'farm',              // livestock/animal sale — trust-sensitive, business registration required
]);

// Auto-approval logic — this hook is the single source of truth for
// verification status on new profiles. Never set isVerified in controllers.
professionalSchema.pre('save', async function () {
  if (this.isNew) {
    if (REQUIRES_ADMIN_REVIEW.has(this.role)) {
      this.isVerified        = false;
      this.verificationStatus = 'pending';
    } else {
      this.isVerified        = true;
      this.verificationStatus = 'approved';
      this.verifiedAt        = new Date();
    }
  }
});

// ============================================================================
// VIRTUALS
// ============================================================================

professionalSchema.virtual('displayName').get(function() {
  return this.businessName || this.name;
});

const Professional = mongoose.model('Professional', professionalSchema);

export default Professional;