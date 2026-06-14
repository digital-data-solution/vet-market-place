import cron from 'node-cron';
import User from '../models/User.js';
import Professional from '../models/Professional.js';
import Subscription from '../models/Subscription.js';
import ActivityLog from '../models/ActivityLog.js';
import logger from '../lib/logger.js';
import { sendWeeklyDigestEmail } from '../services/email.service.js';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'contact@xpressdigitalanddatasolutions.online';

// ─── Data aggregation ─────────────────────────────────────────────────────────

async function gatherWeeklyData() {
  const now       = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 7);
  weekStart.setHours(0, 0, 0, 0);

  const twoWeeksAgo = new Date(now);
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  twoWeeksAgo.setHours(0, 0, 0, 0);

  const ago30 = new Date(now);
  ago30.setDate(ago30.getDate() - 30);

  const [
    newSignupsThisWeek,
    signupsByRole,
    proSubStats,
    newProSubsThisWeek,
    cancelledThisWeek,
    cancelledPriorWeek,
    activeUserSubs,
    totalUsers,
    dormantCount,
    pendingVerifications,
    searchBreakdown,
    contactTapBreakdown,
    subFunnelRows,
    topReferrers,
    referralSignupsThisWeek,
  ] = await Promise.all([

    User.countDocuments({ createdAt: { $gte: weekStart } }),

    User.aggregate([
      { $match: { createdAt: { $gte: weekStart } } },
      { $group: { _id: '$role', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    // Sum amounts of all currently-active professional subscriptions for MRR estimate
    Subscription.aggregate([
      { $match: { status: 'active', endDate: { $gte: now } } },
      { $group: { _id: null, mrr: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),

    Subscription.countDocuments({ startDate: { $gte: weekStart } }),

    Subscription.countDocuments({ status: 'cancelled', updatedAt: { $gte: weekStart } }),

    Subscription.countDocuments({ status: 'cancelled', updatedAt: { $gte: twoWeeksAgo, $lt: weekStart } }),

    // User (pet owner) paid plan count, priced at ₦1,500/mo
    User.countDocuments({ 'subscription.status': 'active' }),

    User.countDocuments({ role: { $ne: 'admin' } }),

    User.countDocuments({
      role: { $ne: 'admin' },
      lastLoginAt: { $lt: ago30 },
    }),

    Professional.countDocuments({ verificationStatus: 'pending' }),

    ActivityLog.aggregate([
      {
        $match: {
          action: { $in: ['search.list', 'search.nearby'] },
          timestamp: { $gte: weekStart },
          'metadata.role': { $ne: null },
        },
      },
      { $group: { _id: '$metadata.role', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]),

    ActivityLog.aggregate([
      { $match: { action: 'contact.tapped', timestamp: { $gte: weekStart } } },
      { $group: { _id: '$metadata.method', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),

    ActivityLog.aggregate([
      {
        $match: {
          action: { $in: ['subscription.initiated', 'subscription.activated'] },
          timestamp: { $gte: weekStart },
        },
      },
      { $group: { _id: '$action', count: { $sum: 1 } } },
    ]),

    User.find({ referralRewardsEarned: { $gt: 0 } })
      .select('name referralCode referralRewardsEarned')
      .sort({ referralRewardsEarned: -1 })
      .limit(3)
      .lean(),

    User.countDocuments({ referredBy: { $ne: null }, createdAt: { $gte: weekStart } }),
  ]);

  const proMrr      = proSubStats[0]?.mrr   || 0;
  const proSubCount = proSubStats[0]?.count  || 0;
  const USER_PLAN_PRICE = 1500;
  const mrr             = proMrr + activeUserSubs * USER_PLAN_PRICE;
  const totalActiveSubs = proSubCount + activeUserSubs;

  const funnelMap = {};
  for (const f of subFunnelRows) funnelMap[f._id] = f.count;
  const initiated     = funnelMap['subscription.initiated'] || 0;
  const activated     = funnelMap['subscription.activated'] || 0;
  const conversionRate = initiated >= 3 ? Math.round((activated / initiated) * 100) : null;

  const ds = (d) => d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
  const weekLabel = `${ds(weekStart)} – ${ds(now)} ${now.getFullYear()}`;

  return {
    weekLabel,
    weekStart,
    now,
    newSignupsThisWeek,
    signupsByRole,
    mrr,
    totalActiveSubs,
    proSubCount,
    activeUserSubs,
    newProSubsThisWeek,
    cancelledThisWeek,
    cancelledPriorWeek,
    totalUsers,
    dormantCount,
    pendingVerifications,
    searchBreakdown,
    contactTapBreakdown,
    initiated,
    activated,
    conversionRate,
    topReferrers,
    referralSignupsThisWeek,
  };
}

// ─── Insight engine ───────────────────────────────────────────────────────────

function generateInsights(data) {
  const observations    = [];
  const recommendations = [];

  // 1. Churn signal
  if (data.cancelledThisWeek === 0 && data.cancelledPriorWeek > 0) {
    observations.push(
      `Zero cancellations this week (vs ${data.cancelledPriorWeek} last week) — strong retention signal.`
    );
  } else if (data.cancelledThisWeek > 0 && data.cancelledPriorWeek > 0) {
    const churnPct = Math.round((data.cancelledThisWeek / data.cancelledPriorWeek - 1) * 100);
    if (churnPct >= 50) {
      observations.push(
        `Cancellations this week (${data.cancelledThisWeek}) are up ${churnPct}% vs last week (${data.cancelledPriorWeek}). ` +
        `Possible payment failure or onboarding friction.`
      );
      recommendations.push(
        `Investigate this week's cancellations — filter by 'cancelled' status in the dashboard. ` +
        `A payment-failure batch or a UX regression is the most likely cause.`
      );
    } else if (churnPct <= -30) {
      observations.push(
        `Cancellations fell to ${data.cancelledThisWeek} (from ${data.cancelledPriorWeek} last week) — retention improving.`
      );
    }
  } else if (data.cancelledThisWeek > 3 && data.cancelledPriorWeek === 0) {
    observations.push(
      `${data.cancelledThisWeek} cancellations this week. No prior-week baseline yet to confirm a trend.`
    );
    recommendations.push(`Review recent cancellations to catch any pattern early before it grows.`);
  }

  // 2. Freemium conversion rate
  if (data.conversionRate !== null) {
    if (data.conversionRate < 40) {
      observations.push(
        `Freemium-to-paid conversion: ${data.conversionRate}% (${data.activated} subscribed of ${data.initiated} who started checkout). ` +
        `Below 40% — the paywall pitch may need work.`
      );
      if (recommendations.length < 2) {
        recommendations.push(
          `A/B test the subscription modal copy — try leading with a specific benefit ` +
          `(e.g. "Call any vet in Lagos right now") rather than a generic feature list.`
        );
      }
    } else {
      observations.push(
        `Freemium conversion: ${data.conversionRate}% this week ` +
        `(${data.activated} of ${data.initiated} who started checkout actually subscribed). Healthy.`
      );
    }
  }

  // 3. Top searched role / supply gap
  if (data.searchBreakdown.length > 0) {
    const topSearch  = data.searchBreakdown[0];
    const totalSearches = data.searchBreakdown.reduce((s, r) => s + r.count, 0);
    const pct = totalSearches > 0 ? Math.round((topSearch.count / totalSearches) * 100) : 0;
    observations.push(
      `"${topSearch._id}" led search demand — ${topSearch.count} searches (${pct}% of all role-based searches this week).`
    );
    if (pct > 55 && topSearch._id === 'vet' && recommendations.length < 2) {
      recommendations.push(
        `Vets dominate search intent (${pct}% of searches). ` +
        `If vet listings are thin, consider a targeted onboarding push to recruit more vets.`
      );
    }
  }

  // 4. Pending verification queue
  if (data.pendingVerifications >= 3) {
    observations.push(
      `${data.pendingVerifications} professional${data.pendingVerifications !== 1 ? 's' : ''} ` +
      `are awaiting verification and currently invisible to all users.`
    );
    if (recommendations.length < 2) {
      recommendations.push(
        `Clear the verification queue: ${data.pendingVerifications} professionals ` +
        `cannot appear in search results until you approve them.`
      );
    }
  }

  // 5. Referral activity
  if (data.referralSignupsThisWeek > 0) {
    observations.push(
      `${data.referralSignupsThisWeek} user${data.referralSignupsThisWeek !== 1 ? 's' : ''} ` +
      `joined via referral link this week — the referral programme is generating organic growth.`
    );
  }

  // 6. Dormant user flag (only surface once platform has meaningful size)
  if (data.totalUsers > 50 && recommendations.length < 2) {
    const dormantPct = Math.round((data.dormantCount / data.totalUsers) * 100);
    if (dormantPct > 25 && data.dormantCount > 20) {
      recommendations.push(
        `${data.dormantCount} users (${dormantPct}% of the platform) haven't logged in for 30+ days. ` +
        `A "what's new on Xpress Vet?" re-engagement email could bring a portion back.`
      );
    }
  }

  return {
    observations:    observations.slice(0, 3),
    recommendations: recommendations.slice(0, 2),
  };
}

// ─── Narrative paragraph ──────────────────────────────────────────────────────

function buildNarrative(data) {
  const roleMap = {};
  for (const r of data.signupsByRole) roleMap[r._id] = r.count;

  const ROLE_LABELS = {
    pet_owner:    'pet owner',
    vet:          'vet',
    kennel_owner: 'kennel owner',
    shop_owner:   'shop owner',
  };

  const parts = Object.entries(ROLE_LABELS)
    .filter(([r]) => roleMap[r])
    .map(([r, label]) => `${roleMap[r]} ${label}${roleMap[r] !== 1 ? 's' : ''}`);

  const breakdownStr = parts.length ? ` (${parts.join(', ')})` : '';

  const cancStr = data.cancelledThisWeek > 0
    ? `${data.newProSubsThisWeek} new professional listing${data.newProSubsThisWeek !== 1 ? 's' : ''} started and ${data.cancelledThisWeek} subscription${data.cancelledThisWeek !== 1 ? 's' : ''} cancelled.`
    : `${data.newProSubsThisWeek} new professional listing${data.newProSubsThisWeek !== 1 ? 's' : ''} came online — no cancellations.`;

  return (
    `Xpress Vet added ${data.newSignupsThisWeek} new user${data.newSignupsThisWeek !== 1 ? 's' : ''}${breakdownStr} this week, ` +
    `bringing the platform to ${data.totalUsers.toLocaleString()} total. ` +
    `${cancStr} ` +
    `Estimated MRR stands at ₦${data.mrr.toLocaleString()} across ${data.totalActiveSubs} active subscription${data.totalActiveSubs !== 1 ? 's' : ''}.`
  );
}

// ─── Cron job ────────────────────────────────────────────────────────────────

async function runWeeklyDigest() {
  logger.info('Weekly digest job started');
  try {
    const data = await gatherWeeklyData();
    const { observations, recommendations } = generateInsights(data);
    const narrative = buildNarrative(data);

    await sendWeeklyDigestEmail(ADMIN_EMAIL, {
      weekLabel:            data.weekLabel,
      narrative,
      observations,
      recommendations,
      newSignups:           data.newSignupsThisWeek,
      totalUsers:           data.totalUsers,
      mrr:                  data.mrr,
      totalActiveSubs:      data.totalActiveSubs,
      newSubsThisWeek:      data.newProSubsThisWeek,
      cancelledThisWeek:    data.cancelledThisWeek,
      searchBreakdown:      data.searchBreakdown,
      contactBreakdown:     data.contactTapBreakdown,
      topReferrers:         data.topReferrers,
      pendingVerifications: data.pendingVerifications,
      conversionRate:       data.conversionRate,
      dormantCount:         data.dormantCount,
    });

    logger.info('Weekly digest sent', {
      to:         ADMIN_EMAIL,
      newSignups: data.newSignupsThisWeek,
      mrr:        data.mrr,
    });
  } catch (err) {
    logger.error('Weekly digest job failed', { error: err.message, stack: err.stack });
  }
}

export default function startWeeklyDigestJob() {
  // 0 6 * * 1 = 06:00 UTC every Monday = 07:00 WAT
  cron.schedule('0 6 * * 1', runWeeklyDigest, { timezone: 'UTC' });
  logger.info('Weekly digest scheduled (Mon 06:00 UTC / 07:00 WAT)');
}
