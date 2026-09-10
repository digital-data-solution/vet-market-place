/**
 * Drains BlogPosts with videoStatus:'pending' — renders a short vertical
 * "tips" video via services/blogVideo.service.js, uploads it to Cloudinary,
 * and writes the result back onto the post. Mirrors listingVideoWorker.js's
 * atomic-claim pattern exactly (findOneAndUpdate, safe against a second
 * worker instance claiming the same row).
 *
 * DELIBERATELY NOT STARTED FROM server.js — same two reasons as
 * listingVideoWorker.js (CPU cost, Cloudinary bandwidth cost), even though
 * a text-only render here is faster than a photo-video render. Run via
 * `npm run worker:blog-video` as a standalone process, or (the actual
 * deployed path) scripts/run-blog-video-sweep-once.mjs on a GitHub Actions
 * schedule — see .github/workflows/blog-video-worker.yml.
 */
import cron from 'node-cron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import BlogPost from '../models/BlogPost.js';
import { renderBlogTeaser } from '../services/blogVideo.service.js';
import { uploadVideoToCloudinary } from '../lib/cloudinaryUpload.js';
import { postBlogVideoToTikTokDrafts } from '../services/telegram.service.js';
import logger from '../lib/logger.js';

// Larger than listingVideoWorker's BATCH_SIZE=3 — text-only slides render
// much faster than the photo/zoompan pipeline (no source images to
// download/scale), so a bigger batch still comfortably fits one CI run.
const BATCH_SIZE = 8;
const WORK_DIR = path.join(os.tmpdir(), 'xpress-vet-blog-video');

async function claimNext() {
  return BlogPost.findOneAndUpdate(
    { videoStatus: 'pending' },
    { $set: { videoStatus: 'processing' } },
    { sort: { publishedAt: 1 }, new: true }, // oldest backlog first
  );
}

async function processOne(post) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const tempPath = path.join(WORK_DIR, `${post._id}.mp4`);

  try {
    const result = await renderBlogTeaser(post, tempPath);

    if (!result.ok) {
      post.videoStatus = 'failed';
      post.videoError = result.errors.join(' | ').slice(0, 500);
      await post.save();
      logger.error('Blog video failed verification, not uploading', {
        postId: post._id.toString(), errors: result.errors,
      });
      return;
    }

    const uploaded = await uploadVideoToCloudinary(tempPath, {
      folder: 'blog-videos',
      publicId: `blog-${post._id}`,
    });

    post.videoStatus = 'ready';
    post.videoUrl = uploaded.url;
    post.videoPublicId = uploaded.publicId;
    post.videoError = null;
    post.videoAt = new Date();
    if (post.youtubeStatus === 'none') post.youtubeStatus = 'pending'; // drained separately by youtubeUploadWorker.js
    if (post.instagramStatus === 'none') post.instagramStatus = 'pending'; // drained separately by instagramUploadWorker.js — real Reels auto-posting, replaces the manual Instagram draft below
    await post.save();

    logger.info('Blog video generated and uploaded', {
      postId: post._id.toString(), url: uploaded.url, duration: result.actualDuration,
    });

    postBlogVideoToTikTokDrafts(post).catch(() => {}); // TikTok still has no viable full-auto path (see telegram.service.js) — drafts stay
  } catch (err) {
    post.videoStatus = 'failed';
    post.videoError = (err.message || 'Unknown render error').slice(0, 500);
    await post.save().catch(() => {});
    logger.error('Blog video render/upload threw', { postId: post._id.toString(), error: err.message });
  } finally {
    fs.rm(tempPath, () => {});
  }
}

async function runSweep() {
  for (let i = 0; i < BATCH_SIZE; i++) {
    const post = await claimNext();
    if (!post) break; // nothing pending — done for this run
    await processOne(post);
  }
  await retryUndraftedReady();
}

// Self-heals a real gap found 2026-09-06: the drafts call below no-ops
// silently if TELEGRAM_* isn't set in whatever environment runSweep() runs
// in (or if the Telegram API call itself fails), and processOne() doesn't
// retry a failed draft on its own since the post is already 'ready' by
// then. Every sweep re-checks for 'ready' posts still missing a TikTok
// draft and retries — cheap (no re-render, no re-upload) and catches both
// this specific gap and any future transient Telegram outage. (Instagram
// dropped out of this retry 2026-09-10 — real auto-posting replaced the
// manual draft, self-heals via its own instagramStatus queue instead.)
async function retryUndraftedReady() {
  const stragglers = await BlogPost.find({
    videoStatus: 'ready',
    tiktokDraftedAt: null,
  }).limit(20);
  for (const post of stragglers) {
    await postBlogVideoToTikTokDrafts(post).catch(() => {});
  }
}

export default function startBlogVideoWorker() {
  if (process.env.ENABLE_BLOG_VIDEO_WORKER !== 'true') {
    logger.info('Blog video worker not started (ENABLE_BLOG_VIDEO_WORKER is not "true") — safe default, see the deployed path in jobs/blogVideoWorker.js\'s docstring.');
    return;
  }

  cron.schedule('*/5 * * * *', async () => {
    try {
      await runSweep();
    } catch (err) {
      logger.error('Blog video sweep error', { error: err.message });
    }
  }, { timezone: 'UTC' });

  logger.info('📝 Blog video worker scheduled (every 5 minutes)');
}

// Also runnable as its own standalone process/one-shot script.
export { runSweep };
