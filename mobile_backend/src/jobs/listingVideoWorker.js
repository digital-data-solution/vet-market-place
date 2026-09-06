/**
 * Drains listings with generatedVideoStatus:'pending' — renders a video via
 * services/listingVideo.service.js, uploads it to Cloudinary, and writes
 * the result back onto the Listing. Mirrors jobs/emailQueueWorker.js's
 * atomic-claim pattern (findOneAndUpdate, safe against a second worker
 * instance claiming the same row) rather than inventing a new queue
 * mechanism — this codebase already has one, node-cron, not Agenda.js.
 *
 * DELIBERATELY NOT STARTED FROM server.js. Two real reasons:
 *   1. COST — rendering is CPU-heavy (~1-2 min per video on a dev machine).
 *      server.js runs on Render's web service, sized for API request
 *      traffic, not sustained CPU-bound rendering. Running this inline
 *      would compete with real user requests for CPU on every sweep.
 *   2. COST — every successful render uploads a video to Cloudinary, which
 *      bills storage/bandwidth far more than images (see the comment on
 *      Listing.generatedVideoUrl). This should run only once Sam has
 *      decided on tier-gating (see the prompt's own "which tier, and why"
 *      question) — not the moment this file exists.
 *
 * To actually run this: either (a) call `npm run worker:listing-video`
 * (see package.json) as its own long-lived process — on a separate Render
 * Background Worker service (extra cost, ask Render for current pricing)
 * or any other always-on machine, or (b) import and call
 * startListingVideoWorker() from server.js once Sam has decided that's
 * an acceptable cost/CPU tradeoff on the existing web service. Either way,
 * nothing renders until something else explicitly sets a Listing's
 * generatedVideoStatus to 'pending' (still 'none' by default).
 */
import cron from 'node-cron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Listing from '../models/Listing.js';
import { renderListingVideo } from '../services/listingVideo.service.js';
import { uploadVideoToCloudinary } from '../lib/cloudinaryUpload.js';
import { sendPushToUser } from '../services/pushNotification.service.js';
import { postListingVideoToTelegram, postListingVideoToTikTokDrafts, postListingVideoToInstagramDrafts } from '../services/telegram.service.js';
import logger from '../lib/logger.js';

// Small on purpose — each job is CPU-heavy and can take 1-2+ minutes, so a
// large batch could make one sweep run far longer than the interval
// between sweeps. Scheduled every 5 minutes (not every minute like the
// email queue) for the same reason.
const BATCH_SIZE = 3;
const WORK_DIR = path.join(os.tmpdir(), 'xpress-vet-listing-video');

async function claimNext() {
  return Listing.findOneAndUpdate(
    { generatedVideoStatus: 'pending' },
    { $set: { generatedVideoStatus: 'processing' } },
    { sort: { updatedAt: 1 }, new: true },
  );
}

async function processOne(listing) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const tempPath = path.join(WORK_DIR, `${listing._id}.mp4`);

  try {
    const result = await renderListingVideo(listing, tempPath);

    if (!result.ok) {
      listing.generatedVideoStatus = 'failed';
      listing.generatedVideoError = result.errors.join(' | ').slice(0, 500);
      await listing.save();
      logger.error('Listing video failed verification, not uploading', {
        listingId: listing._id.toString(), errors: result.errors,
      });
      return;
    }

    const uploaded = await uploadVideoToCloudinary(tempPath, {
      publicId: `listing-${listing._id}`,
    });

    listing.generatedVideoStatus = 'ready';
    listing.generatedVideoUrl = uploaded.url;
    listing.generatedVideoPublicId = uploaded.publicId;
    listing.generatedVideoError = null;
    listing.generatedVideoAt = new Date();
    if (listing.youtubeStatus === 'none') listing.youtubeStatus = 'pending'; // drained separately by youtubeUploadWorker.js
    await listing.save();

    logger.info('Listing video generated and uploaded', {
      listingId: listing._id.toString(), url: uploaded.url, duration: result.actualDuration,
    });

    sendPushToUser(
      listing.seller,
      '🎬 Your listing video is ready!',
      `"${listing.title}" now has a video ad — check it out and share it.`,
      { type: 'listing_video_ready', listingId: listing._id.toString() },
    ).catch(() => {});

    postListingVideoToTelegram(listing).catch(() => {}); // no-op until TELEGRAM_BOT_TOKEN/TELEGRAM_CHANNEL_ID are set, same as postListingToTelegram
    postListingVideoToTikTokDrafts(listing).catch(() => {}); // drops into the private drafts channel for Sam to post by hand — see telegram.service.js
    postListingVideoToInstagramDrafts(listing).catch(() => {}); // same channel, Reels-flavored caption
  } catch (err) {
    listing.generatedVideoStatus = 'failed';
    listing.generatedVideoError = (err.message || 'Unknown render error').slice(0, 500);
    await listing.save().catch(() => {});
    logger.error('Listing video render/upload threw', { listingId: listing._id.toString(), error: err.message });
  } finally {
    fs.rm(tempPath, () => {});
  }
}

async function runSweep() {
  for (let i = 0; i < BATCH_SIZE; i++) {
    const listing = await claimNext();
    if (!listing) break; // nothing pending — done for this run
    await processOne(listing);
  }
  await retryUndraftedReady();
}

// Self-heals a real gap found 2026-09-06 (via blogVideoWorker.js's identical
// fix — same root cause here): the drafts calls below no-op silently if
// TELEGRAM_* isn't set wherever runSweep() runs, or if the Telegram API
// call itself fails, and processOne() never retries a failed draft once the
// listing is already 'ready'. Every sweep re-checks for 'ready' listings
// still missing a draft and retries — cheap (no re-render, no re-upload).
async function retryUndraftedReady() {
  const stragglers = await Listing.find({
    generatedVideoStatus: 'ready',
    $or: [{ tiktokDraftedAt: null }, { instagramDraftedAt: null }],
  }).limit(20);
  for (const listing of stragglers) {
    await postListingVideoToTikTokDrafts(listing).catch(() => {});
    await postListingVideoToInstagramDrafts(listing).catch(() => {});
  }
}

export default function startListingVideoWorker() {
  if (process.env.ENABLE_LISTING_VIDEO_WORKER !== 'true') {
    logger.info('Listing video worker not started (ENABLE_LISTING_VIDEO_WORKER is not "true") — this is the safe default, see the comment at the top of jobs/listingVideoWorker.js before enabling it.');
    return;
  }

  cron.schedule('*/5 * * * *', async () => {
    try {
      await runSweep();
    } catch (err) {
      logger.error('Listing video sweep error', { error: err.message });
    }
  }, { timezone: 'UTC' });

  logger.info('🎬 Listing video worker scheduled (every 5 minutes)');
}

// Also runnable as its own standalone process — see the module docstring
// and package.json's "worker:listing-video" script.
export { runSweep };
