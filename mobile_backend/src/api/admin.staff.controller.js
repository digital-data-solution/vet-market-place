/**
 * admin.staff.controller.js — owner-only staff-account management. Creating
 * or editing a staff account (including its module grants) is intentionally
 * NEVER available to a staff account itself, no matter what modules it has —
 * see requireOwner in middlewares/adminAuthMiddleware.js.
 */
import crypto from 'crypto';
import AdminStaffAccount from '../models/AdminStaffAccount.js';
import { MODULES, MODULE_KEYS } from '../config/adminModules.js';
import { disable as disableTwoFactorOn } from '../services/twoFactor.service.js';
import logger from '../lib/logger.js';

/**
 * GET /api/admin/staff/modules — the label list for the checkbox grid.
 * Not owner-gated (adminProtect only) — a staff account's own dashboard also
 * uses this to render section labels/nav from its granted module keys.
 */
export const listModules = async (_req, res) => {
  return res.json({ success: true, data: MODULES });
};

/**
 * GET /api/admin/staff — owner only.
 */
export const listStaff = async (_req, res) => {
  try {
    const staff = await AdminStaffAccount.find().select('-password').sort({ createdAt: -1 }).lean();
    return res.json({ success: true, data: staff });
  } catch (error) {
    logger.error('listStaff error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load staff accounts.' });
  }
};

function randomTempPassword() {
  // 10 url-safe chars — readable enough to relay verbally/by chat, random
  // enough not to matter that it's short-lived (mustChangePassword forces a
  // real one on first login).
  return crypto.randomBytes(8).toString('base64url').slice(0, 10);
}

/**
 * POST /api/admin/staff — owner only.
 * Body: { name, email, role?, modules?: string[] }
 * Password is always generated server-side (never accepted from the
 * request) and returned once in the response for the owner to relay —
 * mustChangePassword forces the staff member to set their own on first
 * login, so nobody but them ever knows their real working password.
 */
export const createStaff = async (req, res) => {
  try {
    const { name, email, role, modules } = req.body;
    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({ success: false, message: 'Name and email are required.' });
    }
    const cleanModules = Array.isArray(modules) ? modules.filter((m) => MODULE_KEYS.includes(m)) : [];

    const existing = await AdminStaffAccount.exists({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'A staff account with this email already exists.' });
    }

    const tempPassword = randomTempPassword();
    const staff = await AdminStaffAccount.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: tempPassword, // hashed by the model's pre-save hook
      role: role?.trim() || '',
      modules: cleanModules,
      mustChangePassword: true,
      createdByEmail: req.user?.email || null,
    });

    logger.info('Staff account created', { staffId: staff._id, email: staff.email, modules: cleanModules, by: req.user?.email });

    return res.status(201).json({
      success: true,
      message: 'Staff account created.',
      data: {
        _id: staff._id, name: staff.name, email: staff.email, role: staff.role, modules: staff.modules,
        tempPassword, // shown once — not retrievable again
      },
    });
  } catch (error) {
    logger.error('createStaff error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to create staff account.' });
  }
};

/**
 * PUT /api/admin/staff/:id — owner only.
 * Body: { name?, role?, modules?, isActive? }
 */
export const updateStaff = async (req, res) => {
  try {
    const staff = await AdminStaffAccount.findById(req.params.id);
    if (!staff) return res.status(404).json({ success: false, message: 'Staff account not found.' });

    const { name, role, modules, isActive } = req.body;
    if (name !== undefined) staff.name = name.trim();
    if (role !== undefined) staff.role = role.trim();
    if (modules !== undefined) staff.modules = Array.isArray(modules) ? modules.filter((m) => MODULE_KEYS.includes(m)) : [];
    if (isActive !== undefined) staff.isActive = !!isActive;

    await staff.save();
    logger.info('Staff account updated', { staffId: staff._id, by: req.user?.email });

    const { password, ...safe } = staff.toObject();
    return res.json({ success: true, data: safe });
  } catch (error) {
    logger.error('updateStaff error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to update staff account.' });
  }
};

/**
 * POST /api/admin/staff/:id/reset-password — owner only. Generates a fresh
 * temp password and forces mustChangePassword again — same one-time-reveal
 * shape as createStaff.
 */
export const resetStaffPassword = async (req, res) => {
  try {
    const staff = await AdminStaffAccount.findById(req.params.id);
    if (!staff) return res.status(404).json({ success: false, message: 'Staff account not found.' });

    const tempPassword = randomTempPassword();
    staff.password = tempPassword;
    staff.mustChangePassword = true;
    await staff.save();

    logger.info('Staff password reset', { staffId: staff._id, by: req.user?.email });
    return res.json({ success: true, message: 'Password reset.', data: { tempPassword } });
  } catch (error) {
    logger.error('resetStaffPassword error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to reset password.' });
  }
};

/**
 * POST /api/admin/staff/:id/reset-2fa — owner only.
 * Recovery path for a staff member who's lost their authenticator device AND
 * exhausted their 8 backup codes — the one real gap flagged when 2FA shipped
 * (see memory: no recovery route existed at all). This just turns 2FA back
 * off for them (clears the secret + any remaining backup codes) — it does
 * NOT re-enable it. They log in with just their password afterward and can
 * re-enroll 2FA from scratch via the normal self-service setup/confirm flow
 * whenever they're ready. Does not touch their password or module grants.
 */
export const resetStaffTwoFactor = async (req, res) => {
  try {
    const staff = await AdminStaffAccount.findById(req.params.id);
    if (!staff) return res.status(404).json({ success: false, message: 'Staff account not found.' });

    await disableTwoFactorOn(staff);

    logger.info('Staff 2FA reset by owner', { staffId: staff._id, by: req.user?.email });
    return res.json({ success: true, message: '2FA has been turned off for this account. They can log in with just their password and re-enroll whenever ready.' });
  } catch (error) {
    logger.error('resetStaffTwoFactor error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to reset 2FA.' });
  }
};

/**
 * DELETE /api/admin/staff/:id — owner only. Hard delete — a staff account
 * carries no data of its own (just credentials + module grants), unlike
 * User, so there's nothing to orphan.
 */
export const deleteStaff = async (req, res) => {
  try {
    await AdminStaffAccount.findByIdAndDelete(req.params.id);
    logger.info('Staff account deleted', { staffId: req.params.id, by: req.user?.email });
    return res.json({ success: true, message: 'Staff account deleted.' });
  } catch (error) {
    logger.error('deleteStaff error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to delete staff account.' });
  }
};
