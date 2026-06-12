/**
 * Subscription automation jobs — run alongside licenseCron.js
 *
 * Jobs:
 *  1. Expiry reminders  (09:00 WAT / 08:00 UTC) — emails at 7, 3, and 1 day before expiry
 *  2. Expired notices   (00:05 WAT / 23:05 UTC) — email same day subscription expires
 *  3. Pending cleanup   (01:00 WAT / 00:00 UTC) — cancel pending payments older than 48h
 */

import cron from 'node-cron';
import User         from '../models/User.js';
import Subscription from '../models/Subscription.js';
import {
  sendSubscriptionExpiryReminder,
  sendSubscriptionExpired,
} from '../services/email.service.js';
import logger from '../lib/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a Date window: [start of targetDay, end of targetDay] in UTC */
function dayWindow(offsetDays) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  const end = new Date(d);
  end.setUTCHours(23, 59, 59, 999);
  return [d, end];
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB 1: EXPIRY REMINDERS (09:00 WAT = 08:00 UTC)
// ─────────────────────────────────────────────────────────────────────────────

async function runExpiryReminders() {
  logger.info('--- Running Subscription Expiry Reminders ---');
  let reminded = 0;

  for (const daysLeft of [7, 3, 1]) {
    const [windowStart, windowEnd] = dayWindow(daysLeft);

    // ── Professional subscriptions (listing plans only — not messaging) ─────
    const expiringPro = await Subscription.find({
      plan:    { $ne: 'messaging' },
      status:  'active',
      endDate: { $gte: windowStart, $lte: windowEnd },
    }).populate('user', 'name email').lean();

    for (const sub of expiringPro) {
      if (!sub.user?.email) continue;
      try {
        await sendSubscriptionExpiryReminder(
          sub.user.name,
          sub.user.email,
          sub.plan,
          daysLeft,
          sub.endDate,
          true,
        );
        reminded++;
      } catch (err) {
        logger.error('Reminder email failed (professional)', { userId: sub.user._id, error: err.message });
      }
    }

    // ── Messaging subscriptions ─────────────────────────────────────────────
    const expiringMessaging = await Subscription.find({
      plan:    'messaging',
      status:  'active',
      endDate: { $gte: windowStart, $lte: windowEnd },
    }).populate('user', 'name email').lean();

    for (const sub of expiringMessaging) {
      if (!sub.user?.email) continue;
      try {
        await sendSubscriptionExpiryReminder(
          sub.user.name,
          sub.user.email,
          'messaging',
          daysLeft,
          sub.endDate,
          false, // use pet-owner style email — messaging is user-facing
        );
        reminded++;
      } catch (err) {
        logger.error('Reminder email failed (messaging)', { userId: sub.user._id, error: err.message });
      }
    }

    // ── Pet owner subscriptions ─────────────────────────────────────────────
    const expiringUsers = await User.find({
      'subscription.status':  'active',
      'subscription.endDate': { $gte: windowStart, $lte: windowEnd },
    }).select('name email subscription').lean();

    for (const user of expiringUsers) {
      if (!user.email) continue;
      try {
        await sendSubscriptionExpiryReminder(
          user.name,
          user.email,
          user.subscription.plan,
          daysLeft,
          user.subscription.endDate,
          false,
        );
        reminded++;
      } catch (err) {
        logger.error('Reminder email failed (pet owner)', { userId: user._id, error: err.message });
      }
    }
  }

  logger.info(`Expiry reminders sent: ${reminded}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB 2: EXPIRED TODAY NOTICES (00:05 WAT = 23:05 UTC previous day)
// ─────────────────────────────────────────────────────────────────────────────

async function runExpiredNotices() {
  logger.info('--- Running Subscription Expired Notices ---');
  let notified = 0;

  const [windowStart, windowEnd] = dayWindow(0);

  // ── Professional listing plans that just flipped to expired ────────────────
  const justExpiredPro = await Subscription.find({
    plan:    { $ne: 'messaging' },
    status:  'expired',
    endDate: { $gte: windowStart, $lte: windowEnd },
  }).populate('user', 'name email').lean();

  for (const sub of justExpiredPro) {
    if (!sub.user?.email) continue;
    try {
      await sendSubscriptionExpired(sub.user.name, sub.user.email, sub.plan, true);
      notified++;
    } catch (err) {
      logger.error('Expired notice failed (professional)', { error: err.message });
    }
  }

  // ── Messaging subscriptions that just expired ──────────────────────────────
  const justExpiredMessaging = await Subscription.find({
    plan:    'messaging',
    status:  'expired',
    endDate: { $gte: windowStart, $lte: windowEnd },
  }).populate('user', 'name email').lean();

  for (const sub of justExpiredMessaging) {
    if (!sub.user?.email) continue;
    try {
      await sendSubscriptionExpired(sub.user.name, sub.user.email, 'messaging', false);
      notified++;
    } catch (err) {
      logger.error('Expired notice failed (messaging)', { error: err.message });
    }
  }

  // ── Pet owner subscriptions that just expired ──────────────────────────────
  const justExpiredUsers = await User.find({
    'subscription.status':  'expired',
    'subscription.endDate': { $gte: windowStart, $lte: windowEnd },
  }).select('name email subscription').lean();

  for (const user of justExpiredUsers) {
    if (!user.email) continue;
    try {
      await sendSubscriptionExpired(user.name, user.email, user.subscription.plan, false);
      notified++;
    } catch (err) {
      logger.error('Expired notice failed (pet owner)', { error: err.message });
    }
  }

  logger.info(`Expired notices sent: ${notified}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// JOB 3: PENDING PAYMENT CLEANUP (01:00 WAT = 00:00 UTC)
// ─────────────────────────────────────────────────────────────────────────────

async function runPendingCleanup() {
  logger.info('--- Running Pending Payment Cleanup ---');
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago

  // Professional + messaging subscriptions stuck in 'pending' > 48h → expire them
  const proResult = await Subscription.updateMany(
    {
      status:    'pending',
      createdAt: { $lte: cutoff },
    },
    { $set: { status: 'expired' } },
  );

  // Pet owner subscriptions stuck in 'pending' > 48h → reset to inactive
  const userResult = await User.updateMany(
    {
      'subscription.status': 'pending',
      $or: [
        { 'subscription.paymentInitiatedAt': { $lte: cutoff } },
        {
          'subscription.paymentInitiatedAt': { $exists: false },
          updatedAt: { $lte: cutoff },
        },
      ],
    },
    {
      $set: {
        'subscription.status': 'inactive',
        'subscription.plan':   null,
      },
    },
  );

  logger.info(
    `Pending cleanup: ${proResult.modifiedCount} professional/messaging, ${userResult.modifiedCount} pet owner records cleaned.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export default function startSubscriptionJobs() {
  // Expiry reminders — 09:00 WAT (08:00 UTC)
  cron.schedule('0 8 * * *', async () => {
    try { await runExpiryReminders(); }
    catch (err) { logger.error('Expiry reminder cron error', { error: err.message }); }
  });

  // Expired notices — 00:05 WAT (23:05 UTC previous day)
  cron.schedule('5 23 * * *', async () => {
    try { await runExpiredNotices(); }
    catch (err) { logger.error('Expired notice cron error', { error: err.message }); }
  });

  // Pending cleanup — 01:00 WAT (00:00 UTC)
  cron.schedule('0 0 * * *', async () => {
    try { await runPendingCleanup(); }
    catch (err) { logger.error('Pending cleanup cron error', { error: err.message }); }
  });

  logger.info('⏰ Subscription automation jobs scheduled (reminders @ 08:00 UTC, cleanup @ 00:00 UTC).');
}