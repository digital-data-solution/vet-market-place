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
import Patient from '../models/Patient.js';
import Product from '../models/Product.js';
import StaffMember from '../models/StaffMember.js';
import Sale from '../models/Sale.js';
import logger from '../lib/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// "Whale" thresholds — an account bigger than any of these on a standard plan
// should be on Enterprise pricing. Tunable via env without a redeploy.
const WHALE = {
  patients: parseInt(process.env.WHALE_PATIENTS || '200', 10),
  seats:    parseInt(process.env.WHALE_SEATS    || '8', 10),
  products: parseInt(process.env.WHALE_PRODUCTS || '400', 10),
  sales30:  parseInt(process.env.WHALE_SALES_30D || '800', 10),
};

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

// GET /api/admin/grants/large-accounts — usage-based "whale" report so support
// can proactively move big hospitals/shops onto Enterprise pricing.
export const largeAccounts = async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [patientsBy, productsBy, staffBy, salesBy] = await Promise.all([
      Patient.aggregate([{ $match: { isActive: true } }, { $group: { _id: '$vet', c: { $sum: 1 } } }]),
      Product.aggregate([{ $group: { _id: '$owner', c: { $sum: 1 } } }]),
      StaffMember.aggregate([{ $match: { isActive: true } }, { $group: { _id: '$owner', c: { $sum: 1 } } }]),
      Sale.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$owner', c: { $sum: 1 }, vol: { $sum: '$total' } } }]),
    ]);

    const map = new Map();
    const bump = (id, key, val) => {
      if (!id) return;
      const k = String(id);
      const row = map.get(k) || { ownerId: k, patients: 0, products: 0, seats: 0, sales30: 0, volume30: 0 };
      row[key] = val; map.set(k, row);
    };
    patientsBy.forEach((r) => bump(r._id, 'patients', r.c));
    productsBy.forEach((r) => bump(r._id, 'products', r.c));
    staffBy.forEach((r) => bump(r._id, 'seats', r.c));
    salesBy.forEach((r) => { bump(r._id, 'sales30', r.c); const row = map.get(String(r._id)); if (row) row.volume30 = r.vol; });

    let rows = [...map.values()].map((r) => {
      const flags = [];
      if (r.patients >= WHALE.patients) flags.push('patients');
      if (r.seats >= WHALE.seats) flags.push('seats');
      if (r.products >= WHALE.products) flags.push('products');
      if (r.sales30 >= WHALE.sales30) flags.push('sales');
      const score = r.patients / WHALE.patients + r.seats / WHALE.seats + r.products / WHALE.products + r.sales30 / WHALE.sales30;
      return { ...r, flags, isWhale: flags.length > 0, score: Math.round(score * 100) / 100 };
    });
    // Whales first, then biggest by score; cap the payload.
    rows.sort((a, b) => (b.isWhale - a.isWhale) || (b.score - a.score));
    rows = rows.slice(0, 60);

    // Attach account identity + current hold/subscription state.
    const users = await User.find({ _id: { $in: rows.map((r) => r.ownerId) } })
      .select('email role businessAddon enterpriseHold').lean();
    const uMap = Object.fromEntries(users.map((u) => [String(u._id), u]));
    const data = rows.map((r) => {
      const u = uMap[r.ownerId] || {};
      return { ...r, email: u.email || null, role: u.role || null,
        addonActive: !!(u.businessAddon?.activeUntil && new Date(u.businessAddon.activeUntil) > new Date()),
        onHold: !!u.enterpriseHold?.active };
    });

    res.json({ success: true, thresholds: WHALE, data });
  } catch (error) {
    logger.error('largeAccounts error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load large accounts.' });
  }
};

// POST /api/admin/grants/enterprise-hold  { email | userId, reason }  — STOP a whale
export const setEnterpriseHold = async (req, res) => {
  try {
    const user = await findAccount(req.body);
    if (!user) return res.status(404).json({ success: false, message: 'No account found.' });
    user.enterpriseHold = { active: true, reason: req.body.reason || 'Usage requires an Enterprise plan.', setAt: new Date() };
    await user.save();
    logger.info('Enterprise hold set', { admin: req.admin?.email, email: user.email, reason: user.enterpriseHold.reason });
    res.json({ success: true, message: `${user.email} is now on Enterprise hold — new records are blocked until cleared.` });
  } catch (error) {
    logger.error('setEnterpriseHold error', { error: error.message });
    res.status(500).json({ success: false, message: 'Could not set the hold.' });
  }
};

// POST /api/admin/grants/enterprise-hold/clear  { email | userId } — release after they pay
export const clearEnterpriseHold = async (req, res) => {
  try {
    const user = await findAccount(req.body);
    if (!user) return res.status(404).json({ success: false, message: 'No account found.' });
    user.enterpriseHold = { active: false, reason: null, setAt: null };
    await user.save();
    logger.info('Enterprise hold cleared', { admin: req.admin?.email, email: user.email });
    res.json({ success: true, message: `Enterprise hold cleared for ${user.email}.` });
  } catch (error) {
    logger.error('clearEnterpriseHold error', { error: error.message });
    res.status(500).json({ success: false, message: 'Could not clear the hold.' });
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
