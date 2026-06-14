import mongoose from 'mongoose';

const reviewSchema = new mongoose.Schema(
  {
    // 'professional' → Professional document; 'shop' → Shop document
    targetType: {
      type:     String,
      enum:     ['professional', 'shop'],
      required: true,
    },
    // ObjectId of the Professional or Shop being reviewed
    targetId: {
      type:     mongoose.Schema.Types.ObjectId,
      required: true,
    },
    // The user who wrote this review
    reviewer: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    rating: {
      type:     Number,
      required: true,
      min:      1,
      max:      5,
    },
    comment: {
      type:      String,
      trim:      true,
      maxlength: 1000,
      default:   null,
    },
    // Optional reply from the professional/shop owner
    professionalResponse: {
      type:      String,
      trim:      true,
      maxlength: 1000,
      default:   null,
    },
    professionalResponseAt: {
      type:    Date,
      default: null,
    },
  },
  { timestamps: true },
);

// One review per user per listing — updates go through findOneAndUpdate (upsert)
reviewSchema.index(
  { reviewer: 1, targetType: 1, targetId: 1 },
  { unique: true },
);

// Efficient reads on the public review list endpoint
reviewSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

export default mongoose.model('Review', reviewSchema);
