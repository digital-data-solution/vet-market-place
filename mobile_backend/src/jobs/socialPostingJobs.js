/**
 * Runs the two Instagram/Facebook Reel workers from the always-on server so
 * the evening posts go out on time. GitHub Actions' cron was meant to do
 * this, but it drops most scheduled runs: of 16 tries on Mon 12 Oct 2026
 * only one fired, at 10:32pm WAT, so that evening's Reel was missed and
 * every Reel after it slid back a day. The GitHub workflows stay as a
 * backup; lib/instagramEveningSlot.js stops the two from both posting.
 *
 * Posting is just Graph API calls on videos already on Cloudinary — no
 * rendering — so it is cheap enough to run here (unlike blogVideoWorker.js).
 *
 * Days match the workflows: vet-tip / Business Suite Reels Mon/Tue/Wed/Fri,
 * blog-article Reels Thu/Sat/Sun. Every 10 min from 18:00 to 21:50 WAT; the
 * workers themselves enforce the 6-10pm window and one post per evening.
 */
import cron from 'node-cron';
import { runSweep as runScheduledReelsSweep } from './scheduledReelWorker.js';
import { runSweep as runInstagramUploadSweep } from './instagramUploadWorker.js';
import { isInstagramConfigured } from '../lib/instagramUpload.js';
import { isFacebookConfigured } from '../lib/facebookUpload.js';
import logger from '../lib/logger.js';

let running = false;

function schedule(expression, name, sweep) {
  cron.schedule(expression, async () => {
    if (running) return; // a slow Instagram upload is still going — the next tick will do
    running = true;
    try {
      await sweep();
    } catch (err) {
      logger.error(`${name} sweep error`, { error: err.message });
    } finally {
      running = false;
    }
  }, { timezone: 'Africa/Lagos' });
}

export function isSocialPostingEnabled() {
  return isInstagramConfigured() && isFacebookConfigured();
}

export default function startSocialPostingJobs() {
  // Without the Facebook Page ID a Reel would go to Instagram only and never
  // reach the Page, so leave it all to GitHub Actions instead.
  if (!isSocialPostingEnabled()) {
    logger.warn('Social posting jobs NOT started — INSTAGRAM_ACCOUNT_ID, INSTAGRAM_ACCESS_TOKEN and FACEBOOK_PAGE_ID must all be set. GitHub Actions still posts (late).');
    return;
  }
  schedule('*/10 18-21 * * 1,2,3,5', 'Scheduled Reels', runScheduledReelsSweep);
  schedule('*/10 18-21 * * 0,4,6', 'Instagram upload', runInstagramUploadSweep);
  logger.info('⏰ Social posting jobs scheduled (every 10 min, 6-10pm WAT: Reels Mon/Tue/Wed/Fri, blog Reels Thu/Sat/Sun)');
}
