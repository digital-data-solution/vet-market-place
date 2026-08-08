/**
 * Wallet automation jobs — run alongside subscriptionReminders.js
 *
 * Auto-release (hourly): a buyer who never taps "Release" would otherwise
 * leave a provider's earned money stuck in escrow forever. Any booking still
 * 'funded' past its autoReleaseAt deadline (set at payment time — see
 * WALLET_AUTO_RELEASE_DAYS, default 7 days) is released automatically.
 * Disputed bookings are excluded — those wait for an admin, not the clock.
 */

import cron from 'node-cron';
import Booking from '../models/Booking.js';
import { doRelease } from '../api/wallet.controller.js';
import logger from '../lib/logger.js';

async function runAutoRelease() {
  const due = await Booking.find({ status: 'funded', autoReleaseAt: { $lte: new Date() } });
  let released = 0;
  for (const booking of due) {
    try {
      await doRelease(booking, { auto: true });
      released++;
    } catch (err) {
      logger.error('Auto-release failed for booking', { bookingId: booking._id, error: err.message });
    }
  }
  if (released) logger.info(`Auto-released ${released} escrow booking(s) past their deadline.`);
}

export default function startWalletJobs() {
  // Every hour, on the hour.
  cron.schedule('0 * * * *', async () => {
    try { await runAutoRelease(); }
    catch (err) { logger.error('Wallet auto-release cron error', { error: err.message }); }
  });

  logger.info('⏰ Wallet auto-release job scheduled (hourly).');
}
