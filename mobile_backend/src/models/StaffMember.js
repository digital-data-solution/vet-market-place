import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// ─────────────────────────────────────────────────────────────────────────────
// STAFF MEMBER — a sales rep / cashier who works under a business owner.
//
// Reps are NOT platform (Supabase) accounts. The owner creates them here and
// gives each a short numeric PIN. On the shared shop device the rep "signs in"
// by entering their PIN (verified server-side against the bcrypt hash), which
// stamps their identity onto every sale and stock movement they make — the
// attribution the owner relies on to spot and deter theft.
// ─────────────────────────────────────────────────────────────────────────────
const staffSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 80 },
    role: { type: String, enum: ['rep', 'manager'], default: 'rep' },

    // bcrypt hash of the numeric PIN. select:false so it never leaves the server
    // by accident.
    pinHash: { type: String, required: true, select: false },

    isActive:     { type: Boolean, default: true },
    lastActiveAt: { type: Date, default: null },
  },
  { timestamps: true },
);

staffSchema.index({ owner: 1, isActive: 1 });

staffSchema.statics.hashPin = function (pin) {
  return bcrypt.hash(String(pin), 10);
};

staffSchema.methods.comparePin = function (pin) {
  return bcrypt.compare(String(pin), this.pinHash);
};

export default mongoose.model('StaffMember', staffSchema);
