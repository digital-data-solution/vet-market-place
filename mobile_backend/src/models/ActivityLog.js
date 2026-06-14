import mongoose from 'mongoose';

const activityLogSchema = new mongoose.Schema({
  user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  userRole:  { type: String, default: null },
  action:    { type: String, required: true, index: true },
  metadata:  { type: mongoose.Schema.Types.Mixed, default: {} },
  ip:        { type: String, default: null },
  userAgent: { type: String, default: null },
  timestamp: { type: Date, default: Date.now, index: true },
}, { timestamps: false });

// Compound indexes for the most common admin queries
activityLogSchema.index({ action: 1, timestamp: -1 });
activityLogSchema.index({ user: 1, timestamp: -1 });

// Auto-expire logs after 180 days — prevents unbounded collection growth
activityLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

export default mongoose.model('ActivityLog', activityLogSchema);
