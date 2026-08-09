// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — marketplace moderation. Aggregate/oversight only, mirroring the
// privacy stance of the other admin controllers. adminProtect-gated.
// ─────────────────────────────────────────────────────────────────────────────

import Listing from '../models/Listing.js';
import Report  from '../models/Report.js';
import { purgeListingImages } from './market.controller.js';
import { sendPushToUser } from '../services/pushNotification.service.js';
import logger  from '../lib/logger.js';

// GET /api/admin/market/stats — headline numbers for the dashboard.
export const getMarketStats = async (_req, res) => {
  try {
    const [byKind, byStatus, openReports, flagged] = await Promise.all([
      Listing.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$kind', total: { $sum: 1 } } }]),
      Listing.aggregate([{ $group: { _id: '$status', total: { $sum: 1 } } }]),
      Report.countDocuments({ status: 'open' }),
      Listing.countDocuments({ isFlagged: true, status: { $ne: 'removed' } }),
    ]);
    const kind = {}; for (const r of byKind) kind[r._id] = r.total;
    const status = {}; for (const r of byStatus) status[r._id] = r.total;
    return res.json({ success: true, data: { kind, status, openReports, flagged } });
  } catch (error) {
    logger.error('Admin market stats error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load marketplace stats.' });
  }
};

// GET /api/admin/market/reports — open reports with their listings.
export const listReports = async (req, res) => {
  const status = ['open', 'reviewed', 'actioned', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  try {
    const reports = await Report.find({ status })
      .populate({ path: 'listing', select: 'title kind price status images seller reportCount isFlagged', populate: { path: 'seller', select: 'name email' } })
      .populate('reporter', 'name email')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return res.json({ success: true, data: reports });
  } catch (error) {
    logger.error('Admin list reports error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load reports.' });
  }
};

// GET /api/admin/market/listings — browse all listings (optional ?status= &?flagged=1).
export const adminListListings = async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, parseInt(req.query.limit || '30', 10));
  const filter = {};
  if (['active', 'sold', 'expired', 'removed'].includes(req.query.status)) filter.status = req.query.status;
  if (req.query.flagged === '1') filter.isFlagged = true;
  try {
    const [data, total] = await Promise.all([
      Listing.find(filter).populate('seller', 'name email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Listing.countDocuments(filter),
    ]);
    return res.json({ success: true, data, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    logger.error('Admin list listings error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load listings.' });
  }
};

// POST /api/admin/market/listings/:id/remove — take a listing down.
export const adminRemoveListing = async (req, res) => {
  const reason = (req.body.reason || 'Removed by moderator').toString().slice(0, 200);
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ success: false, message: 'Listing not found.' });

    await purgeListingImages(listing);            // free Cloudinary immediately
    listing.status = 'removed';
    listing.images = [];
    listing.removedReason = reason;
    listing.isFlagged = false;
    await listing.save();

    await Report.updateMany({ listing: listing._id, status: 'open' }, { $set: { status: 'actioned', resolvedAt: new Date() } });

    sendPushToUser(
      listing.seller,
      'Listing removed',
      `Your listing "${listing.title}" was removed by our team. Reason: ${reason}`,
      { type: 'market' },
    ).catch(() => {});

    return res.json({ success: true, message: 'Listing removed and reports closed.' });
  } catch (error) {
    logger.error('Admin remove listing error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to remove listing.' });
  }
};

// POST /api/admin/market/reports/:id/dismiss — clear a report, un-hide the listing.
export const dismissReport = async (req, res) => {
  try {
    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    report.status = 'dismissed';
    report.resolvedAt = new Date();
    await report.save();

    // If no other open reports remain, clear the auto-flag so it shows again.
    const remaining = await Report.countDocuments({ listing: report.listing, status: 'open' });
    if (remaining === 0) {
      await Listing.updateOne({ _id: report.listing }, { $set: { isFlagged: false } });
    }
    return res.json({ success: true, message: 'Report dismissed.' });
  } catch (error) {
    logger.error('Dismiss report error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to dismiss report.' });
  }
};
