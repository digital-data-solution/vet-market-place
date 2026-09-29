/**
 * Posts the oldest ScheduledReel whose postAt has passed — ONE per sweep, so
 * a missed or delayed GitHub Actions run catches up at the next slot instead
 * of dumping several Reels at once. Timing lives in the cron of
 * .github/workflows/scheduled-reels-worker.yml; postAt only gates the order.
 * Facebook is best-effort alongside, same as instagramUploadWorker.js.
 */
import ScheduledReel from '../models/ScheduledReel.js';
import { postReelToInstagram, isInstagramConfigured, checkTokenAge } from '../lib/instagramUpload.js';
import { postVideoToFacebookPage, isFacebookConfigured } from '../lib/facebookUpload.js';
import logger from '../lib/logger.js';

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
  const tokenWarning = checkTokenAge();
  if (tokenWarning) logger.error(`Instagram token warning: ${tokenWarning}`);

  const reel = await ScheduledReel.findOneAndUpdate(
    { instagramStatus: 'pending', postAt: { $lte: new Date() } },
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
