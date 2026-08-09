// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS REPORTS — receipts, daily transaction view + CSV, one-tap day close
// with cash reconciliation, and monthly balancing.
//
// Day boundaries respect the shop's timezone (BusinessProfile.tzOffsetMinutes,
// default +60 = WAT) so "today" and each day's close never bleed across UTC
// midnight. Auth via businessAuth (owner OR staff token); reads require the
// viewReports permission (owner always passes). Isolated by owner on every query.
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from 'mongoose';
import Sale from '../models/Sale.js';
import User from '../models/User.js';
import BusinessProfile from '../models/BusinessProfile.js';
import DayClose from '../models/DayClose.js';
import logger from '../lib/logger.js';

const BUSINESS_ROLES = ['shop_owner', 'vet', 'kennel_owner'];

// Resolve the owner tenant + staff actor set by businessAuth. Returns
// { ownerId, staff } or null (after sending an error).
async function ctxFor(req, res, { needReports = false } = {}) {
  const ownerId = req.businessOwnerId || req.user?._id || req.user?.id;
  if (!ownerId) { res.status(401).json({ success: false, message: 'Not authorized.' }); return null; }
  if (!req.staffActor) {
    const user = await User.findById(ownerId).select('role');
    if (!user || !BUSINESS_ROLES.includes(user.role)) {
      res.status(403).json({ success: false, message: 'Business reports are for shops, vets and kennels.' });
      return null;
    }
  } else if (needReports && !req.staffActor.permissions?.viewReports) {
    res.status(403).json({ success: false, message: "You don't have permission to view reports. Ask the owner." });
    return null;
  }
  return { ownerId: String(ownerId), staff: req.staffActor || null };
}

// ── timezone-aware day helpers ───────────────────────────────────────────────
function tzString(min) {
  const sign = min >= 0 ? '+' : '-';
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
function todayStr(offsetMin) {
  return new Date(Date.now() + offsetMin * 60000).toISOString().slice(0, 10);
}
function dayRange(dateStr, offsetMin) {
  const start = new Date(new Date(`${dateStr}T00:00:00.000Z`).getTime() - offsetMin * 60000);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}
function monthRange(ym, offsetMin) {
  const [y, m] = ym.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) - offsetMin * 60000);
  const end   = new Date(Date.UTC(y, m, 1) - offsetMin * 60000);
  return { start, end };
}
async function offsetFor(ownerId) {
  const p = await BusinessProfile.findOne({ owner: ownerId }).select('tzOffsetMinutes').lean();
  return typeof p?.tzOffsetMinutes === 'number' ? p.tzOffsetMinutes : 60;
}
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendCsv(res, filename, rows) {
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + csv); // BOM so Excel reads UTF-8/₦ correctly
}

async function summariseDay(ownerId, start, end) {
  const owner = new mongoose.Types.ObjectId(ownerId);
  const sales = await Sale.find({ owner, createdAt: { $gte: start, $lt: end } }).sort({ createdAt: 1 }).lean();
  const totals = { salesCount: sales.length, gross: 0, discountTotal: 0, net: 0, costTotal: 0, profit: 0 };
  const byMethod = { cash: 0, transfer: 0, card: 0, wallet: 0, credit: 0 };
  const staffMap = new Map();
  for (const s of sales) {
    totals.gross += s.subtotal || 0;
    totals.discountTotal += s.discount || 0;
    totals.net += s.total || 0;
    totals.costTotal += s.costTotal || 0;
    if (byMethod[s.paymentMethod] !== undefined) byMethod[s.paymentMethod] += s.total || 0;
    const k = s.staffName || 'Owner';
    const cur = staffMap.get(k) || { staffName: k, count: 0, revenue: 0 };
    cur.count += 1; cur.revenue += s.total || 0;
    staffMap.set(k, cur);
  }
  totals.profit = totals.net - totals.costTotal;
  return { sales, totals, byMethod, byStaff: [...staffMap.values()].sort((a, b) => b.revenue - a.revenue) };
}

// ── BUSINESS PROFILE (receipt identity) ──────────────────────────────────────
export const getBusinessProfile = async (req, res) => {
  const ctx = await ctxFor(req, res);
  if (!ctx) return;
  try {
    const profile = await BusinessProfile.findOne({ owner: ctx.ownerId }).lean();
    res.json({ success: true, data: profile || { owner: ctx.ownerId, tzOffsetMinutes: 60, footerNote: 'Thank you for your patronage!' } });
  } catch (error) {
    logger.error('Get business profile error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load business profile.' });
  }
};

export const updateBusinessProfile = async (req, res) => {
  const ctx = await ctxFor(req, res);
  if (!ctx) return;
  if (ctx.staff) return res.status(403).json({ success: false, message: 'Only the owner can edit receipt settings.' });
  try {
    const set = {};
    for (const k of ['headerName', 'logoUrl', 'addressLine', 'phone', 'email', 'footerNote', 'receiptPrefix', 'currency', 'currencySymbol', 'locale']) {
      if (req.body[k] !== undefined) set[k] = req.body[k];
    }
    if (req.body.tzOffsetMinutes !== undefined && !isNaN(Number(req.body.tzOffsetMinutes))) set.tzOffsetMinutes = Number(req.body.tzOffsetMinutes);
    const profile = await BusinessProfile.findOneAndUpdate({ owner: ctx.ownerId }, { $set: set }, { new: true, upsert: true, setDefaultsOnInsert: true });
    res.json({ success: true, data: profile });
  } catch (error) {
    logger.error('Update business profile error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to save business profile.' });
  }
};

// ── RECEIPT (data for a printable/shareable receipt) ─────────────────────────
export const getReceipt = async (req, res) => {
  const ctx = await ctxFor(req, res);
  if (!ctx) return;
  try {
    const sale = await Sale.findOne({ _id: req.params.saleId, owner: ctx.ownerId }).lean();
    if (!sale) return res.status(404).json({ success: false, message: 'Sale not found.' });
    const profile = await BusinessProfile.findOne({ owner: ctx.ownerId }).lean();
    const prefix = profile?.receiptPrefix ? `${profile.receiptPrefix}-` : '';
    const receiptNo = `${prefix}${String(sale._id).slice(-6).toUpperCase()}`;
    res.json({ success: true, data: {
      business: {
        headerName: profile?.headerName || null, logoUrl: profile?.logoUrl || null,
        addressLine: profile?.addressLine || null, phone: profile?.phone || null,
        email: profile?.email || null, footerNote: profile?.footerNote || 'Thank you for your patronage!',
        currency: profile?.currency || 'NGN', currencySymbol: profile?.currencySymbol || '₦', locale: profile?.locale || 'en',
      },
      receiptNo, sale,
    } });
  } catch (error) {
    logger.error('Get receipt error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load receipt.' });
  }
};

// ── DAY VIEW + CSV ───────────────────────────────────────────────────────────
export const getDay = async (req, res) => {
  const ctx = await ctxFor(req, res, { needReports: true });
  if (!ctx) return;
  try {
    const offset = await offsetFor(ctx.ownerId);
    const dateStr = (req.query.date || todayStr(offset)).slice(0, 10);
    const { start, end } = dayRange(dateStr, offset);
    const day = await summariseDay(ctx.ownerId, start, end);
    const closed = await DayClose.findOne({ owner: ctx.ownerId, dateStr }).lean();
    res.json({ success: true, data: { dateStr, ...day, closed: closed || null } });
  } catch (error) {
    logger.error('Get day error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load the day.' });
  }
};

export const getDayCsv = async (req, res) => {
  const ctx = await ctxFor(req, res, { needReports: true });
  if (!ctx) return;
  try {
    const offset = await offsetFor(ctx.ownerId);
    const dateStr = (req.query.date || todayStr(offset)).slice(0, 10);
    const { start, end } = dayRange(dateStr, offset);
    const { sales } = await summariseDay(ctx.ownerId, start, end);
    const rows = [['Time', 'Receipt', 'Items', 'Subtotal', 'Discount', 'Total', 'Payment', 'Staff', 'Customer', 'Phone']];
    for (const s of sales) {
      rows.push([
        new Date(s.createdAt).toISOString(),
        String(s._id).slice(-6).toUpperCase(),
        (s.items || []).map((i) => `${i.quantity}x ${i.productName}`).join('; '),
        s.subtotal || 0, s.discount || 0, s.total || 0,
        s.paymentMethod || '', s.staffName || 'Owner', s.customerName || '', s.customerPhone || '',
      ]);
    }
    sendCsv(res, `sales-${dateStr}.csv`, rows);
  } catch (error) {
    logger.error('Get day csv error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to export CSV.' });
  }
};

// ── DAY CLOSE (Z report) with cash reconciliation ────────────────────────────
export const closeDay = async (req, res) => {
  const ctx = await ctxFor(req, res, { needReports: true });
  if (!ctx) return;
  try {
    const offset = await offsetFor(ctx.ownerId);
    const dateStr = (req.body.date || todayStr(offset)).slice(0, 10);
    const { start, end } = dayRange(dateStr, offset);
    const { totals, byMethod, byStaff } = await summariseDay(ctx.ownerId, start, end);

    const openingFloat = Math.max(0, Number(req.body.openingFloat) || 0);
    const expectedCash = openingFloat + byMethod.cash;
    const hasCount = req.body.countedCash !== undefined && req.body.countedCash !== null && req.body.countedCash !== '';
    const countedCash = hasCount ? Number(req.body.countedCash) : null;
    const variance = hasCount ? countedCash - expectedCash : 0;

    const doc = {
      owner: ctx.ownerId, dateStr,
      salesCount: totals.salesCount, gross: totals.gross, discountTotal: totals.discountTotal,
      net: totals.net, costTotal: totals.costTotal, profit: totals.profit,
      byMethod, byStaff,
      openingFloat, expectedCash, countedCash, variance,
      closedByName: ctx.staff?.name || 'Owner', closedAt: new Date(),
      note: req.body.note || null,
    };
    const close = await DayClose.findOneAndUpdate({ owner: ctx.ownerId, dateStr }, { $set: doc }, { new: true, upsert: true, setDefaultsOnInsert: true });
    res.json({ success: true, data: close });
  } catch (error) {
    logger.error('Close day error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to close the day.' });
  }
};

export const listDayCloses = async (req, res) => {
  const ctx = await ctxFor(req, res, { needReports: true });
  if (!ctx) return;
  try {
    const filter = { owner: ctx.ownerId };
    if (req.query.ym) filter.dateStr = { $regex: `^${req.query.ym}` };
    const closes = await DayClose.find(filter).sort({ dateStr: -1 }).limit(120).lean();
    res.json({ success: true, data: closes });
  } catch (error) {
    logger.error('List day closes error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load day closes.' });
  }
};

// ── MONTHLY BALANCING ────────────────────────────────────────────────────────
async function monthRollup(ownerId, ym, offset) {
  const owner = new mongoose.Types.ObjectId(ownerId);
  const { start, end } = monthRange(ym, offset);
  const tz = tzString(offset);
  const perDay = await Sale.aggregate([
    { $match: { owner, createdAt: { $gte: start, $lt: end } } },
    { $group: {
      _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } },
      salesCount: { $sum: 1 }, net: { $sum: '$total' }, cost: { $sum: '$costTotal' }, discount: { $sum: '$discount' },
    } },
    { $sort: { _id: 1 } },
  ]);
  const days = perDay.map((d) => ({ dateStr: d._id, salesCount: d.salesCount, net: d.net, discount: d.discount, profit: d.net - d.cost }));
  const totals = days.reduce((t, d) => ({ salesCount: t.salesCount + d.salesCount, net: t.net + d.net, profit: t.profit + d.profit, discount: t.discount + d.discount }),
    { salesCount: 0, net: 0, profit: 0, discount: 0 });
  return { days, totals };
}

export const getMonth = async (req, res) => {
  const ctx = await ctxFor(req, res, { needReports: true });
  if (!ctx) return;
  try {
    const offset = await offsetFor(ctx.ownerId);
    const ym = (req.query.ym || todayStr(offset).slice(0, 7)).slice(0, 7);
    const { days, totals } = await monthRollup(ctx.ownerId, ym, offset);
    const closes = await DayClose.find({ owner: ctx.ownerId, dateStr: { $regex: `^${ym}` } }).select('dateStr variance closedAt closedByName').lean();
    const closedMap = Object.fromEntries(closes.map((c) => [c.dateStr, c]));
    res.json({ success: true, data: { ym, totals, days: days.map((d) => ({ ...d, close: closedMap[d.dateStr] || null })) } });
  } catch (error) {
    logger.error('Get month error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to load month.' });
  }
};

export const getMonthCsv = async (req, res) => {
  const ctx = await ctxFor(req, res, { needReports: true });
  if (!ctx) return;
  try {
    const offset = await offsetFor(ctx.ownerId);
    const ym = (req.query.ym || todayStr(offset).slice(0, 7)).slice(0, 7);
    const { days, totals } = await monthRollup(ctx.ownerId, ym, offset);
    const rows = [['Date', 'Sales', 'Discount', 'Net', 'Profit']];
    for (const d of days) rows.push([d.dateStr, d.salesCount, d.discount, d.net, d.profit]);
    rows.push(['TOTAL', totals.salesCount, totals.discount, totals.net, totals.profit]);
    sendCsv(res, `monthly-${ym}.csv`, rows);
  } catch (error) {
    logger.error('Get month csv error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to export monthly CSV.' });
  }
};
