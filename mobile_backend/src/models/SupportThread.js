import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    text:       { type: String, required: true, trim: true, maxlength: 2000 },
    senderRole: { type: String, enum: ['user', 'admin', 'bot'], required: true },
  },
  { timestamps: true },
);

const supportThreadSchema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    userName:  { type: String, trim: true },
    userEmail: { type: String, trim: true, lowercase: true },
    userRole:  { type: String, trim: true },

    status: {
      type:    String,
      enum:    ['open', 'resolved'],
      default: 'open',
    },

    messages: [messageSchema],

    lastMessageAt:   { type: Date },
    adminNotifiedAt: { type: Date },
    needsHuman:      { type: Boolean, default: false },
  },
  { timestamps: true },
);

supportThreadSchema.index({ status: 1, lastMessageAt: -1 });

export default mongoose.model('SupportThread', supportThreadSchema);
