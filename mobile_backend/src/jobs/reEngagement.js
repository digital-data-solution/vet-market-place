import cron from 'node-cron';
import User from '../models/User.js';
import logger from '../lib/logger.js';
import { sendReEngagementEmail } from '../services/email.service.js';

const BATCH_SIZE = 50; // process this many users per run to keep memory low

async function runReEngagement() {
  logger.info('Re-engagement job started');
  try {
    const now         = new Date();
    const sevenDays   = new Date(now - 7 * 24 * 3600 * 1000);
    const eightDays   = new Date(now - 8 * 24 * 3600 * 1000);

    // Target: logged in 7-8 days ago AND either never received a re-engagement
    // email OR the last one was sent before their most recent login
    // (so re-dormancy triggers a new email, not just the first one).
    const users = await User.find({
      role:        { $ne: 'admin' },
      lastLoginAt: { $gte: eightDays, $lt: sevenDays },
      $or: [
        { reEngagementSentAt: null },
        { $expr: { $lt: ['$reEngagementSentAt', '$lastLoginAt'] } },
      ],
    })
      .select('name email reEngagementSentAt lastLoginAt')
      .limit(BATCH_SIZE)
      .lean();

    if (!users.length) {
      logger.info('Re-engagement job: no eligible users');
      return;
    }

    logger.info(`Re-engagement job: sending to ${users.length} users`);

    for (const user of users) {
      sendReEngagementEmail(user.name, user.email).catch(() => {});
      await User.findByIdAndUpdate(user._id, { $set: { reEngagementSentAt: now } });
    }

    logger.info('Re-engagement job complete', { sent: users.length });
  } catch (err) {
    logger.error('Re-engagement job failed', { error: err.message, stack: err.stack });
  }
}

export default function startReEngagementJob() {
  // 0 1 * * * = 01:00 UTC every night = 02:00 WAT
  cron.schedule('0 1 * * *', runReEngagement, { timezone: 'UTC' });
  logger.info('Re-engagement job scheduled (daily 01:00 UTC / 02:00 WAT)');
}
