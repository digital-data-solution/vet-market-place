// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS SUITE — inventory + point-of-sale + staff/reps for shops & vets.
//
// Value: (1) live inventory (sales decrement stock, low-stock alerts),
// (2) theft reduction via an immutable StockMovement audit trail (who/when/
// before→after), (3) staff with individual logins (username+password) OR a
// shared-device PIN, each scoped by permissions and attributed on every action.
//
// Tenant isolation: every doc carries `owner` = the business owner's User._id.
// Auth is via businessAuth middleware which sets req.businessOwnerId (the owner
// in both owner-mode and staff-mode) and req.staffActor (the acting staff, or
// null for the owner). Monetized as a one-off-extend add-on + per-seat staff
// billing (Paystack), same pattern as practice.controller.js.
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import StockMovement from '../models/StockMovement.js';
import Sale from '../models/Sale.js';
import StaffMember from '../models/StaffMember.js';
import User from '../models/User.js';
import BusinessProfile from '../models/BusinessProfile.js';
import logger from '../lib/logger.js';
import { logActivity } from '../lib/activityLogger.js';
import { signStaffToken } from '../lib/staffToken.js';
import { resolveTier, nextTier } from '../config/plans.js';

const PAYSTACK_BASE   = process.env.PAYSTACK_BASE       || 'https://api.paystack.co';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';

const FREE_PRODUCT_LIMIT   = parseInt(process.env.BUSINESS_FREE_PRODUCT_LIMIT || '15', 10);
const BUSINESS_INCLUDED_SEATS = parseInt(process.env.BUSINESS_INCLUDED_SEATS || '2', 10);   // staff seats bundled with any active add-on
const BUSINESS_PER_SEAT_PRICE = parseInt(process.env.BUSINESS_PER_SEAT_PRICE || '1500', 10); // ₦ per extra seat / 30 days

const BUSINESS_ROLES = ['shop_owner', 'vet', 'kennel_owner'];

export const BUSINESS_PACKAGES = {
  30:  { days: 30,  price: 3500,  label: '1 Month' },
  90:  { days: 90,  price: 9000,  label: '3 Months' },
  365: { days: 365, price: 32000, label: '12 Months' },
};

const PERM_LABEL = {
  sell: 'record sales',
  viewReports: 'view sales & reports',
  manageInventory: 'manage inventory',
  adjustStock: 'adjust stock',
  manageStaff: 'manage staff',
  dispense: 'dispense items',
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function isAddonActive(user) {
  const until = user?.businessAddon?.activeUntil;
  return !!(until && new Date(until) > new Date());
}

// Gate: resolve the owner tenant + acting staff from what businessAuth set.
// Returns { userId (owner), user, staff }. Staff act within a qualifying
// owner's tenant, so only owners are role-gated.
async function requireOwner(req, res) {
  const ownerId = req.businessOwnerId || req.user?._id || req.user?.id;
  if (!ownerId) { res.status(401).json({ success: false, message: 'Not authorized.' }); return null; }
  const user = await User.findById(ownerId).select('role email name businessAddon enterpriseHold plan');
  if (!user) { res.status(404).json({ success: false, message: 'Business account not found.' }); return null; }
  if (!req.staffActor && !BUSINESS_ROLES.includes(user.role)) {
    res.status(403).json({ success: false, message: 'The Business Suite is available to registered shops, vets and kennels/farms. Complete your business listing first.' });
    return null;
  }
  return { userId: ownerId, user, staff: req.staffActor || null };
}

// Permission gate for staff. Owner (no staff) always passes. Returns true if
// BLOCKED (and has already sent the 403), so callers do `if (blocked(...)) return;`.
function blocked(ctx, res, key) {
  if (ctx.staff && !ctx.staff.permissions?.[key]) {
    res.status(403).json({ success: false, message: `You don't have permission to ${PERM_LABEL[key] || 'do that'}. Ask the owner.` });
    return true;
  }
  return false;
}

// Enterprise hold: block NEW records for a whale who outgrew their plan. Returns
// true if BLOCKED (402 already sent), so callers do `if (heldForWrite(...)) return;`.
function heldForWrite(ctx, res) {
  if (ctx.user?.enterpriseHold?.active) {
    res.status(402).json({ success: false, code: 'ENTERPRISE_REQUIRED',
      message: ctx.user.enterpriseHold.reason || 'Your usage has grown beyond this plan. Please contact us to move to an Enterprise plan and continue.' });
    return true;
  }
  return false;
}

// Who is acting, for attribution on sales/stock movements.
async function actorFor(ctx, req) {
  if (ctx.staff) return { staffId: ctx.staff.id, staffName: ctx.staff.name };
  return resolveActor(ctx.userId, req.body.staffId); // owner mode: optional shared-device PIN staff
}

async function resolveActor(userId, staffId) {
  if (!staffId || !mongoose.isValidObjectId(staffId)) return { staffId: null, staffName: 'Owner' };
  const staff = await StaffMember.findOne({ _id: staffId, owner: userId, isActive: true }).select('name');
  if (!staff) return { staffId: null, staffName: 'Owner' };
  return { staffId: staff._id, staffName: staff.name };
}

function recordMovement(fields) {
  return StockMovement.create(fields);
}

function seatInfo(user) {
  const seatsPaid = user.businessAddon?.seatsPaid || 0;
  return { includedSeats: BUSINESS_INCLUDED_SEATS, seatsPaid, perSeatPrice: BUSINESS_PER_SEAT_PRICE, totalSeats: BUSINESS_INCLUDED_SEATS + seatsPaid };
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS / PRICING / PAYMENT
// ─────────────────────────────────────────────────────────────────────────────
export const getBusinessPricing = async (_req, res) => {
  res.json({
    success: true,
    data: {
      currency: 'NGN',
      freeProductLimit: FREE_PRODUCT_LIMIT,
      includedSeats: BUSINESS_INCLUDED_SEATS,
      perSeatPrice: BUSINESS_PER_SEAT_PRICE,
      packages: Object.values(BUSINESS_PACKAGES),
      benefits: [
        `Free up to ${FREE_PRODUCT_LIMIT} products — track stock and record sales`,
        'Unlimited products when you upgrade',
        `Includes ${BUSINESS_INCLUDED_SEATS} staff logins — each with their own username & password, every action tracked to them`,
        `Add more staff/vets any time at ₦${BUSINESS_PER_SEAT_PRICE.toLocaleString()} per seat / 30 days`,
        'Theft-proof audit trail — see who moved every unit, and when',
        'Low-stock alerts, daily sales & profit reports, customer records',
      ],
    },
  });
};

export const getBusinessStatus = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  try {
    const active = isAddonActive(ctx.user);
    const until = ctx.user.businessAddon?.activeUntil;
    const seats = seatInfo(ctx.user);
    const tier = resolveTier(ctx.user, active);

    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const [productCount, lowStockCount, staffCount, todaySales] = await Promise.all([
      Product.countDocuments({ owner: ctx.userId, isActive: true }),
      Product.countDocuments({ owner: ctx.userId, isActive: true, $expr: { $lte: ['$quantity', '$lowStockThreshold'] } }),
      StaffMember.countDocuments({ owner: ctx.userId, isActive: true }),
      Sale.aggregate([
        { $match: { owner: new mongoose.Types.ObjectId(ctx.userId), createdAt: { $gte: startOfDay } } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } },
      ]),
    ]);

    res.json({
      success: true,
      data: {
        productCount,
        freeProductLimit: FREE_PRODUCT_LIMIT,
        planTier: tier.key,
        planLabel: tier.label,
        maxProducts: tier.maxProducts === Infinity ? null : tier.maxProducts,
        atLimit: productCount >= tier.maxProducts,
        lowStockCount,
        staffCount,
        includedSeats: seats.includedSeats,
        seatsPaid: seats.seatsPaid,
        perSeatPrice: seats.perSeatPrice,
        canAddStaff: active && staffCount < seats.totalSeats,
        addonActive: active,
        activeUntil: active ? until : null,
        daysRemaining: active ? Math.ceil((new Date(until) - new Date()) / (1000 * 60 * 60 * 24)) : 0,
        today: { count: todaySales[0]?.count || 0, total: todaySales[0]?.total || 0 },
        isStaff: !!ctx.staff,
        permissions: ctx.staff?.permissions || null,
      },
    });
  } catch (error) {
    logger.error('Get business status error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load status.' });
  }
};

async function initPaystack(email, amount, metadata, res) {
  if (!PAYSTACK_SECRET) { res.status(500).json({ success: false, message: 'Payment system not configured.' }); return null; }
  if (!email) { res.status(400).json({ success: false, message: 'Account email required to pay.' }); return null; }
  const initRes = await axios.post(
    `${PAYSTACK_BASE}/transaction/initialize`,
    { email, amount: amount * 100, currency: 'NGN', metadata, callback_url: process.env.PAYSTACK_CALLBACK_URL,
      channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer'] },
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } },
  );
  const { data } = initRes;
  if (!data?.status || !data?.data) { res.status(500).json({ success: false, message: 'Payment initialization failed.' }); return null; }
  return data.data;
}

export const createBusinessPayment = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (ctx.staff) return res.status(403).json({ success: false, message: 'Only the owner can purchase the Business Suite.' });
  const days = parseInt(req.body.days, 10);
  const pkg = BUSINESS_PACKAGES[days];
  if (!pkg) return res.status(400).json({ success: false, message: 'Invalid package. Choose 30, 90 or 365 days.' });

  try {
    const data = await initPaystack(ctx.user.email, pkg.price,
      { type: 'business_addon', userId: ctx.userId.toString(), days: pkg.days }, res);
    if (!data) return;
    logActivity(ctx.userId, ctx.user.role, 'business.initiated', { days: pkg.days, amount: pkg.price }, req);
    res.status(201).json({ success: true, message: 'Business Suite payment initialized.',
      data: { authorization_url: data.authorization_url, reference: data.reference, amount: pkg.price, days: pkg.days } });
  } catch (error) {
    logger.error('Create business payment error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to start payment.' });
  }
};

// Per-seat purchase — extends seatsPaid so the owner can add more staff logins.
export const createSeatPayment = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (ctx.staff) return res.status(403).json({ success: false, message: 'Only the owner can buy staff seats.' });
  const seats = parseInt(req.body.seats, 10);
  const days = parseInt(req.body.days, 10) || 30;
  if (!seats || seats < 1 || seats > 50) return res.status(400).json({ success: false, message: 'Choose between 1 and 50 seats.' });

  try {
    const amount = BUSINESS_PER_SEAT_PRICE * seats;
    const data = await initPaystack(ctx.user.email, amount,
      { type: 'business_seats', userId: ctx.userId.toString(), seats, days }, res);
    if (!data) return;
    logActivity(ctx.userId, ctx.user.role, 'business.seats_initiated', { seats, amount }, req);
    res.status(201).json({ success: true, message: 'Seat payment initialized.',
      data: { authorization_url: data.authorization_url, reference: data.reference, amount, seats } });
  } catch (error) {
    logger.error('Create seat payment error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to start seat payment.' });
  }
};

export async function activateBusinessAddon(metadata, reference) {
  const { userId, days } = metadata;
  const addonDays = BUSINESS_PACKAGES[days]?.days ?? parseInt(days, 10);
  if (!userId || !addonDays) throw new Error('business_addon metadata incomplete');

  const user = await User.findById(userId);
  if (!user) throw new Error('Business addon target not found');
  if (user.businessAddon?.lastPaymentReference === reference) {
    logger.info('Business addon already applied for reference — skipping', { userId, reference });
    return { activeUntil: user.businessAddon.activeUntil, days: addonDays };
  }

  const now  = new Date();
  const base = user.businessAddon?.activeUntil && user.businessAddon.activeUntil > now ? user.businessAddon.activeUntil : now;
  const activeUntil = new Date(base.getTime() + addonDays * 24 * 60 * 60 * 1000);

  user.businessAddon.activeUntil = activeUntil;
  user.businessAddon.lastPaymentReference = reference;
  await user.save();

  logger.info('Business addon activated', { userId, days: addonDays, activeUntil, reference });
  logActivity(userId, user.role, 'business.activated', { days: addonDays, activeUntil, reference });
  return { activeUntil, days: addonDays };
}

// Idempotent per reference — adds paid staff seats.
export async function activateBusinessSeats(metadata, reference) {
  const { userId, seats } = metadata;
  const n = parseInt(seats, 10);
  if (!userId || !n) throw new Error('business_seats metadata incomplete');

  const user = await User.findById(userId);
  if (!user) throw new Error('Business seats target not found');
  if (user.businessAddon?.seatRefs?.includes(reference)) {
    logger.info('Business seats already applied for reference — skipping', { userId, reference });
    return { seatsPaid: user.businessAddon.seatsPaid, added: 0 };
  }

  user.businessAddon.seatsPaid = (user.businessAddon.seatsPaid || 0) + n;
  user.businessAddon.seatRefs = [...(user.businessAddon.seatRefs || []), reference];
  await user.save();

  logger.info('Business seats activated', { userId, seats: n, reference });
  logActivity(userId, user.role, 'business.seats', { seats: n, pricePer: BUSINESS_PER_SEAT_PRICE, reference });
  return { seatsPaid: user.businessAddon.seatsPaid, added: n };
}

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTS
// ─────────────────────────────────────────────────────────────────────────────
export const listProducts = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  try {
    const filter = { owner: ctx.userId, isActive: true };
    const q = (req.query.q || '').trim();
    if (q) filter.$text = { $search: q };
    if (req.query.lowStock === 'true') filter.$expr = { $lte: ['$quantity', '$lowStockThreshold'] };
    const products = await Product.find(filter).sort({ name: 1 }).limit(1000).lean();
    res.json({ success: true, data: products });
  } catch (error) {
    logger.error('List products error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load products.' });
  }
};

export const createProduct = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (blocked(ctx, res, 'manageInventory')) return;
  if (heldForWrite(ctx, res)) return;
  const { name, sellPrice } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Product name is required.' });
  if (sellPrice === undefined || sellPrice === null || isNaN(Number(sellPrice)) || Number(sellPrice) < 0) {
    return res.status(400).json({ success: false, message: 'A valid selling price is required.' });
  }
  try {
    // Tier-based product cap (scales small shop → hospital pharmacy). Legacy
    // add-on holders map to the Clinic tier for backward compatibility.
    {
      const tier = resolveTier(ctx.user, isAddonActive(ctx.user));
      const count = await Product.countDocuments({ owner: ctx.userId, isActive: true });
      if (count >= tier.maxProducts) {
        const nt = nextTier(tier.key);
        return res.status(402).json({ success: false, code: 'UPGRADE_REQUIRED', tier: tier.key, nextTier: nt.key,
          message: `Your ${tier.label} plan allows ${tier.maxProducts} products. Upgrade to ${nt.label} to add more — contact us to upgrade.` });
      }
    }
    const startQty = Math.max(0, parseInt(req.body.quantity, 10) || 0);
    const product = await Product.create({
      owner: ctx.userId, quantity: startQty,
      ...pick(req.body, ['name', 'sku', 'barcode', 'category', 'unit', 'photo', 'costPrice', 'sellPrice', 'lowStockThreshold']),
    });
    if (startQty > 0) {
      const actor = await actorFor(ctx, req);
      await recordMovement({ owner: ctx.userId, product: product._id, productName: product.name,
        type: 'initial', quantityChange: startQty, quantityBefore: 0, quantityAfter: startQty,
        unitCost: product.costPrice || null, staff: actor.staffId, staffName: actor.staffName });
    }
    res.status(201).json({ success: true, data: product });
  } catch (error) {
    logger.error('Create product error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to create product.' });
  }
};

export const getProduct = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  try {
    const product = await Product.findOne({ _id: req.params.id, owner: ctx.userId }).lean();
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    const movements = await StockMovement.find({ product: product._id, owner: ctx.userId }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, data: { ...product, movements } });
  } catch (error) {
    logger.error('Get product error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load product.' });
  }
};

export const updateProduct = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (blocked(ctx, res, 'manageInventory')) return;
  try {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, owner: ctx.userId },
      { $set: pick(req.body, ['name', 'sku', 'barcode', 'category', 'unit', 'photo', 'costPrice', 'sellPrice', 'lowStockThreshold', 'isActive']) },
      { new: true },
    );
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    res.json({ success: true, data: product });
  } catch (error) {
    logger.error('Update product error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update product.' });
  }
};

export const deleteProduct = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (blocked(ctx, res, 'manageInventory')) return;
  try {
    const product = await Product.findOneAndUpdate({ _id: req.params.id, owner: ctx.userId }, { $set: { isActive: false } }, { new: true });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    res.json({ success: true, message: 'Product archived.' });
  } catch (error) {
    logger.error('Delete product error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to archive product.' });
  }
};

export const restockProduct = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (blocked(ctx, res, 'manageInventory')) return;
  const qty = parseInt(req.body.quantity, 10);
  if (!qty || qty <= 0) return res.status(400).json({ success: false, message: 'Enter a quantity greater than zero.' });
  try {
    const before = await Product.findOne({ _id: req.params.id, owner: ctx.userId });
    if (!before) return res.status(404).json({ success: false, message: 'Product not found.' });
    const unitCost = req.body.unitCost !== undefined ? Number(req.body.unitCost) : before.costPrice;
    const set = {};
    if (req.body.unitCost !== undefined && !isNaN(unitCost)) set.costPrice = unitCost;
    const updated = await Product.findOneAndUpdate(
      { _id: before._id, owner: ctx.userId },
      { $inc: { quantity: qty }, ...(Object.keys(set).length ? { $set: set } : {}) },
      { new: true },
    );
    const actor = await actorFor(ctx, req);
    await recordMovement({ owner: ctx.userId, product: updated._id, productName: updated.name,
      type: 'restock', quantityChange: qty, quantityBefore: updated.quantity - qty, quantityAfter: updated.quantity,
      unitCost: !isNaN(unitCost) ? unitCost : null, reason: req.body.reason || null, staff: actor.staffId, staffName: actor.staffName });
    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Restock product error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to add stock.' });
  }
};

export const adjustProduct = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (blocked(ctx, res, 'adjustStock')) return;
  const newQty = parseInt(req.body.newQuantity, 10);
  const reason = (req.body.reason || '').trim();
  if (isNaN(newQty) || newQty < 0) return res.status(400).json({ success: false, message: 'Enter the new count (zero or more).' });
  if (!reason) return res.status(400).json({ success: false, message: 'A reason is required for a stock adjustment.' });
  try {
    const product = await Product.findOne({ _id: req.params.id, owner: ctx.userId });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    const before = product.quantity;
    const change = newQty - before;
    if (change === 0) return res.json({ success: true, data: product, message: 'No change.' });
    product.quantity = newQty;
    await product.save();
    const actor = await actorFor(ctx, req);
    await recordMovement({ owner: ctx.userId, product: product._id, productName: product.name,
      type: req.body.type === 'damage' ? 'damage' : 'adjustment',
      quantityChange: change, quantityBefore: before, quantityAfter: newQty,
      reason, staff: actor.staffId, staffName: actor.staffName });
    res.json({ success: true, data: product });
  } catch (error) {
    logger.error('Adjust product error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to adjust stock.' });
  }
};

export const listProductMovements = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  try {
    const movements = await StockMovement.find({ product: req.params.id, owner: ctx.userId }).sort({ createdAt: -1 }).limit(500).lean();
    res.json({ success: true, data: movements });
  } catch (error) {
    logger.error('List product movements error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load history.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────────────────────────────────────
export const listMovements = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (blocked(ctx, res, 'viewReports')) return;
  try {
    const filter = { owner: ctx.userId };
    if (req.query.type) filter.type = req.query.type;
    if (req.query.staffId && mongoose.isValidObjectId(req.query.staffId)) filter.staff = req.query.staffId;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   filter.createdAt.$lte = new Date(req.query.to);
    }
    const movements = await StockMovement.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    res.json({ success: true, data: movements });
  } catch (error) {
    logger.error('List movements error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load audit log.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SALES / POINT OF SALE
// ─────────────────────────────────────────────────────────────────────────────
export const createSale = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (blocked(ctx, res, 'sell')) return;
  if (heldForWrite(ctx, res)) return;
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ success: false, message: 'Add at least one item to the sale.' });

  const decremented = [];
  try {
    const ids = items.map((i) => i.productId).filter((id) => mongoose.isValidObjectId(id));
    const products = await Product.find({ _id: { $in: ids }, owner: ctx.userId, isActive: true });
    const byId = new Map(products.map((p) => [p._id.toString(), p]));

    const lineItems = [];
    let subtotal = 0, costTotal = 0;
    for (const raw of items) {
      const p = byId.get(String(raw.productId));
      const qty = parseInt(raw.quantity, 10);
      if (!p) return res.status(404).json({ success: false, message: 'One of the items is no longer available.' });
      if (!qty || qty <= 0) return res.status(400).json({ success: false, message: `Enter a valid quantity for ${p.name}.` });
      const unitPrice = raw.unitPrice !== undefined ? Number(raw.unitPrice) : p.sellPrice;
      const lineTotal = unitPrice * qty;
      subtotal += lineTotal;
      costTotal += (p.costPrice || 0) * qty;
      lineItems.push({ product: p._id, productName: p.name, quantity: qty, unitPrice, unitCost: p.costPrice || 0, lineTotal });
    }

    const discount = Math.max(0, Number(req.body.discount) || 0);
    const total = Math.max(0, subtotal - discount);
    const actor = await actorFor(ctx, req);

    for (const li of lineItems) {
      const ok = await Product.findOneAndUpdate(
        { _id: li.product, owner: ctx.userId, quantity: { $gte: li.quantity } },
        { $inc: { quantity: -li.quantity } },
        { new: true },
      );
      if (!ok) {
        for (const done of decremented) await Product.updateOne({ _id: done.product, owner: ctx.userId }, { $inc: { quantity: done.quantity } });
        return res.status(409).json({ success: false, message: `Not enough stock for ${li.productName}.`, code: 'INSUFFICIENT_STOCK' });
      }
      decremented.push({ product: li.product, quantity: li.quantity, after: ok.quantity });
    }

    const sale = await Sale.create({
      owner: ctx.userId, items: lineItems, subtotal, discount, total, costTotal,
      amountPaid: req.body.amountPaid !== undefined ? Number(req.body.amountPaid) : total,
      paymentMethod: req.body.paymentMethod || 'cash',
      customerName: req.body.customerName || null, customerPhone: req.body.customerPhone || null,
      staff: actor.staffId, staffName: actor.staffName, note: req.body.note || null,
    });

    await StockMovement.insertMany(lineItems.map((li) => {
      const d = decremented.find((x) => x.product.equals(li.product));
      return { owner: ctx.userId, product: li.product, productName: li.productName,
        type: 'sale', quantityChange: -li.quantity, quantityBefore: d.after + li.quantity, quantityAfter: d.after,
        unitPrice: li.unitPrice, staff: actor.staffId, staffName: actor.staffName, sale: sale._id };
    }));

    logActivity(ctx.userId, ctx.user.role, 'business.sale', { total, items: lineItems.length, staff: actor.staffName });
    res.status(201).json({ success: true, data: sale });
  } catch (error) {
    for (const done of decremented) await Product.updateOne({ _id: done.product, owner: ctx.userId }, { $inc: { quantity: done.quantity } }).catch(() => {});
    logger.error('Create sale error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to record sale.' });
  }
};

export const listSales = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (blocked(ctx, res, 'viewReports')) return;
  try {
    const filter = { owner: ctx.userId };
    if (req.query.staffId && mongoose.isValidObjectId(req.query.staffId)) filter.staff = req.query.staffId;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   filter.createdAt.$lte = new Date(req.query.to);
    }
    const sales = await Sale.find(filter).sort({ createdAt: -1 }).limit(300).lean();
    res.json({ success: true, data: sales });
  } catch (error) {
    logger.error('List sales error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load sales.' });
  }
};

export const getSale = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  try {
    const sale = await Sale.findOne({ _id: req.params.id, owner: ctx.userId }).lean();
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found.' });
    res.json({ success: true, data: sale });
  } catch (error) {
    logger.error('Get sale error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load sale.' });
  }
};

export const getSalesSummary = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (blocked(ctx, res, 'viewReports')) return;
  try {
    const owner = new mongoose.Types.ObjectId(ctx.userId);
    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(startOfDay); startOfWeek.setDate(startOfWeek.getDate() - startOfDay.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const periodTotals = async (since) => {
      const r = await Sale.aggregate([
        { $match: { owner, createdAt: { $gte: since } } },
        { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$total' }, cost: { $sum: '$costTotal' } } },
      ]);
      const row = r[0] || { count: 0, revenue: 0, cost: 0 };
      return { count: row.count, revenue: row.revenue, profit: row.revenue - row.cost };
    };

    const [today, week, month, byStaff, topProducts] = await Promise.all([
      periodTotals(startOfDay), periodTotals(startOfWeek), periodTotals(startOfMonth),
      Sale.aggregate([
        { $match: { owner, createdAt: { $gte: startOfMonth } } },
        { $group: { _id: '$staffName', count: { $sum: 1 }, revenue: { $sum: '$total' } } },
        { $sort: { revenue: -1 } },
      ]),
      Sale.aggregate([
        { $match: { owner, createdAt: { $gte: startOfMonth } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.productName', qty: { $sum: '$items.quantity' }, revenue: { $sum: '$items.lineTotal' } } },
        { $sort: { qty: -1 } }, { $limit: 10 },
      ]),
    ]);
    res.json({ success: true, data: { today, week, month, byStaff, topProducts } });
  } catch (error) {
    logger.error('Sales summary error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load sales summary.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMERS
// ─────────────────────────────────────────────────────────────────────────────
export const listCustomers = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (blocked(ctx, res, 'viewReports')) return;
  try {
    const owner = new mongoose.Types.ObjectId(ctx.userId);
    const customers = await Sale.aggregate([
      { $match: { owner, customerPhone: { $ne: null } } },
      { $group: { _id: '$customerPhone', name: { $last: '$customerName' }, visits: { $sum: 1 }, totalSpent: { $sum: '$total' }, lastVisit: { $max: '$createdAt' } } },
      { $sort: { totalSpent: -1 } }, { $limit: 300 },
    ]);
    res.json({ success: true, data: customers.map((c) => ({ phone: c._id, name: c.name, visits: c.visits, totalSpent: c.totalSpent, lastVisit: c.lastVisit })) });
  } catch (error) {
    logger.error('List customers error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load customers.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// STAFF / SALES REPS
// ─────────────────────────────────────────────────────────────────────────────
export const listStaff = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  try {
    const staff = await StaffMember.find({ owner: ctx.userId }).sort({ createdAt: 1 }).lean(); // hashes excluded by select:false
    res.json({ success: true, data: staff });
  } catch (error) {
    logger.error('List staff error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load staff.' });
  }
};

export const createStaff = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (blocked(ctx, res, 'manageStaff')) return;
  const { name, pin, username, password } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Staff name is required.' });
  if (!pin && !username) return res.status(400).json({ success: false, message: 'Give the staff member a PIN, a username & password, or both.' });
  if (pin && !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ success: false, message: 'PIN must be 4–6 digits.' });
  if (username) {
    if (!/^[a-z0-9_.]{3,30}$/i.test(String(username).trim())) return res.status(400).json({ success: false, message: 'Username must be 3–30 letters, numbers, dot or underscore.' });
    if (!password || String(password).length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
  }

  if (!isAddonActive(ctx.user)) {
    return res.status(402).json({ success: false, message: 'Adding staff is part of the Business Suite upgrade. Upgrade to give each their own tracked login.', code: 'STAFF_REQUIRES_UPGRADE' });
  }
  const seats = seatInfo(ctx.user);
  const activeStaff = await StaffMember.countDocuments({ owner: ctx.userId, isActive: true });
  if (activeStaff >= seats.totalSeats) {
    return res.status(402).json({ success: false, message: `You've used all ${seats.totalSeats} of your staff seats. Buy more seats (₦${seats.perSeatPrice.toLocaleString()} each / 30 days) to add more team members.`, code: 'SEAT_LIMIT_REACHED' });
  }

  try {
    const doc = { owner: ctx.userId, name: name.trim(), role: req.body.role === 'manager' ? 'manager' : 'rep' };
    if (pin) doc.pinHash = await StaffMember.hashPin(pin);
    if (username) { doc.username = String(username).toLowerCase().trim(); doc.passwordHash = await StaffMember.hashPassword(password); }
    if (req.body.permissions && typeof req.body.permissions === 'object') doc.permissions = pick(req.body.permissions, ['sell', 'viewReports', 'manageInventory', 'adjustStock', 'manageStaff', 'dispense', 'reception', 'clinical', 'lab']);
    const staff = await StaffMember.create(doc);
    const obj = staff.toObject(); delete obj.pinHash; delete obj.passwordHash;
    res.status(201).json({ success: true, data: obj });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: 'That username is already taken. Choose another.' });
    logger.error('Create staff error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to add staff.' });
  }
};

export const updateStaff = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (blocked(ctx, res, 'manageStaff')) return;
  try {
    const set = pick(req.body, ['name', 'role', 'isActive']);
    if (req.body.pin !== undefined) {
      if (!/^\d{4,6}$/.test(String(req.body.pin))) return res.status(400).json({ success: false, message: 'PIN must be 4–6 digits.' });
      set.pinHash = await StaffMember.hashPin(req.body.pin);
    }
    if (req.body.password !== undefined) {
      if (String(req.body.password).length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
      set.passwordHash = await StaffMember.hashPassword(req.body.password);
    }
    if (req.body.username !== undefined) {
      if (!/^[a-z0-9_.]{3,30}$/i.test(String(req.body.username).trim())) return res.status(400).json({ success: false, message: 'Username must be 3–30 letters, numbers, dot or underscore.' });
      set.username = String(req.body.username).toLowerCase().trim();
    }
    if (req.body.permissions && typeof req.body.permissions === 'object') {
      set.permissions = pick(req.body.permissions, ['sell', 'viewReports', 'manageInventory', 'adjustStock', 'manageStaff', 'dispense', 'reception', 'clinical', 'lab']);
    }
    const staff = await StaffMember.findOneAndUpdate({ _id: req.params.id, owner: ctx.userId }, { $set: set }, { new: true });
    if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found.' });
    res.json({ success: true, data: staff });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: 'That username is already taken. Choose another.' });
    logger.error('Update staff error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update staff.' });
  }
};

export const deleteStaff = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  if (blocked(ctx, res, 'manageStaff')) return;
  try {
    const staff = await StaffMember.findOneAndUpdate({ _id: req.params.id, owner: ctx.userId }, { $set: { isActive: false } }, { new: true });
    if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found.' });
    res.json({ success: true, message: 'Staff member deactivated.' });
  } catch (error) {
    logger.error('Delete staff error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to remove staff.' });
  }
};

// Shared-device PIN verify (owner authed, resolves WHICH rep is at the counter).
export const verifyStaffPin = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  const { staffId, pin } = req.body;
  if (!staffId || !mongoose.isValidObjectId(staffId) || !pin) return res.status(400).json({ success: false, message: 'Select your name and enter your PIN.' });
  try {
    const staff = await StaffMember.findOne({ _id: staffId, owner: ctx.userId, isActive: true }).select('+pinHash name role');
    if (!staff || !(await staff.comparePin(pin))) return res.status(401).json({ success: false, message: 'Incorrect PIN.' });
    staff.lastActiveAt = new Date();
    await staff.save();
    res.json({ success: true, data: { _id: staff._id, name: staff.name, role: staff.role } });
  } catch (error) {
    logger.error('Verify staff pin error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to verify PIN.' });
  }
};

// Individual staff login on their own phone (PUBLIC route) → scoped token.
export const staffLogin = async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: 'Enter your username and password.' });
  try {
    const staff = await StaffMember.findOne({ username: String(username).toLowerCase().trim(), isActive: true })
      .select('+passwordHash name role permissions owner');
    if (!staff || !(await staff.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Incorrect username or password.' });
    }
    const owner = await User.findById(staff.owner).select('name businessAddon role');
    if (!owner || !isAddonActive(owner)) {
      return res.status(403).json({ success: false, message: 'Your team\'s Business Suite is not active. Ask the owner to renew.' });
    }
    let businessName = owner.name;
    const profile = await BusinessProfile.findOne({ owner: staff.owner }).select('headerName');
    if (profile?.headerName) businessName = profile.headerName;

    const token = signStaffToken({ staffId: staff._id, ownerId: staff.owner });
    staff.lastActiveAt = new Date();
    await staff.save();
    res.json({ success: true, data: { token, staff: {
      id: String(staff._id), name: staff.name, role: staff.role,
      permissions: staff.permissions?.toObject?.() || staff.permissions || {},
      ownerId: String(staff.owner), businessName,
    } } });
  } catch (error) {
    logger.error('Staff login error', { error: error.message });
    res.status(500).json({ success: false, message: 'Could not sign you in. Please try again.' });
  }
};

// Staff self profile (staff token).
export const staffMe = async (req, res) => {
  if (!req.staffActor) return res.status(400).json({ success: false, message: 'Not a staff session.' });
  try {
    const staff = await StaffMember.findOne({ _id: req.staffActor.id, owner: req.businessOwnerId, isActive: true }).select('name role permissions');
    if (!staff) return res.status(401).json({ success: false, message: 'Access revoked.' });
    res.json({ success: true, data: { staff: { id: String(staff._id), name: staff.name, role: staff.role, permissions: staff.permissions } } });
  } catch (error) {
    logger.error('Staff me error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load profile.' });
  }
};
