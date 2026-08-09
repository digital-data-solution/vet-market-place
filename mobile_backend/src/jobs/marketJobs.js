/**
 * Marketplace cleanup job — keeps the DB and Cloudinary lean (cost control).
 *
 * Runs daily and does three things, cheapest-first:
 *   1. EXPIRE  — active listings past their expiresAt become 'expired' and the
 *                seller is nudged (push) to renew or boost — drives re-engagement.
 *   2. PURGE-SOLD — sold listings older than MARKET_SOLD_RETENTION_DAYS get their
 *                Cloudinary images deleted and the row hard-deleted.
 *   3. PURGE-STALE — expired/removed listings older than MARKET_STALE_RETENTION_DAYS
 *                get images deleted and the row hard-deleted.
 *
 * A listing with an unresolved escrow booking (funded/disputed) is kept until
 * that settles, so purchase history is never orphaned mid-transaction.
 */

import cron    from 'node-cron';
import Listing from '../models/Listing.js';
import Booking from '../models/Booking.js';
import { purgeListingImages } from '../api/market.controller.js';
import { sendPushToUser } from '../services/pushNotification.service.js';
import logger  from '../lib/logger.js';

const SOLD_RETENTION_DAYS  = parseInt(process.env.MARKET_SOLD_RETENTION_DAYS  || '7', 10);
const STALE_RETENTION_DAYS = parseInt(process.env.MARKET_STALE_RETENTION_DAYS || '14', 10);

async function hasOpenEscrow(listingId) {
  const b = await Booking.findOne({
    listing: listingId,
    status:  { $in: ['funded', 'disputed', 'pending_payment'] },
  }).select('_id').lean();
  return !!b;
}

async function purgeAndDelete(listing) {
  if (await hasOpenEscrow(listing._id)) return false; // wait for escrow to settle
  await purgeListingImages(listing);
  await Listing.deleteOne({ _id: listing._id });
  return true;
}

export async function runMarketCleanup() {
  const now = new Date();

  // 1. Expire active listings past their deadline (+ nudge the seller).
  const toExpire = await Listing.find({
    status: 'active',
    expiresAt: { $lte: now },
  });
  for (const l of toExpire) {
    l.status = 'expired';
    await l.save();
    sendPushToUser(
      l.seller,
      '⏳ Your listing expired',
      `"${l.title}" is no longer showing in the marketplace. Renew it free, or boost it to sell faster.`,
      { type: 'market', listingId: String(l._id) },
    ).catch(() => {});
  }

  // 2. Purge sold listings past the retention window.
  const soldCutoff = new Date(now.getTime() - SOLD_RETENTION_DAYS * 86400000);
  const soldOld = await Listing.find({ status: 'sold', updatedAt: { $lte: soldCutoff } });
  let purgedSold = 0;
  for (const l of soldOld) if (await purgeAndDelete(l)) purgedSold++;

  // 3. Purge expired/removed listings past the (longer) stale window.
  const staleCutoff = new Date(now.getTime() - STALE_RETENTION_DAYS * 86400000);
  const staleOld = await Listing.find({ status: { $in: ['expired', 'removed'] }, updatedAt: { $lte: staleCutoff } });
  let purgedStale = 0;
  for (const l of staleOld) if (await purgeAndDelete(l)) purgedStale++;

  if (toExpire.length || purgedSold || purgedStale) {
    logger.info('Market cleanup done', {
      expired: toExpire.length, purgedSold, purgedStale,
    });
  }
}

export default function startMarketJobs() {
  // Daily at 02:30 UTC (03:30 WAT) — off-peak.
  cron.schedule('30 2 * * *', async () => {
    try { await runMarketCleanup(); }
    catch (err) { logger.error('Market cleanup cron error', { error: err.message }); }
  });
  logger.info('⏰ Marketplace cleanup job scheduled (daily 02:30 UTC).');
}
