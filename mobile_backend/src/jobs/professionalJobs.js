/**
 * Professional automation jobs
 *
 * Jobs:
 *  1. Stale review alert       (every 12h)         — admin email if any professional pending > 48h
 *  2. Admin morning digest     (08:00 WAT / 07:00 UTC daily) — pending count, new sign-ups, active subs
 *  3. New review notification  (every 15 min)      — email professionals when they receive a new review
 *  4. Inactive professional    (10:00 WAT / 09:00 UTC, 1st of month) — ping pros idle 60+ days
 *  5. Unverify expired pros    (23:30 UTC daily)   — mirror licenseCron but for all new roles
 */

import cron       from 'node-cron';
import Professional from '../models/Professional.js';
import Subscription from '../models/Subscription.js';
import User         from '../models/User.js';
import Review       from '../models/Review.js';
import logger       from '../lib/logger.js';
import SupportThread from '../models/SupportThread.js';
import {
  sendAdminStaleReviewAlert,
  sendAdminMorningDigest,
  sendNewReviewNotification,
  sendUnansweredSupportAlert,
} from '../services/email.service.js';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'contact@xpressdigitalanddatasolutions.online';

// ─────────────────────────────────────────────────────────────────────────────
// JOB 1 — STALE REVIEW ALERT  (every 12h: 07:00 and 19:00 UTC)
// Notifies admin if any professional has been pending review for > 48h
// ─────────────────────────────────────────────────────────────────────────────

async function runStaleReviewAlert() {
  logger.info('--- Running Stale Review Alert ---');
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const stale = await Professional.find({
    verificationStatus: 'pending',
    createdAt: { $lte: cutoff },
  }).select('name email role businessName createdAt').lean();

  if (!stale.length) {
    logger.info('No stale pending reviews found.');
    return;
  }

  logger.warn(`Stale review alert: ${stale.length} professionals pending > 48h`);
  await sendAdminStaleReviewAlert(ADMIN_EMAIL, stale);
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB 2 — ADMIN MORNING DIGEST  (08:00 WAT = 07:00 UTC)
// Daily summary: pending reviews, 24h sign-ups, active subscriptions
// ─────────────────────────────────────────────────────────────────────────────

async function runAdminMorningDigest() {
  logger.info('--- Running Admin Morning Digest ---');
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [pendingList, newSignups24h, activeSubscriptions] = await Promise.all([
    Professional.find({ verificationStatus: 'pending' })
      .select('name role createdAt')
      .sort({ createdAt: 1 })
      .lean(),
    User.countDocuments({ createdAt: { $gte: since24h } }),
    Subscription.countDocuments({ status: 'active' }),
  ]);

  await sendAdminMorningDigest(ADMIN_EMAIL, {
    pendingCount: pendingList.length,
    newSignups24h,
    activeSubscriptions,
    pendingList,
  });

  logger.info(`Morning digest sent — pending: ${pendingList.length}, new users: ${newSignups24h}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB 3 — NEW REVIEW NOTIFICATION  (every 15 minutes)
// Sends professionals an email when they receive a review they haven't been
// notified about yet.  Uses a `notifiedAt` flag on the Review document —
// if the model doesn't have it yet, the job skips gracefully.
// ─────────────────────────────────────────────────────────────────────────────

async function runNewReviewNotifications() {
  // Only run if Review model has a `notifiedAt` field; otherwise skip silently
  const sampleKey = Review.schema?.paths?.notifiedAt;
  if (!sampleKey) return;

  const unnotified = await Review.find({ notifiedAt: { $exists: false } })
    .populate({
      path:   'targetId',
      model:  'Professional',
      select: 'name email userId role',
      populate: { path: 'userId', select: 'email name' },
    })
    .populate('reviewer', 'name')
    .limit(50)
    .lean();

  let notified = 0;
  for (const review of unnotified) {
    const prof     = review.targetId;
    const profEmail = prof?.email || prof?.userId?.email;
    const profName  = prof?.name  || prof?.userId?.name;
    if (!profEmail || !profName) continue;

    try {
      await sendNewReviewNotification(
        profName,
        profEmail,
        review.reviewer?.name || 'A pet owner',
        review.rating,
        review.comment,
        prof.role,
      );
      await Review.findByIdAndUpdate(review._id, { $set: { notifiedAt: new Date() } });
      notified++;
    } catch (err) {
      logger.error('Review notification failed', { reviewId: review._id, error: err.message });
    }
  }

  if (notified > 0) logger.info(`Review notifications sent: ${notified}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB 4 — INACTIVE PROFESSIONAL PING  (09:00 UTC, 1st of every month)
// Emails professionals who haven't updated their profile in 60+ days,
// reminding them to keep their listing fresh.
// ─────────────────────────────────────────────────────────────────────────────

async function runInactiveProfessionalPing() {
  logger.info('--- Running Inactive Professional Ping ---');
  const cutoff60Days = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

  const inactive = await Professional.find({
    isVerified: true,
    updatedAt:  { $lte: cutoff60Days },
  })
    .populate('userId', 'email name')
    .select('name email role businessName userId')
    .lean();

  let pinged = 0;
  for (const prof of inactive) {
    const email = prof.email || prof.userId?.email;
    const name  = prof.name  || prof.userId?.name;
    if (!email) continue;

    const firstName   = name?.split(' ')[0] || 'there';
    const roleLabel   = prof.role?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const displayName = prof.businessName || name;

    // Import sendEmail inline to avoid circular deps at module load time
    const { sendEmail } = await import('../services/email.service.js');
    const html = `
      <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">
        <h1 style="font-size:22px;font-weight:800;margin-bottom:12px">Hi ${firstName} 👋 — quick reminder!</h1>
        <p>We noticed your <strong>${roleLabel}</strong> profile (<em>${displayName}</em>) on Xpress Vet hasn't been updated in a while.</p>
        <p>Fresh, complete profiles rank higher in search results and earn more trust from pet owners. Here are quick wins:</p>
        <ul style="line-height:2">
          <li>✅ Add your latest gallery photos</li>
          <li>✅ Update your services or specialization</li>
          <li>✅ Confirm your phone number and address are current</li>
        </ul>
        <p>It only takes a minute — open the Xpress Vet app and tap <strong>Profile → Edit Business Info</strong>.</p>
        <p style="margin-top:24px;color:#64748B;font-size:13px">If you no longer wish to be listed, you can deactivate your profile from the app at any time.</p>
        <p>The Xpress Vet Team 🐾</p>
      </div>`;

    try {
      await sendEmail(email, `${firstName}, your Xpress Vet profile needs a refresh!`, html);
      pinged++;
    } catch (err) {
      logger.error('Inactive ping failed', { profId: prof._id, error: err.message });
    }
  }

  logger.info(`Inactive professional pings sent: ${pinged} / ${inactive.length}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB 5 — UNVERIFY PROFESSIONALS WITH EXPIRED SUBSCRIPTIONS (23:30 UTC)
// Extends licenseCron.js to cover all new role types, not just vet/kennel_owner
// ─────────────────────────────────────────────────────────────────────────────

async function runUnverifyExpiredPros() {
  const ALL_PRO_ROLES = [
    'vet', 'kennel_owner', 'groomer', 'trainer', 'pet_sitter',
    'pet_transport', 'cremation_service', 'agro_vet_supplier', 'insurance_provider',
    'pet_pharmacy', 'rescue_center', 'pet_hotel',
  ];

  const activeUserIds = await Subscription.distinct('user', { status: 'active' });

  const result = await Professional.updateMany(
    {
      isVerified: true,
      role:       { $in: ['groomer', 'trainer', 'pet_sitter'] }, // only auto-approved roles
      userId:     { $nin: activeUserIds },
    },
    { $set: { isVerified: false } },
  );

  if (result.modifiedCount > 0) {
    logger.info(`Unverified ${result.modifiedCount} service professionals with no active subscription.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// JOB 6 — UNANSWERED SUPPORT REMINDER  (every 15 minutes)
// Finds open support threads where the last message is from a user and it's
// been sitting >30 minutes with no admin reply.  Throttled per-thread by
// adminNotifiedAt so we don't send repeat emails every 15 min.
// ─────────────────────────────────────────────────────────────────────────────

async function runUnansweredSupportReminder() {
  const WAIT_MS    = 30 * 60 * 1000;  // 30 minutes before first reminder
  const RESEND_MS  = 60 * 60 * 1000;  // re-notify after 1 hour if still unanswered
  const cutoff     = new Date(Date.now() - WAIT_MS);
  const resendCut  = new Date(Date.now() - RESEND_MS);

  const threads = await SupportThread.find({
    status:        'open',
    lastMessageAt: { $lte: cutoff },
    $or: [
      { adminNotifiedAt: { $exists: false } },
      { adminNotifiedAt: { $lte: resendCut } },
    ],
  }).lean();

  // Only threads where the last message is from a user (not admin)
  const unanswered = threads.filter(t => {
    if (!t.messages?.length) return false;
    return t.messages[t.messages.length - 1].senderRole === 'user';
  });

  if (!unanswered.length) return;

  const payload = unanswered.map(t => ({
    userName:    t.userName   || 'Unknown',
    userEmail:   t.userEmail  || '',
    userRole:    t.userRole   || '',
    waitMinutes: Math.round((Date.now() - new Date(t.lastMessageAt).getTime()) / 60000),
  }));

  logger.warn(`Unanswered support reminder: ${unanswered.length} threads`);
  await sendUnansweredSupportAlert(ADMIN_EMAIL, payload);

  // Update adminNotifiedAt on each thread
  const ids = unanswered.map(t => t._id);
  await SupportThread.updateMany({ _id: { $in: ids } }, { $set: { adminNotifiedAt: new Date() } });
}

export default function startProfessionalJobs() {
  // Stale review alert — 07:00 and 19:00 UTC (08:00 and 20:00 WAT)
  cron.schedule('0 7,19 * * *', async () => {
    try { await runStaleReviewAlert(); }
    catch (err) { logger.error('Stale review alert cron error', { error: err.message }); }
  });

  // Admin morning digest — 07:00 UTC (08:00 WAT)
  cron.schedule('0 7 * * *', async () => {
    try { await runAdminMorningDigest(); }
    catch (err) { logger.error('Morning digest cron error', { error: err.message }); }
  });

  // New review notifications — every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try { await runNewReviewNotifications(); }
    catch (err) { logger.error('Review notification cron error', { error: err.message }); }
  });

  // Inactive professional ping — 09:00 UTC on the 1st of every month
  cron.schedule('0 9 1 * *', async () => {
    try { await runInactiveProfessionalPing(); }
    catch (err) { logger.error('Inactive ping cron error', { error: err.message }); }
  });

  // Unverify expired pros — 23:30 UTC (00:30 WAT), after licenseCron runs at 23:00
  cron.schedule('30 23 * * *', async () => {
    try { await runUnverifyExpiredPros(); }
    catch (err) { logger.error('Unverify expired pros cron error', { error: err.message }); }
  });

  // Unanswered support reminder — every 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    try { await runUnansweredSupportReminder(); }
    catch (err) { logger.error('Unanswered support reminder cron error', { error: err.message }); }
  });

  logger.info('⏰ Professional automation jobs scheduled (stale alerts, digest, review notifications, inactive ping, subscription sync, support reminders).');
}
