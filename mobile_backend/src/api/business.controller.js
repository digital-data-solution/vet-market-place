// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS SUITE — inventory + point-of-sale + staff/reps for shops & vets.
//
// The value proposition, in order:
//   1. Inventory that's always right — every sale decrements stock, so
//      "how many left" is live, and low-stock alerts fire before you run out.
//   2. Theft reduction through an immutable audit trail — every unit that moves
//      (sale, restock, adjustment, damage) writes a StockMovement stamped with
//      WHO, WHEN and the exact before/after. Nothing can be silently rewritten.
//   3. Sales reps with their own PIN — each sale/movement is attributed to the
//      rep who made it, so the owner can see and trust who did what.
//
// Tenant isolation: every document carries `owner` = the User._id of the
// business owner, and every query filters on it (IDOR-safe). Monetized as a
// one-off-extend add-on (businessAddon.activeUntil on User), same Paystack
// pattern as practice.controller.js / featured.controller.js.
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import mongoose from 'mongoose';
import Product from '../models/Product.js';
import StockMovement from '../models/StockMovement.js';
import Sale from '../models/Sale.js';
import StaffMember from '../models/StaffMember.js';
import User from '../models/User.js';
import logger from '../lib/logger.js';
import { logActivity } from '../lib/activityLogger.js';

const PAYSTACK_BASE   = process.env.PAYSTACK_BASE       || 'https://api.paystack.co';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';

// Free tier: track up to this many active products with no reps. Paying unlocks
// unlimited products + staff/reps. Tuneable via env without a code change.
const FREE_PRODUCT_LIMIT = parseInt(process.env.BUSINESS_FREE_PRODUCT_LIMIT || '15', 10);

// Roles allowed to run a business (shops, vets who also sell, kennels/farms
// selling feed/supplies). Everyone else gets a clean 403.
const BUSINESS_ROLES = ['shop_owner', 'vet', 'kennel_owner'];

// Priced as a standalone "Business" add-on. Exported so the admin stats
// controller can reconstruct revenue from 'business.activated' ActivityLog
// entries (which store `days`, not `amount`).
export const BUSINESS_PACKAGES = {
  30:  { days: 30,  price: 3500,  label: '1 Month' },
  90:  { days: 90,  price: 9000,  label: '3 Months' },
  365: { days: 365, price: 32000, label: '12 Months' },
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

// Gate: the caller must be a business-capable role. Returns { userId, user }.
async function requireOwner(req, res) {
  const userId = req.user._id || req.user.id;
  const user = await User.findById(userId).select('role email name businessAddon');
  if (!user || !BUSINESS_ROLES.includes(user.role)) {
    res.status(403).json({
      success: false,
      message: 'The Business Suite is available to registered shops, vets and kennels/farms. Complete your business listing first.',
    });
    return null;
  }
  return { userId, user };
}

// Resolve the acting staff member from an optional staffId on the request.
// Returns { staffId, staffName } — defaults to the owner when none is supplied.
async function resolveActor(userId, staffId) {
  if (!staffId) return { staffId: null, staffName: 'Owner' };
  if (!mongoose.isValidObjectId(staffId)) return { staffId: null, staffName: 'Owner' };
  const staff = await StaffMember.findOne({ _id: staffId, owner: userId, isActive: true }).select('name');
  if (!staff) return { staffId: null, staffName: 'Owner' };
  return { staffId: staff._id, staffName: staff.name };
}

// Write one audit-trail row. Never updated or deleted anywhere in this file.
function recordMovement(fields) {
  return StockMovement.create(fields);
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
      packages: Object.values(BUSINESS_PACKAGES),
      benefits: [
        `Free up to ${FREE_PRODUCT_LIMIT} products — track stock and record sales`,
        'Unlimited products when you upgrade',
        'Add your sales reps — each with their own PIN, every sale tracked to them',
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
        atLimit: !active && productCount >= FREE_PRODUCT_LIMIT,
        lowStockCount,
        staffCount,
        canAddStaff: active, // reps are a paid feature
        addonActive: active,
        activeUntil: active ? until : null,
        daysRemaining: active ? Math.ceil((new Date(until) - new Date()) / (1000 * 60 * 60 * 24)) : 0,
        today: { count: todaySales[0]?.count || 0, total: todaySales[0]?.total || 0 },
      },
    });
  } catch (error) {
    logger.error('Get business status error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load status.' });
  }
};

export const createBusinessPayment = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  const days = parseInt(req.body.days, 10);
  const pkg = BUSINESS_PACKAGES[days];

  if (!PAYSTACK_SECRET) return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  if (!pkg) return res.status(400).json({ success: false, message: 'Invalid package. Choose 30, 90 or 365 days.' });
  if (!ctx.user.email) return res.status(400).json({ success: false, message: 'Account email required to pay.' });

  try {
    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email:    ctx.user.email,
        amount:   pkg.price * 100,
        currency: 'NGN',
        metadata: { type: 'business_addon', userId: ctx.userId.toString(), days: pkg.days },
        callback_url: process.env.PAYSTACK_CALLBACK_URL,
        channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer'],
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } },
    );

    const { data } = initRes;
    if (!data?.status || !data?.data) return res.status(500).json({ success: false, message: 'Payment initialization failed.' });

    logActivity(ctx.userId, ctx.user.role, 'business.initiated', { days: pkg.days, amount: pkg.price }, req);
    res.status(201).json({
      success: true,
      message: 'Business Suite payment initialized.',
      data: { authorization_url: data.data.authorization_url, reference: data.data.reference, amount: pkg.price, days: pkg.days },
    });
  } catch (error) {
    logger.error('Create business payment error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to start payment.' });
  }
};

// Called by the Paystack webhook + verify fallback. Idempotent per reference,
// mirrors activatePracticeAddon's "extend from later of now/existing" logic.
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
  const base = user.businessAddon?.activeUntil && user.businessAddon.activeUntil > now
    ? user.businessAddon.activeUntil : now;
  const activeUntil = new Date(base.getTime() + addonDays * 24 * 60 * 60 * 1000);

  user.businessAddon = { activeUntil, lastPaymentReference: reference };
  await user.save();

  logger.info('Business addon activated', { userId, days: addonDays, activeUntil, reference });
  logActivity(userId, user.role, 'business.activated', { days: addonDays, activeUntil, reference });

  return { activeUntil, days: addonDays };
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
  const { name, sellPrice } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Product name is required.' });
  if (sellPrice === undefined || sellPrice === null || isNaN(Number(sellPrice)) || Number(sellPrice) < 0) {
    return res.status(400).json({ success: false, message: 'A valid selling price is required.' });
  }

  try {
    if (!isAddonActive(ctx.user)) {
      const count = await Product.countDocuments({ owner: ctx.userId, isActive: true });
      if (count >= FREE_PRODUCT_LIMIT) {
        return res.status(402).json({
          success: false,
          message: `You've reached the free limit of ${FREE_PRODUCT_LIMIT} products. Upgrade the Business Suite to add unlimited stock.`,
          code: 'PRODUCT_LIMIT_REACHED',
        });
      }
    }

    const startQty = Math.max(0, parseInt(req.body.quantity, 10) || 0);
    const product = await Product.create({
      owner: ctx.userId,
      quantity: startQty,
      ...pick(req.body, ['name', 'sku', 'barcode', 'category', 'unit', 'photo', 'costPrice', 'sellPrice', 'lowStockThreshold']),
    });

    // Opening stock is itself an audit entry, so the ledger balances from unit one.
    if (startQty > 0) {
      const actor = await resolveActor(ctx.userId, req.body.staffId);
      await recordMovement({
        owner: ctx.userId, product: product._id, productName: product.name,
        type: 'initial', quantityChange: startQty, quantityBefore: 0, quantityAfter: startQty,
        unitCost: product.costPrice || null, staff: actor.staffId, staffName: actor.staffName,
      });
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
    const movements = await StockMovement.find({ product: product._id, owner: ctx.userId })
      .sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, data: { ...product, movements } });
  } catch (error) {
    logger.error('Get product error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load product.' });
  }
};

// Metadata only. Quantity is deliberately NOT editable here — it can only move
// through restock/adjust/sale so every change lands in the audit trail.
export const updateProduct = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
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
  try {
    // Soft delete — keeps sales history and the audit trail intact, and frees
    // the product against the free-tier count.
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, owner: ctx.userId },
      { $set: { isActive: false } },
      { new: true },
    );
    if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
    res.json({ success: true, message: 'Product archived.' });
  } catch (error) {
    logger.error('Delete product error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to archive product.' });
  }
};

// Add stock (a new delivery). Atomic $inc + audit entry.
export const restockProduct = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  const qty = parseInt(req.body.quantity, 10);
  if (!qty || qty <= 0) return res.status(400).json({ success: false, message: 'Enter a quantity greater than zero.' });

  try {
    const before = await Product.findOne({ _id: req.params.id, owner: ctx.userId });
    if (!before) return res.status(404).json({ success: false, message: 'Product not found.' });

    const unitCost = req.body.unitCost !== undefined ? Number(req.body.unitCost) : before.costPrice;
    const set = {};
    if (req.body.unitCost !== undefined && !isNaN(unitCost)) set.costPrice = unitCost; // keep latest cost
    const updated = await Product.findOneAndUpdate(
      { _id: before._id, owner: ctx.userId },
      { $inc: { quantity: qty }, ...(Object.keys(set).length ? { $set: set } : {}) },
      { new: true },
    );

    const actor = await resolveActor(ctx.userId, req.body.staffId);
    await recordMovement({
      owner: ctx.userId, product: updated._id, productName: updated.name,
      type: 'restock', quantityChange: qty, quantityBefore: updated.quantity - qty, quantityAfter: updated.quantity,
      unitCost: !isNaN(unitCost) ? unitCost : null, reason: req.body.reason || null,
      staff: actor.staffId, staffName: actor.staffName,
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Restock product error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to add stock.' });
  }
};

// Manual correction (recount, damage, loss). A REASON is required — this is the
// single most abused path for hiding theft, so it is always logged, always
// attributed, and never allowed to pass anonymously.
export const adjustProduct = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
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

    const actor = await resolveActor(ctx.userId, req.body.staffId);
    await recordMovement({
      owner: ctx.userId, product: product._id, productName: product.name,
      type: req.body.type === 'damage' ? 'damage' : 'adjustment',
      quantityChange: change, quantityBefore: before, quantityAfter: newQty,
      reason, staff: actor.staffId, staffName: actor.staffName,
    });

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
    const movements = await StockMovement.find({ product: req.params.id, owner: ctx.userId })
      .sort({ createdAt: -1 }).limit(500).lean();
    res.json({ success: true, data: movements });
  } catch (error) {
    logger.error('List product movements error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load history.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOG — the full ledger across all products (theft-review view)
// ─────────────────────────────────────────────────────────────────────────────
export const listMovements = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
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
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ success: false, message: 'Add at least one item to the sale.' });

  // Load and validate every product up front so we fail before touching stock.
  const decremented = []; // { product, quantity } — for rollback on partial failure
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
    const actor = await resolveActor(ctx.userId, req.body.staffId);

    // Atomically decrement each line's stock, guarding against overselling and
    // races. If any line can't be satisfied, roll back what we already took.
    for (const li of lineItems) {
      const ok = await Product.findOneAndUpdate(
        { _id: li.product, owner: ctx.userId, quantity: { $gte: li.quantity } },
        { $inc: { quantity: -li.quantity } },
        { new: true },
      );
      if (!ok) {
        for (const done of decremented) {
          await Product.updateOne({ _id: done.product, owner: ctx.userId }, { $inc: { quantity: done.quantity } });
        }
        return res.status(409).json({ success: false, message: `Not enough stock for ${li.productName}.`, code: 'INSUFFICIENT_STOCK' });
      }
      decremented.push({ product: li.product, quantity: li.quantity, after: ok.quantity });
    }

    const sale = await Sale.create({
      owner: ctx.userId,
      items: lineItems,
      subtotal, discount, total, costTotal,
      amountPaid: req.body.amountPaid !== undefined ? Number(req.body.amountPaid) : total,
      paymentMethod: req.body.paymentMethod || 'cash',
      customerName: req.body.customerName || null,
      customerPhone: req.body.customerPhone || null,
      staff: actor.staffId, staffName: actor.staffName,
      note: req.body.note || null,
    });

    // Audit entry per line, linked to the sale.
    await StockMovement.insertMany(lineItems.map((li) => {
      const d = decremented.find((x) => x.product.equals(li.product));
      return {
        owner: ctx.userId, product: li.product, productName: li.productName,
        type: 'sale', quantityChange: -li.quantity,
        quantityBefore: d.after + li.quantity, quantityAfter: d.after,
        unitPrice: li.unitPrice, staff: actor.staffId, staffName: actor.staffName, sale: sale._id,
      };
    }));

    logActivity(ctx.userId, ctx.user.role, 'business.sale', { total, items: lineItems.length, staff: actor.staffName });
    res.status(201).json({ success: true, data: sale });
  } catch (error) {
    // Best-effort rollback if we crashed mid-way after decrementing.
    for (const done of decremented) {
      await Product.updateOne({ _id: done.product, owner: ctx.userId }, { $inc: { quantity: done.quantity } }).catch(() => {});
    }
    logger.error('Create sale error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to record sale.' });
  }
};

export const listSales = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
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

// Revenue + profit + per-rep breakdown for today / this week / this month.
export const getSalesSummary = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
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
      periodTotals(startOfDay),
      periodTotals(startOfWeek),
      periodTotals(startOfMonth),
      Sale.aggregate([
        { $match: { owner, createdAt: { $gte: startOfMonth } } },
        { $group: { _id: '$staffName', count: { $sum: 1 }, revenue: { $sum: '$total' } } },
        { $sort: { revenue: -1 } },
      ]),
      Sale.aggregate([
        { $match: { owner, createdAt: { $gte: startOfMonth } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.productName', qty: { $sum: '$items.quantity' }, revenue: { $sum: '$items.lineTotal' } } },
        { $sort: { qty: -1 } },
        { $limit: 10 },
      ]),
    ]);

    res.json({ success: true, data: { today, week, month, byStaff, topProducts } });
  } catch (error) {
    logger.error('Sales summary error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load sales summary.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMERS — light CRM derived from sales that captured a phone number
// ─────────────────────────────────────────────────────────────────────────────
export const listCustomers = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  try {
    const owner = new mongoose.Types.ObjectId(ctx.userId);
    const customers = await Sale.aggregate([
      { $match: { owner, customerPhone: { $ne: null } } },
      { $group: {
        _id: '$customerPhone',
        name: { $last: '$customerName' },
        visits: { $sum: 1 },
        totalSpent: { $sum: '$total' },
        lastVisit: { $max: '$createdAt' },
      } },
      { $sort: { totalSpent: -1 } },
      { $limit: 300 },
    ]);
    res.json({ success: true, data: customers.map((c) => ({ phone: c._id, ...c, _id: undefined })) });
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
    const staff = await StaffMember.find({ owner: ctx.userId }).sort({ createdAt: 1 }).lean();
    res.json({ success: true, data: staff }); // pinHash excluded by select:false
  } catch (error) {
    logger.error('List staff error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load staff.' });
  }
};

export const createStaff = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  const { name, pin } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Staff name is required.' });
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ success: false, message: 'PIN must be 4–6 digits.' });

  // Reps are a paid feature — they're the core of the theft-tracking story.
  if (!isAddonActive(ctx.user)) {
    return res.status(402).json({
      success: false,
      message: 'Adding sales reps is part of the Business Suite upgrade. Upgrade to give each rep their own tracked PIN login.',
      code: 'STAFF_REQUIRES_UPGRADE',
    });
  }

  try {
    const pinHash = await StaffMember.hashPin(pin);
    const staff = await StaffMember.create({
      owner: ctx.userId, name: name.trim(),
      role: req.body.role === 'manager' ? 'manager' : 'rep',
      pinHash,
    });
    const obj = staff.toObject(); delete obj.pinHash;
    res.status(201).json({ success: true, data: obj });
  } catch (error) {
    logger.error('Create staff error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to add staff.' });
  }
};

export const updateStaff = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  try {
    const set = pick(req.body, ['name', 'role', 'isActive']);
    if (req.body.pin !== undefined) {
      if (!/^\d{4,6}$/.test(String(req.body.pin))) return res.status(400).json({ success: false, message: 'PIN must be 4–6 digits.' });
      set.pinHash = await StaffMember.hashPin(req.body.pin);
    }
    const staff = await StaffMember.findOneAndUpdate(
      { _id: req.params.id, owner: ctx.userId }, { $set: set }, { new: true },
    );
    if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found.' });
    res.json({ success: true, data: staff });
  } catch (error) {
    logger.error('Update staff error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update staff.' });
  }
};

export const deleteStaff = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  try {
    // Soft delete — keeps their name on historical sales/movements.
    const staff = await StaffMember.findOneAndUpdate(
      { _id: req.params.id, owner: ctx.userId }, { $set: { isActive: false } }, { new: true },
    );
    if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found.' });
    res.json({ success: true, message: 'Staff member deactivated.' });
  } catch (error) {
    logger.error('Delete staff error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to remove staff.' });
  }
};

// Rep "sign-in" on the shared device: exchange a PIN for the staff identity the
// app then stamps onto every sale/movement. Owner account auth already gates
// the request; this just resolves WHICH rep is acting.
export const verifyStaffPin = async (req, res) => {
  const ctx = await requireOwner(req, res);
  if (!ctx) return;
  const { staffId, pin } = req.body;
  if (!staffId || !mongoose.isValidObjectId(staffId) || !pin) {
    return res.status(400).json({ success: false, message: 'Select your name and enter your PIN.' });
  }
  try {
    const staff = await StaffMember.findOne({ _id: staffId, owner: ctx.userId, isActive: true }).select('+pinHash');
    if (!staff || !(await staff.comparePin(pin))) {
      return res.status(401).json({ success: false, message: 'Incorrect PIN.' });
    }
    staff.lastActiveAt = new Date();
    await staff.save();
    res.json({ success: true, data: { _id: staff._id, name: staff.name, role: staff.role } });
  } catch (error) {
    logger.error('Verify staff pin error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to verify PIN.' });
  }
};
