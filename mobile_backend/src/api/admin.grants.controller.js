// ─────────────────────────────────────────────────────────────────────────────
// ADMIN GRANTS — manually grant/extend a paid add-on after an off-platform
// payment (e.g. an international clinic that paid by bank transfer / Wise, which
// Paystack can't process). Mirrors the "one-off-extend" pattern used by the
// Paystack webhook: paid time stacks from the later of (now, existing end).
//
// Admin-only (adminProtect). Looked up by the account's email so support can act
// with just the customer's email. Every grant is logged for accountability.
// ─────────────────────────────────────────────────────────────────────────────
import User from '../models/User.js';
import logger from '../lib/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function extendFrom(existing, days) {
  const base = existing && new Date(existing) > new Date() ? new Date(existing) : new Date();
  return new Date(base.getTime() + Math.max(1, Number(days) || 0) * DAY_MS);
}

async function findAccount(body) {
  const email = (body.email || '').trim().toLowerCase();
  if (email) return User.findOne({ email });
  if (body.userId) return User.findById(body.userId);
  return null;
}

// POST /api/admin/grants/business  { email | userId, days, seats?, note? }
export const grantBusinessAddon = async (req, res) => {
  try {
    const days = Number(req.body.days);
    if (!days || days < 1) return res.status(400).json({ success: false, message: 'Provide days (>= 1).' });

    const user = await findAccount(req.body);
    if (!user) return res.status(404).json({ success: false, message: 'No account found for that email.' });

    user.businessAddon = user.businessAddon || {};
    const before = user.businessAddon.activeUntil;
    user.businessAddon.activeUntil = extendFrom(before, days);

    const addSeats = Math.max(0, Number(req.body.seats) || 0);
    if (addSeats) user.businessAddon.seatsPaid = (user.businessAddon.seatsPaid || 0) + addSeats;
    user.businessAddon.lastPaymentReference = `admin-grant-${Date.now()}`;

    await user.save();
    logger.info('Admin granted Business Suite', {
      admin: req.admin?.email || req.admin?.id, email: user.email, days, seats: addSeats,
      until: user.businessAddon.activeUntil, note: req.body.note || null,
    });
    res.json({ success: true, message: `Granted ${days} days${addSeats ? ` + ${addSeats} seat(s)` : ''} to ${user.email}.`,
      data: { email: user.email, activeUntil: user.businessAddon.activeUntil, seatsPaid: user.businessAddon.seatsPaid } });
  } catch (error) {
    logger.error('grantBusinessAddon error', { error: error.message });
    res.status(500).json({ success: false, message: 'Could not grant the subscription.' });
  }
};

// GET /api/admin/grants/lookup?email=  — see an account's current add-on status
export const lookupAccount = async (req, res) => {
  try {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, message: 'Provide an email.' });
    const user = await User.findOne({ email }).select('email role businessAddon').lean();
    if (!user) return res.status(404).json({ success: false, message: 'No account found.' });
    res.json({ success: true, data: {
      email: user.email, role: user.role,
      activeUntil: user.businessAddon?.activeUntil || null,
      seatsPaid: user.businessAddon?.seatsPaid || 0,
      active: !!(user.businessAddon?.activeUntil && new Date(user.businessAddon.activeUntil) > new Date()),
    } });
  } catch (error) {
    logger.error('lookupAccount error', { error: error.message });
    res.status(500).json({ success: false, message: 'Lookup failed.' });
  }
};

// POST /api/admin/grants/business/revoke  { email | userId }
export const revokeBusinessAddon = async (req, res) => {
  try {
    const user = await findAccount(req.body);
    if (!user) return res.status(404).json({ success: false, message: 'No account found.' });
    user.businessAddon = user.businessAddon || {};
    user.businessAddon.activeUntil = null;
    await user.save();
    logger.info('Admin revoked Business Suite', { admin: req.admin?.email || req.admin?.id, email: user.email });
    res.json({ success: true, message: `Revoked Business Suite for ${user.email}.` });
  } catch (error) {
    logger.error('revokeBusinessAddon error', { error: error.message });
    res.status(500).json({ success: false, message: 'Could not revoke.' });
  }
};
