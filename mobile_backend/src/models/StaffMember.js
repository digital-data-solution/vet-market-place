import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// ─────────────────────────────────────────────────────────────────────────────
// STAFF MEMBER — a sales rep / cashier / vet who works under a business owner.
//
// Reps are NOT platform (Supabase) accounts — the OWNER creates and fully
// controls them here. Two sign-in modes, both attribute every action to the
// person:
//   • Shared device: a short numeric PIN in the BusinessScreen switcher.
//   • Own phone: an individual username + password (StaffLoginScreen), which
//     mints a scoped token (see lib/staffToken.js) used on /business/* calls.
// Per-feature `permissions` scope what each person can do. This attribution +
// scoping is the accountability the owner relies on to deter theft.
// ─────────────────────────────────────────────────────────────────────────────
const permissionsSchema = new mongoose.Schema(
  {
    sell:            { type: Boolean, default: true },
    viewReports:     { type: Boolean, default: false },
    manageInventory: { type: Boolean, default: false },
    adjustStock:     { type: Boolean, default: false },
    manageStaff:     { type: Boolean, default: false },
    dispense:        { type: Boolean, default: false },
  },
  { _id: false },
);

const staffSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 80 },
    role: { type: String, enum: ['rep', 'manager'], default: 'rep' },

    // Individual own-phone login (owner-created, owner-resettable). username is
    // globally unique so a staff member can log in without also naming their
    // shop. Both select:false so they never leave the server by accident.
    username:     { type: String, trim: true, lowercase: true, unique: true, sparse: true },
    passwordHash: { type: String, select: false, default: null },

    // Shared-device PIN. Optional now — a staff member may have a password, a
    // PIN, or both.
    pinHash: { type: String, select: false, default: null },

    permissions: { type: permissionsSchema, default: () => ({}) },

    isActive:     { type: Boolean, default: true },
    lastActiveAt: { type: Date, default: null },
  },
  { timestamps: true },
);

staffSchema.index({ owner: 1, isActive: 1 });

staffSchema.statics.hashPin      = function (pin)      { return bcrypt.hash(String(pin), 10); };
staffSchema.statics.hashPassword = function (password) { return bcrypt.hash(String(password), 10); };

staffSchema.methods.comparePin      = function (pin)      { return this.pinHash ? bcrypt.compare(String(pin), this.pinHash) : Promise.resolve(false); };
staffSchema.methods.comparePassword = function (password) { return this.passwordHash ? bcrypt.compare(String(password), this.passwordHash) : Promise.resolve(false); };

export default mongoose.model('StaffMember', staffSchema);
