import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { MODULE_KEYS } from '../config/adminModules.js';

// A scoped admin-dashboard login, separate from the User collection's
// isAdmin flag (which stays the "owner" tier — always full access, no
// module check, see adminAuthMiddleware.js's requireOwner/adminProtect).
//
// `role` and `modules` do two DIFFERENT jobs — don't conflate them:
//   - role:    free-text job title (e.g. "Support Agent"), DISPLAY ONLY,
//              has zero effect on what the account can actually reach.
//   - modules: array of MODULE_KEYS — this is what actually governs access.
//              Full read+write within any granted module, nothing implicit
//              outside it.
const adminStaffAccountSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true, maxlength: 100 },
  email:    { type: String, required: true, trim: true, lowercase: true, unique: true },
  password: { type: String, required: true }, // bcrypt hash — see pre-save hook

  role: { type: String, trim: true, maxlength: 80, default: '' },

  modules: { type: [String], enum: MODULE_KEYS, default: [] },

  // Owner can revoke instantly — checked fresh on every gated request, never
  // trusted from the JWT (a revoked account is blocked mid-token-life, not
  // just at next login attempt). See adminProtect.
  isActive: { type: Boolean, default: true },

  // Set true whenever the owner (re)sets this account's password — forces a
  // change on next login before the dashboard is usable. Cleared by
  // admin.auth.controller.js's changePassword once they set their own.
  mustChangePassword: { type: Boolean, default: true },

  lastLoginAt: { type: Date, default: null },

  createdByEmail: { type: String, default: null }, // owner's email, audit trail

  // TOTP 2FA — same shape/fields as User.js's owner-tier ones, kept
  // identical on purpose so services/twoFactor.service.js works against
  // either document type without caring which tier it's touching.
  twoFactorEnabled:       { type: Boolean, default: false },
  twoFactorSecret:        { type: String, default: null, select: false },
  twoFactorPendingSecret: { type: String, default: null, select: false },
  twoFactorBackupCodes:   { type: [String], default: [], select: false },
}, { timestamps: true });

adminStaffAccountSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

adminStaffAccountSchema.methods.comparePassword = async function (password) {
  return bcrypt.compare(password, this.password);
};

export default mongoose.model('AdminStaffAccount', adminStaffAccountSchema);
