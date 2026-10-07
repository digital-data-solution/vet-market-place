/**
 * Posts the oldest ScheduledReel whose postAt has passed — ONE per sweep, so
 * a missed or delayed GitHub Actions run catches up at the next slot instead
 * of dumping several Reels at once.
 *
 * GitHub's cron fires hours late (Oct 2026: an 18:30 UTC slot ran at 22:44
 * and 00:15 UTC, i.e. ~1am WAT), so the workflow now fires many times through
 * the afternoon and THIS file decides: post only inside the Nigerian evening
 * window, at most one Reel per evening. postAt still gates the order/day.
 * Facebook is best-effort alongside, same as instagramUploadWorker.js.
 */
import ScheduledReel from '../models/ScheduledReel.js';
import { postReelToInstagram, isInstagramConfigured, checkTokenAge } from '../lib/instagramUpload.js';
import { postVideoToFacebookPage, isFacebookConfigured } from '../lib/facebookUpload.js';
import logger from '../lib/logger.js';

const WINDOW_START_WAT = 18; // 6pm
const WINDOW_END_WAT = 22;   // 10pm
const MIN_GAP_HOURS = 10;    // one Reel per evening
const EARLY_GRACE_HOURS = 1; // postAt is 7pm WAT; a 6pm run may post it

async function tryPostToFacebook(reel) {
  if (!isFacebookConfigured() || reel.facebookStatus === 'posted') return;
  try {
    const { url } = await postVideoToFacebookPage(reel.videoUrl, reel.captionFacebook);
    reel.facebookStatus = 'posted';
    reel.facebookUrl = url;
    reel.facebookError = null;
  } catch (err) {
    reel.facebookStatus = 'failed';
    reel.facebookError = (err.message || 'Unknown Facebook post error').slice(0, 500);
    logger.error('Scheduled Reel Facebook post failed', { key: reel.key, error: err.message });
  }
}

export async function runSweep() {
  if (!isInstagramConfigured()) {
    logger.info('Scheduled Reels: Instagram not configured — skipping sweep.');
    return;
  }
  const now = new Date();
  const watHour = (now.getUTCHours() + 1) % 24; // Nigeria = UTC+1, no DST
  if (watHour < WINDOW_START_WAT || watHour >= WINDOW_END_WAT) {
    logger.info(`Scheduled Reels: ${watHour}:00 WAT is outside the ${WINDOW_START_WAT}:00–${WINDOW_END_WAT}:00 window — skipping.`);
    return;
  }
  const recent = await ScheduledReel.findOne({
    instagramPostedAt: { $gte: new Date(now.getTime() - MIN_GAP_HOURS * 3600e3) },
  });
  if (recent) {
    logger.info(`Scheduled Reels: "${recent.key}" already posted this evening — skipping.`);
    return;
  }

  const tokenWarning = checkTokenAge();
  if (tokenWarning) logger.error(`Instagram token warning: ${tokenWarning}`);

  // A run just before 7pm WAT may take that evening's Reel.
  const due = new Date(now.getTime() + EARLY_GRACE_HOURS * 3600e3);
  const reel = await ScheduledReel.findOneAndUpdate(
    { instagramStatus: 'pending', postAt: { $lte: due } },
    { $set: { instagramStatus: 'processing' } },
    { sort: { postAt: 1 }, new: true },
  );
  if (!reel) {
    logger.info('Scheduled Reels: nothing due.');
    return;
  }

  try {
    const { mediaId, url } = await postReelToInstagram(reel.videoUrl, reel.captionInstagram);
    reel.instagramStatus = 'posted';
    reel.instagramMediaId = mediaId;
    reel.instagramUrl = url;
    reel.instagramError = null;
    reel.instagramPostedAt = new Date();
    logger.info('Scheduled Reel posted to Instagram', { key: reel.key, url });
  } catch (err) {
    reel.instagramStatus = 'failed';
    reel.instagramError = (err.message || 'Unknown Instagram post error').slice(0, 500);
    logger.error('Scheduled Reel Instagram post failed', { key: reel.key, error: err.message });
  }
  await tryPostToFacebook(reel);
  await reel.save();
}
