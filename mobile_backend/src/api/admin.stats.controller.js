/**
 * admin.stats.controller.js
 *
 * Business-intelligence endpoints consumed exclusively by the admin dashboard.
 * All routes are protected by adminProtect in app.js — do not call these from
 * the mobile app.
 *
 * Endpoints:
 *   GET /api/admin/stats/revenue       — MRR, trend, expiry calendar, pending
 *   GET /api/admin/stats/growth        — signups, DAU/WAU/MAU, dormant users
 *   GET /api/admin/stats/verification  — queue health, audit log, rates
 *   GET /api/admin/stats/referrals     — funnel, top referrers, reward cost
 *   GET /api/admin/stats/practice      — Practice Records + marketing campaign adoption (aggregate only, no clinical data)
 *   GET /api/admin/stats/content       — gallery, profile completeness
 *   GET /api/admin/stats/geographic    — density by region (from address field)
 *   GET /api/admin/stats/messaging     — Supabase chat activity
 *   GET /api/admin/stats/system        — Redis, Mongo, uptime
 *   GET /api/admin/export/users        — CSV download
 *   GET /api/admin/export/subscriptions — CSV download
 *   GET /api/admin/export/professionals — CSV download
 */

import User         from '../models/User.js';
import Professional from '../models/Professional.js';
import Subscription from '../models/Subscription.js';
import Shop         from '../models/Shop.js';
import ActivityLog  from '../models/ActivityLog.js';
import Client       from '../models/Client.js';
import Patient      from '../models/Patient.js';
import EmailLog     from '../models/EmailLog.js';
import Product      from '../models/Product.js';
import Sale         from '../models/Sale.js';
import StaffMember  from '../models/StaffMember.js';
import cache        from '../lib/cache.js';
import logger       from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { PRACTICE_PACKAGES } from './practice.controller.js';
import { BUSINESS_PACKAGES } from './business.controller.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function csvRow(fields) {
  return fields.map(f => {
    const s = String(f ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  }).join(',');
}

// Extract a rough region label from a Nigerian address string.
// Looks for common state/city names in the address; falls back to "Other".
const NG_STATES = [
  'Lagos','Abuja','FCT','Kano','Ibadan','Oyo','Rivers','Port Harcourt',
  'Kaduna','Enugu','Anambra','Onitsha','Benin','Edo','Delta','Warri',
  'Imo','Owerri','Abia','Katsina','Sokoto','Kwara','Ilorin','Osun',
  'Abeokuta','Ogun','Ekiti','Ondo','Cross River','Calabar','Akwa Ibom',
  'Uyo','Bauchi','Plateau','Jos','Niger','Minna','Adamawa','Yola',
  'Taraba','Borno','Maiduguri','Gombe','Bayelsa','Yenagoa','Nasarawa',
  'Kebbi','Zamfara','Jigawa','Ebonyi','Abakaliki','Kogi','Lokoja',
];

function extractRegion(address) {
  if (!address) return 'Other';
  const lower = address.toLowerCase();
  for (const state of NG_STATES) {
    if (lower.includes(state.toLowerCase())) return state;
  }
  // Fall back to last comma-delimited part
  const parts = address.split(',').map(s => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || 'Other';
}

// ─── Revenue ─────────────────────────────────────────────────────────────────

export const getRevenueStats = async (req, res) => {
  try {
    const now    = new Date();
    const in7    = addDays(now,  7);
    const in14   = addDays(now, 14);
    const in30   = addDays(now, 30);
    const ago180 = daysAgo(180);

    const [
      activeSubs,
      planBreakdown,
      expiringIn7,
      expiringIn14,
      expiringIn30,
      pendingSubs,
      trend,
    ] = await Promise.all([
      // MRR = sum of all active amounts
      Subscription.aggregate([
        { $match: { status: 'active', endDate: { $gte: now } } },
        { $group: { _id: null, mrr: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),

      // Breakdown by plan (active only)
      Subscription.aggregate([
        { $match: { status: 'active', endDate: { $gte: now } } },
        { $group: { _id: '$plan', count: { $sum: 1 }, revenue: { $sum: '$amount' } } },
        { $sort: { revenue: -1 } },
      ]),

      // Expiry windows
      Subscription.countDocuments({ status: 'active', endDate: { $gte: now,  $lt: in7  } }),
      Subscription.countDocuments({ status: 'active', endDate: { $gte: in7,  $lt: in14 } }),
      Subscription.countDocuments({ status: 'active', endDate: { $gte: in14, $lt: in30 } }),

      // Stuck pending payments (>30 min old)
      Subscription.find({
        status: 'pending',
        createdAt: { $lt: new Date(now - 30 * 60 * 1000) },
      })
        .populate('user', 'name email')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),

      // Monthly revenue trend (last 6 months)
      Subscription.aggregate([
        { $match: { createdAt: { $gte: ago180 } } },
        {
          $group: {
            _id:     { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
            revenue: { $sum: '$amount' },
            count:   { $sum: 1 },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),
    ]);

    const mrr      = activeSubs[0]?.mrr   || 0;
    const activeCount = activeSubs[0]?.count || 0;

    return res.json({
      success: true,
      data: {
        mrr,
        activeCount,
        planBreakdown,
        expiring: { in7: expiringIn7, in14: expiringIn14, in30: expiringIn30 },
        pendingSubs,
        trend: trend.map(t => ({
          label:   `${t._id.year}-${String(t._id.month).padStart(2, '0')}`,
          revenue: t.revenue,
          count:   t.count,
        })),
      },
    });
  } catch (err) {
    logger.error('getRevenueStats error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch revenue stats.' });
  }
};

// ─── Growth ──────────────────────────────────────────────────────────────────

export const getGrowthStats = async (req, res) => {
  try {
    const now    = new Date();
    const ago30  = daysAgo(30);
    const ago7   = daysAgo(7);
    const ago1   = daysAgo(1);

    const [
      signupsByDay,
      signupsByRole,
      dauCount,
      wauCount,
      mauCount,
      dormantCount,
      dormantSample,
    ] = await Promise.all([
      // Daily signups for last 30 days
      User.aggregate([
        { $match: { createdAt: { $gte: ago30 } } },
        {
          $group: {
            _id:  { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
      ]),

      // Total users by role
      User.aggregate([
        { $group: { _id: '$role', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      // DAU — logged in last 24h
      User.countDocuments({ lastLoginAt: { $gte: ago1 } }),
      // WAU — logged in last 7 days
      User.countDocuments({ lastLoginAt: { $gte: ago7 } }),
      // MAU — logged in last 30 days
      User.countDocuments({ lastLoginAt: { $gte: ago30 } }),

      // Dormant — no login in 30+ days (or never logged in and created 30+ days ago)
      User.countDocuments({
        $or: [
          { lastLoginAt: { $lt: ago30 } },
          { lastLoginAt: null, createdAt: { $lt: ago30 } },
        ],
      }),

      // Sample of dormant users
      User.find({
        $or: [
          { lastLoginAt: { $lt: ago30 } },
          { lastLoginAt: null, createdAt: { $lt: ago30 } },
        ],
      })
        .select('name email role lastLoginAt createdAt')
        .sort({ lastLoginAt: 1 })
        .limit(20)
        .lean(),
    ]);

    return res.json({
      success: true,
      data: {
        signupsByDay: signupsByDay.map(d => ({
          label: `${d._id.year}-${String(d._id.month).padStart(2,'0')}-${String(d._id.day).padStart(2,'0')}`,
          count: d.count,
        })),
        signupsByRole,
        dau: dauCount,
        wau: wauCount,
        mau: mauCount,
        dormantCount,
        dormantSample,
      },
    });
  } catch (err) {
    logger.error('getGrowthStats error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch growth stats.' });
  }
};

// ─── Verification ─────────────────────────────────────────────────────────────

export const getVerificationStats = async (req, res) => {
  try {
    const ago90 = daysAgo(90);

    const [pendingVets, pendingInsurance, recentReviewed] = await Promise.all([
      // Vets awaiting VCN check (via User.vetVerification)
      User.countDocuments({ role: 'vet', 'vetVerification.status': 'pending' }),

      // Insurance providers awaiting admin approval (via Professional.verificationStatus)
      Professional.countDocuments({ role: 'insurance_provider', verificationStatus: 'pending' }),

      User.find({
        role: 'vet',
        'vetVerification.status': { $in: ['approved', 'rejected'] },
        'vetVerification.reviewedAt': { $gte: ago90 },
      })
        .select('name email vetVerification createdAt')
        .sort({ 'vetVerification.reviewedAt': -1 })
        .limit(50)
        .lean(),
    ]);

    const pendingCount = pendingVets + pendingInsurance;

    const approvedCount = recentReviewed.filter(u => u.vetVerification?.status === 'approved').length;
    const rejectedCount = recentReviewed.filter(u => u.vetVerification?.status === 'rejected').length;

    // Average review time (submittedAt → reviewedAt) in hours
    const withBothDates = recentReviewed.filter(
      u => u.vetVerification?.submittedAt && u.vetVerification?.reviewedAt,
    );
    const avgReviewHours = withBothDates.length
      ? withBothDates.reduce((sum, u) => {
          const ms = new Date(u.vetVerification.reviewedAt) - new Date(u.vetVerification.submittedAt);
          return sum + ms / (1000 * 60 * 60);
        }, 0) / withBothDates.length
      : null;

    return res.json({
      success: true,
      data: {
        pendingCount,
        pendingVets,
        pendingInsurance,
        approvedCount,
        rejectedCount,
        avgReviewHours: avgReviewHours != null ? Math.round(avgReviewHours) : null,
        approvalRate: (approvedCount + rejectedCount) > 0
          ? Math.round((approvedCount / (approvedCount + rejectedCount)) * 100)
          : null,
        recentReviews: recentReviewed.map(u => ({
          _id:        u._id,
          name:       u.name,
          email:      u.email,
          status:     u.vetVerification?.status,
          reviewedAt: u.vetVerification?.reviewedAt,
          adminNotes: u.vetVerification?.adminNotes,
        })),
      },
    });
  } catch (err) {
    logger.error('getVerificationStats error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch verification stats.' });
  }
};

// ─── Referrals ────────────────────────────────────────────────────────────────

export const getReferralStats = async (req, res) => {
  try {
    const [
      totalCodes,
      totalReferred,
      totalRewardCost,
      topReferrers,
      convertedReferrals,
    ] = await Promise.all([
      // Users who have a referral code (all users get one, but count non-null)
      User.countDocuments({ referralCode: { $ne: null, $exists: true } }),

      // Users who signed up via someone's referral code
      User.countDocuments({ referredBy: { $ne: null, $exists: true } }),

      // Total months of reward given (sum of referralRewardsEarned)
      User.aggregate([
        { $match: { referralRewardsEarned: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: '$referralRewardsEarned' } } },
      ]),

      // Top 10 referrers by rewards
      User.find({ referralRewardsEarned: { $gt: 0 } })
        .select('name email referralCode referralRewardsEarned')
        .sort({ referralRewardsEarned: -1 })
        .limit(10)
        .lean(),

      // Referred users who now have an active subscription
      Subscription.aggregate([
        { $match: { status: 'active' } },
        {
          $lookup: {
            from:         'users',
            localField:   'user',
            foreignField: '_id',
            as:           'userDoc',
          },
        },
        { $unwind: '$userDoc' },
        { $match: { 'userDoc.referredBy': { $ne: null, $exists: true } } },
        { $count: 'count' },
      ]),
    ]);

    const rewardCost   = totalRewardCost[0]?.total || 0;
    const converted    = convertedReferrals[0]?.count || 0;
    const convRate     = totalReferred > 0 ? Math.round((converted / totalReferred) * 100) : 0;

    return res.json({
      success: true,
      data: {
        totalCodes,
        totalReferred,
        converted,
        conversionRate: convRate,
        rewardCost,
        topReferrers,
      },
    });
  } catch (err) {
    logger.error('getReferralStats error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch referral stats.' });
  }
};

// ─── Practice Records + Marketing Campaigns ────────────────────────────────────
// Deliberately aggregate-only — never exposes an individual vet's clients or
// patients (that's private clinical/personal data belonging to the vet's
// relationship with their client, not Xpress Vet's to browse).
export const getPracticeStats = async (req, res) => {
  try {
    const now = new Date();
    const [
      vetsUsingIds,
      totalPatients,
      totalClients,
      addonActiveCount,
      activatedLogs,
      boostPromoSent,
      walletPromoSent,
      marketingOptOutCount,
      remindersEnabledCount,
      clientReminderOptOutCount,
    ] = await Promise.all([
      Patient.distinct('vet'),
      Patient.countDocuments({ isActive: true }),
      Client.countDocuments({}),
      Professional.countDocuments({ role: 'vet', 'practiceAddon.activeUntil': { $gt: now } }),
      // 'practice.activated' logs store `days`, not amount — reconstruct
      // revenue via the fixed package price table (see PRACTICE_PACKAGES).
      ActivityLog.find({ action: 'practice.activated' }).select('metadata').lean(),
      Professional.countDocuments({ boostPromoSentAt: { $ne: null } })
        .then(async (profCount) => profCount + await Shop.countDocuments({ boostPromoSentAt: { $ne: null } })),
      User.countDocuments({ walletPromoSentAt: { $ne: null } }),
      User.countDocuments({ marketingOptOut: true }),
      Client.countDocuments({ emailRemindersEnabled: true }),
      Client.countDocuments({ reminderOptOut: true }),
    ]);

    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const [emailsSent7d, emailsFailed7d, emailsSkipped7d] = await Promise.all([
      EmailLog.countDocuments({ status: 'sent', createdAt: { $gte: sevenDaysAgo } }),
      EmailLog.countDocuments({ status: 'failed', createdAt: { $gte: sevenDaysAgo } }),
      EmailLog.countDocuments({ status: 'skipped', createdAt: { $gte: sevenDaysAgo } }),
    ]);

    const addonRevenue = activatedLogs.reduce((sum, log) => {
      const days = log.metadata?.days;
      const price = PRACTICE_PACKAGES[days]?.price || 0;
      return sum + price;
    }, 0);

    return res.json({
      success: true,
      data: {
        practice: {
          vetsUsing: vetsUsingIds.length,
          totalPatients,
          totalClients,
          addonActiveCount,
          addonRevenue, // ₦, lifetime, derived from activation events — see comment above
        },
        marketing: {
          boostPromoSent,
          walletPromoSent,
          marketingOptOutCount,
          clientRemindersEnabledCount: remindersEnabledCount,
          clientReminderOptOutCount,
        },
        emailHealth: {
          sent7d: emailsSent7d,
          failed7d: emailsFailed7d,
          skipped7d: emailsSkipped7d, // >0 means RESEND_API_KEY/BREVO_API_KEY isn't set — nothing is actually sending
        },
      },
    });
  } catch (err) {
    logger.error('getPracticeStats error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch practice/marketing stats.' });
  }
};

// GET /api/admin/stats/business — Business Suite adoption (aggregate only, no
// per-shop inventory or sales detail; matches the practice-stats privacy stance).
export const getBusinessStats = async (req, res) => {
  try {
    const now = new Date();
    const [
      ownersUsingIds,
      totalProducts,
      totalStaff,
      addonActiveCount,
      activatedLogs,
      businessPromoSent,
      salesAgg,
      staffWithLogin,
      seatsAgg,
      seatLogs,
    ] = await Promise.all([
      Product.distinct('owner'),
      Product.countDocuments({ isActive: true }),
      StaffMember.countDocuments({ isActive: true }),
      User.countDocuments({ 'businessAddon.activeUntil': { $gt: now } }),
      // 'business.activated' logs store `days` — reconstruct revenue via the
      // fixed BUSINESS_PACKAGES price table (same approach as practice stats).
      ActivityLog.find({ action: 'business.activated' }).select('metadata').lean(),
      User.countDocuments({ businessPromoSentAt: { $ne: null } }),
      Sale.aggregate([{ $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: '$total' } } }]),
      StaffMember.countDocuments({ username: { $ne: null } }),          // staff with an individual login
      User.aggregate([{ $group: { _id: null, total: { $sum: '$businessAddon.seatsPaid' } } }]), // paid seats sold
      // 'business.seats' logs carry { seats, pricePer } — reconstruct seat revenue.
      ActivityLog.find({ action: 'business.seats' }).select('metadata').lean(),
    ]);

    const addonRevenue = activatedLogs.reduce((sum, log) => {
      const days = log.metadata?.days;
      return sum + (BUSINESS_PACKAGES[days]?.price || 0);
    }, 0);
    const seatRevenue = seatLogs.reduce((sum, log) => {
      const seats = Number(log.metadata?.seats) || 0;
      const pricePer = Number(log.metadata?.pricePer) || 0;
      return sum + seats * pricePer;
    }, 0);

    return res.json({
      success: true,
      data: {
        business: {
          ownersUsing: ownersUsingIds.length,
          totalProducts,
          totalStaff,
          addonActiveCount,
          addonRevenue, // ₦, lifetime, derived from activation events
          salesCount: salesAgg[0]?.count || 0,
          salesVolume: salesAgg[0]?.revenue || 0, // ₦ transacted through POS, all-time
          businessPromoSent,
          staffWithLogin,                        // staff members with an individual username/password
          seatsSold: seatsAgg[0]?.total || 0,    // total paid seats across all owners
          seatRevenue,                           // ₦, lifetime, from per-seat purchases
        },
      },
    });
  } catch (err) {
    logger.error('getBusinessStats error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch business stats.' });
  }
};

// ─── Content ─────────────────────────────────────────────────────────────────

export const getContentStats = async (req, res) => {
  try {
    const [
      galleryAgg,
      topUploaders,
      incompleteProfiles,
      profileViewsTop,
      roleBreakdown,
    ] = await Promise.all([
      // Total gallery images across all users
      User.aggregate([
        { $project: { count: { $size: { $ifNull: ['$mediaImages', []] } } } },
        { $group:   { _id: null, total: { $sum: '$count' }, usersWithImages: { $sum: { $cond: [{ $gt: ['$count', 0] }, 1, 0] } } } },
      ]),

      // Top uploaders
      User.aggregate([
        { $project: { name: 1, email: 1, role: 1, count: { $size: { $ifNull: ['$mediaImages', []] } } } },
        { $match:   { count: { $gt: 0 } } },
        { $sort:    { count: -1 } },
        { $limit:   10 },
      ]),

      // Incomplete professional profiles (missing key fields)
      Professional.find({
        $or: [
          { phone: { $in: [null, ''] } },
          { email: { $in: [null, ''] } },
          { specialization: { $in: [null, ''] } },
        ],
      })
        .populate('userId', 'name email')
        .select('name role address phone email specialization isVerified')
        .limit(50)
        .lean(),

      // Top 10 professionals by profile views
      Professional.find({ profileViews: { $gt: 0 } })
        .populate('userId', 'name email')
        .select('name role profileViews isVerified')
        .sort({ profileViews: -1 })
        .limit(10)
        .lean(),

      // Count of professionals per role
      Professional.aggregate([
        { $group: { _id: '$role', total: { $sum: 1 }, verified: { $sum: { $cond: ['$isVerified', 1, 0] } } } },
        { $sort: { total: -1 } },
      ]),
    ]);

    const totalImages    = galleryAgg[0]?.total           || 0;
    const usersWithImages = galleryAgg[0]?.usersWithImages || 0;

    return res.json({
      success: true,
      data: {
        totalImages,
        usersWithImages,
        topUploaders,
        incompleteProfiles,
        profileViewsTop,
        roleBreakdown,
      },
    });
  } catch (err) {
    logger.error('getContentStats error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch content stats.' });
  }
};

// ─── Geographic ──────────────────────────────────────────────────────────────

export const getGeographicStats = async (req, res) => {
  try {
    const [professionals, shops] = await Promise.all([
      Professional.find({ address: { $ne: null, $exists: true } })
        .select('address role isVerified')
        .lean(),
      Shop.find({ address: { $ne: null, $exists: true } })
        .select('address name isVerified')
        .lean(),
    ]);

    // Tally by region
    const regionMap = {};

    for (const p of professionals) {
      const region = extractRegion(p.address);
      if (!regionMap[region]) regionMap[region] = { region, byRole: {}, shops: 0, total: 0 };
      regionMap[region].byRole[p.role] = (regionMap[region].byRole[p.role] || 0) + 1;
      regionMap[region].total++;
    }

    for (const s of shops) {
      const region = extractRegion(s.address);
      if (!regionMap[region]) regionMap[region] = { region, byRole: {}, shops: 0, total: 0 };
      regionMap[region].shops++;
      regionMap[region].total++;
    }

    const byRegion = Object.values(regionMap).sort((a, b) => b.total - a.total);

    return res.json({ success: true, data: { byRegion } });
  } catch (err) {
    logger.error('getGeographicStats error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch geographic stats.' });
  }
};

// ─── Messaging ───────────────────────────────────────────────────────────────

export const getMessagingStats = async (req, res) => {
  try {
    // Query Supabase messages table — falls back gracefully if table doesn't exist
    const [totalResult, recentResult] = await Promise.all([
      supabaseAdmin.from('messages').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('messages')
        .select('sender_id, receiver_id, created_at')
        .order('created_at', { ascending: false })
        .limit(1),
    ]);

    const totalMessages = totalResult.count ?? 0;

    // Unique conversations in last 7 days
    const ago7 = daysAgo(7);
    const recentConvResult = await supabaseAdmin
      .from('messages')
      .select('sender_id, receiver_id', { count: 'exact' })
      .gte('created_at', ago7.toISOString());

    // Rough distinct-conversation count: pairs
    const recentRows = recentConvResult.data || [];
    const pairSet    = new Set(
      recentRows.map(m => [m.sender_id, m.receiver_id].sort().join(':'))
    );

    return res.json({
      success: true,
      data: {
        totalMessages,
        activeConversations7d: pairSet.size,
        lastMessageAt: recentResult.data?.[0]?.created_at || null,
        supabaseError: totalResult.error?.message || null,
      },
    });
  } catch (err) {
    logger.error('getMessagingStats error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch messaging stats.' });
  }
};

// ─── System Health ────────────────────────────────────────────────────────────

export const getSystemHealth = async (req, res) => {
  try {
    // Redis ping
    let redisStatus = 'unknown';
    try {
      const pong = await cache.cacheGet('__health_ping__');
      await cache.cacheSet('__health_ping__', 'pong', 60);
      redisStatus = 'ok';
    } catch {
      redisStatus = 'error';
    }

    // MongoDB readyState: 0=disconnected 1=connected 2=connecting 3=disconnecting
    const mongoose = (await import('mongoose')).default;
    const mongoState = ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown';

    const uptimeSeconds = Math.floor(process.uptime());
    const uptimeStr = `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`;

    const memUsage = process.memoryUsage();

    return res.json({
      success: true,
      data: {
        redis:       redisStatus,
        mongo:       mongoState,
        uptimeSeconds,
        uptimeStr,
        nodeVersion: process.version,
        memoryMb: {
          rss:      Math.round(memUsage.rss        / 1024 / 1024),
          heapUsed: Math.round(memUsage.heapUsed   / 1024 / 1024),
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        },
      },
    });
  } catch (err) {
    logger.error('getSystemHealth error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch system health.' });
  }
};

// ─── CSV Exports ──────────────────────────────────────────────────────────────

export const exportUsers = async (req, res) => {
  try {
    const users = await User.find()
      .select('name email role isVerified referralCode referredBy referralRewardsEarned lastLoginAt createdAt')
      .lean();

    const headers = ['Name','Email','Role','Verified','Referral Code','Referred By','Rewards Earned (months)','Last Login','Joined'];
    const rows = [
      headers.join(','),
      ...users.map(u => csvRow([
        u.name,
        u.email,
        u.role,
        u.isVerified ? 'Yes' : 'No',
        u.referralCode || '',
        u.referredBy   || '',
        u.referralRewardsEarned || 0,
        u.lastLoginAt  ? new Date(u.lastLoginAt).toISOString()  : '',
        u.createdAt    ? new Date(u.createdAt).toISOString()    : '',
      ])),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
    return res.send(rows.join('\n'));
  } catch (err) {
    logger.error('exportUsers error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to export users.' });
  }
};

export const exportSubscriptions = async (req, res) => {
  try {
    const subs = await Subscription.find()
      .populate('user', 'name email role')
      .lean();

    const headers = ['User Name','Email','Role','Plan','Amount (NGN)','Status','Start Date','End Date','Payment Ref','Created'];
    const rows = [
      headers.join(','),
      ...subs.map(s => csvRow([
        s.user?.name        || '',
        s.user?.email       || '',
        s.user?.role        || '',
        s.plan              || '',
        s.amount            || 0,
        s.status            || '',
        s.startDate         ? new Date(s.startDate).toISOString()  : '',
        s.endDate           ? new Date(s.endDate).toISOString()    : '',
        s.paymentReference  || '',
        s.createdAt         ? new Date(s.createdAt).toISOString()  : '',
      ])),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="subscriptions.csv"');
    return res.send(rows.join('\n'));
  } catch (err) {
    logger.error('exportSubscriptions error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to export subscriptions.' });
  }
};

// ─── Activity Feed & Search Analytics ────────────────────────────────────────

export const getActivityStats = async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const ago7  = daysAgo(7);
    const ago30 = daysAgo(30);

    const [
      recentFeed,
      todayCounts,
      searchBreakdown,
      contactTapBreakdown,
      subFunnel,
    ] = await Promise.all([
      // Last 50 events for the live feed, newest first
      ActivityLog.find()
        .sort({ timestamp: -1 })
        .limit(50)
        .populate('user', 'name email role')
        .lean(),

      // Today's event counts grouped by action
      ActivityLog.aggregate([
        { $match: { timestamp: { $gte: todayStart } } },
        { $group: { _id: '$action', count: { $sum: 1 } } },
      ]),

      // Top searched roles in the last 7 days
      ActivityLog.aggregate([
        {
          $match: {
            action:           { $in: ['search.list', 'search.nearby'] },
            timestamp:        { $gte: ago7 },
            'metadata.role':  { $ne: null, $exists: true },
          },
        },
        { $group: { _id: '$metadata.role', count: { $sum: 1 } } },
        { $sort:  { count: -1 } },
        { $limit: 8 },
      ]),

      // Contact tap breakdown by method (phone/whatsapp/email) in last 7 days
      ActivityLog.aggregate([
        { $match: { action: 'contact.tapped', timestamp: { $gte: ago7 } } },
        { $group: { _id: '$metadata.method', count: { $sum: 1 } } },
        { $sort:  { count: -1 } },
      ]),

      // Subscription funnel: initiated vs activated in last 30 days
      ActivityLog.aggregate([
        {
          $match: {
            action:    { $in: ['subscription.initiated', 'subscription.activated'] },
            timestamp: { $gte: ago30 },
          },
        },
        { $group: { _id: '$action', count: { $sum: 1 } } },
      ]),
    ]);

    // Flatten today's counts into a lookup map
    const todayMap = {};
    for (const t of todayCounts) todayMap[t._id] = t.count;

    // Subscription funnel totals
    const funnel = { initiated: 0, activated: 0 };
    for (const f of subFunnel) {
      if (f._id === 'subscription.initiated') funnel.initiated = f.count;
      if (f._id === 'subscription.activated') funnel.activated  = f.count;
    }

    return res.json({
      success: true,
      data: {
        recentFeed,
        todaySignups:      todayMap['user.register']  || 0,
        todayLogins:       todayMap['user.login']     || 0,
        todaySearches:     (todayMap['search.list'] || 0) + (todayMap['search.nearby'] || 0),
        todayMessages:     todayMap['message.sent']   || 0,
        todayContactTaps:  todayMap['contact.tapped'] || 0,
        searchBreakdown,
        contactTapBreakdown,
        subFunnel: funnel,
      },
    });
  } catch (err) {
    logger.error('getActivityStats error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch activity stats.' });
  }
};

// ─── UTM Attribution ─────────────────────────────────────────────────────────

export const getUtmStats = async (req, res) => {
  try {
    const [bySource, byCampaign, byMedium, utmCount, total] = await Promise.all([
      User.aggregate([
        { $match: { 'utm.source': { $ne: null } } },
        { $group: { _id: '$utm.source', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      User.aggregate([
        { $match: { 'utm.campaign': { $ne: null } } },
        { $group: { _id: '$utm.campaign', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      User.aggregate([
        { $match: { 'utm.medium': { $ne: null } } },
        { $group: { _id: '$utm.medium', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      User.countDocuments({ 'utm.source': { $ne: null } }),
      User.countDocuments({ role: { $ne: 'admin' } }),
    ]);

    return res.json({
      success: true,
      data: {
        utmCount,
        total,
        attributedPct: total > 0 ? Math.round((utmCount / total) * 100) : 0,
        bySource,
        byCampaign,
        byMedium,
      },
    });
  } catch (err) {
    logger.error('getUtmStats error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch UTM stats.' });
  }
};

// ─── CSV Exports ──────────────────────────────────────────────────────────────

export const exportProfessionals = async (req, res) => {
  try {
    const pros = await Professional.find()
      .populate('userId', 'name email lastLoginAt createdAt')
      .lean();

    const headers = ['Name','Email','Role','Business Name','Address','Phone','Specialization','Verified','Status','Profile Views','Joined'];
    const rows = [
      headers.join(','),
      ...pros.map(p => csvRow([
        p.userId?.name      || p.name     || '',
        p.userId?.email     || p.email    || '',
        p.role              || '',
        p.businessName      || '',
        p.address           || '',
        p.phone             || '',
        p.specialization    || '',
        p.isVerified        ? 'Yes' : 'No',
        p.verificationStatus || '',
        p.profileViews      || 0,
        p.userId?.createdAt ? new Date(p.userId.createdAt).toISOString() : '',
      ])),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="professionals.csv"');
    return res.send(rows.join('\n'));
  } catch (err) {
    logger.error('exportProfessionals error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to export professionals.' });
  }
};
