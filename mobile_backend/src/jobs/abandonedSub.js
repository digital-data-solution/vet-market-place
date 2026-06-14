import cron from 'node-cron';
import Subscription from '../models/Subscription.js';
import logger from '../lib/logger.js';
import { sendAbandonedSubEmail } from '../services/email.service.js';

// Window: remind once, between 30 and 90 minutes after checkout was initiated.
// This gives Paystack time to confirm a real payment while still catching genuine dropouts.
const WINDOW_MIN_MS = 30 * 60 * 1000;
const WINDOW_MAX_MS = 90 * 60 * 1000;

async function runAbandonedSub() {
  logger.info('Abandoned-sub job started');
  try {
    const now          = new Date();
    const minCutoff    = new Date(now - WINDOW_MAX_MS); // earliest initiation time
    const maxCutoff    = new Date(now - WINDOW_MIN_MS); // latest initiation time

    const subs = await Subscription.find({
      status:                  'pending',
      paymentInitiatedAt:      { $gte: minCutoff, $lt: maxCutoff },
      abandonedReminderSentAt: null,
    })
      .populate('user', 'name email')
      .lean();

    if (!subs.length) {
      logger.info('Abandoned-sub job: nothing to send');
      return;
    }

    logger.info(`Abandoned-sub job: found ${subs.length} pending checkout(s)`);

    for (const sub of subs) {
      if (!sub.user?.email) continue;
      sendAbandonedSubEmail(sub.user.name, sub.user.email, sub.plan, sub.amount).catch(() => {});
      await Subscription.findByIdAndUpdate(sub._id, { $set: { abandonedReminderSentAt: now } });
    }

    logger.info('Abandoned-sub job complete', { sent: subs.length });
  } catch (err) {
    logger.error('Abandoned-sub job failed', { error: err.message, stack: err.stack });
  }
}

export default function startAbandonedSubJob() {
  // Run every hour on the hour
  cron.schedule('0 * * * *', runAbandonedSub, { timezone: 'UTC' });
  logger.info('Abandoned-sub job scheduled (hourly)');
}
