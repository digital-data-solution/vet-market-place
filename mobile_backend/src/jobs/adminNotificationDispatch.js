/**
 * Sweeps for admin-scheduled push notifications (jobs/adminNotificationDispatch.js)
 * whose scheduledFor has arrived and dispatches them. Runs every minute — the
 * closest an admin's "send at time X" can land is within ~60s of that time.
 *
 * Immediate sends (no scheduledFor) never pass through here — the controller
 * dispatches those synchronously on create. This job only exists for the
 * "in time needed" scheduled case.
 */

import cron from 'node-cron';
import AdminNotification from '../models/AdminNotification.js';
import { dispatchAdminNotification } from '../services/adminNotification.service.js';
import logger from '../lib/logger.js';

async function runDue() {
  const due = await AdminNotification.find({
    status: 'scheduled',
    scheduledFor: { $lte: new Date() },
  }).select('_id').lean();

  for (const { _id } of due) {
    try {
      await dispatchAdminNotification(_id);
    } catch (err) {
      logger.error('Scheduled admin notification dispatch error', { id: _id, error: err.message });
    }
  }
}

export default function startAdminNotificationDispatchJob() {
  cron.schedule('* * * * *', async () => {
    try {
      await runDue();
    } catch (err) {
      logger.error('Admin notification dispatch sweep error', { error: err.message });
    }
  }, { timezone: 'UTC' });

  logger.info('⏰ Admin notification dispatch job scheduled (every minute)');
}
