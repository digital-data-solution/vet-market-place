// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — job board moderation. Aggregate/oversight only, mirroring the exact
// privacy stance of admin.market.controller.js. adminProtect-gated.
// ─────────────────────────────────────────────────────────────────────────────

import JobPosting from '../models/JobPosting.js';
import JobReport  from '../models/JobReport.js';
import { sendPushToUser } from '../services/pushNotification.service.js';
import logger  from '../lib/logger.js';

// GET /api/admin/jobs/stats — headline numbers for the dashboard.
export const getJobBoardStats = async (_req, res) => {
  try {
    const [byKind, byStatus, openReports, flagged] = await Promise.all([
      JobPosting.aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$kind', total: { $sum: 1 } } }]),
      JobPosting.aggregate([{ $group: { _id: '$status', total: { $sum: 1 } } }]),
      JobReport.countDocuments({ status: 'open' }),
      JobPosting.countDocuments({ isFlagged: true, status: { $ne: 'removed' } }),
    ]);
    const kind = {}; for (const r of byKind) kind[r._id] = r.total;
    const status = {}; for (const r of byStatus) status[r._id] = r.total;
    return res.json({ success: true, data: { kind, status, openReports, flagged } });
  } catch (error) {
    logger.error('Admin job board stats error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load job board stats.' });
  }
};

// GET /api/admin/jobs/reports — open reports with their postings.
export const listJobReports = async (req, res) => {
  const status = ['open', 'reviewed', 'actioned', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  try {
    const reports = await JobReport.find({ status })
      .populate({ path: 'jobPosting', select: 'title kind status poster reportCount isFlagged', populate: { path: 'poster', select: 'name email' } })
      .populate('reporter', 'name email')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return res.json({ success: true, data: reports });
  } catch (error) {
    logger.error('Admin list job reports error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load reports.' });
  }
};

// GET /api/admin/jobs/postings — browse all postings (optional ?status= &?flagged=1).
export const adminListJobPostings = async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, parseInt(req.query.limit || '30', 10));
  const filter = {};
  if (['active', 'filled', 'expired', 'removed'].includes(req.query.status)) filter.status = req.query.status;
  if (req.query.flagged === '1') filter.isFlagged = true;
  try {
    const [data, total] = await Promise.all([
      JobPosting.find(filter).populate('poster', 'name email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      JobPosting.countDocuments(filter),
    ]);
    return res.json({ success: true, data, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    logger.error('Admin list job postings error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load job postings.' });
  }
};

// POST /api/admin/jobs/postings/:id/remove — take a posting down.
export const adminRemoveJobPosting = async (req, res) => {
  const reason = (req.body.reason || 'Removed by moderator').toString().slice(0, 200);
  try {
    const posting = await JobPosting.findById(req.params.id);
    if (!posting) return res.status(404).json({ success: false, message: 'Job posting not found.' });

    posting.status = 'removed';
    posting.removedReason = reason;
    posting.isFlagged = false;
    await posting.save();

    await JobReport.updateMany({ jobPosting: posting._id, status: 'open' }, { $set: { status: 'actioned', resolvedAt: new Date() } });

    sendPushToUser(
      posting.poster,
      'Job posting removed',
      `Your posting "${posting.title}" was removed by our team. Reason: ${reason}`,
      { type: 'jobboard' },
    ).catch(() => {});

    return res.json({ success: true, message: 'Job posting removed and reports closed.' });
  } catch (error) {
    logger.error('Admin remove job posting error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to remove job posting.' });
  }
};

// POST /api/admin/jobs/reports/:id/dismiss — clear a report, un-hide the posting.
export const dismissJobReport = async (req, res) => {
  try {
    const report = await JobReport.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found.' });
    report.status = 'dismissed';
    report.resolvedAt = new Date();
    await report.save();

    const remaining = await JobReport.countDocuments({ jobPosting: report.jobPosting, status: 'open' });
    if (remaining === 0) {
      await JobPosting.updateOne({ _id: report.jobPosting }, { $set: { isFlagged: false } });
    }
    return res.json({ success: true, message: 'Report dismissed.' });
  } catch (error) {
    logger.error('Dismiss job report error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to dismiss report.' });
  }
};
