/**
 * Drains BlogPost/Listing rows with youtubeStatus:'pending' — downloads the
 * already-rendered video from its Cloudinary URL and uploads it to Xpress
 * Vet's own YouTube channel as a Short. Deliberately separate from
 * blogVideoWorker.js/listingVideoWorker.js: this worker never renders
 * anything, it only re-uploads a video that already exists, so it can run
 * on its own much slower cadence without becoming the bottleneck for
 * Cloudinary/Telegram delivery.
 *
 * BATCH_SIZE is intentionally small — NOT primarily a quota constraint
 * (verified via a live search before building this: as of the June 2026
 * YouTube API change, videos.insert has its own separate 100-calls/day
 * bucket, so quota alone would allow far more than this). The real reason
 * is content strategy: a brand-new channel that dumps 20+ videos in one day
 * looks spammy to both viewers and YouTube's own recommendation system.
 * Spreading uploads out is simply better practice, independent of quota.
 *
 * No-ops entirely (skips every row, does nothing) until Sam completes the
 * one-time setup in scripts/youtube-authorize.mjs and the 3 YOUTUBE_* env
 * vars are set — see lib/youtubeUpload.js's docstring.
 *
 * SCHEDULING: each video in a sweep uploads as private + a specific
 * status.publishAt timestamp (see lib/youtubeUpload.js) rather than
 * going public immediately — YouTube itself flips it public at that
 * moment. Slot times are NOT an even spread; they're weighted toward real
 * engagement-timing research checked live before building this (2026):
 * for a Nigerian audience, weekday engagement peaks 4-8pm, weekends peak
 * 9am-12pm, and Shorts generally get a secondary midday bump (12-3pm) —
 * see https://www.hopperhq.com/blog/best-time-to-post-youtube-shorts/ and
 * https://nivedigitalacademy.com/best-time-to-post-on-youtube/. Every
 * source agrees this is a starting point, not a guarantee — the real fix
 * once the channel has traffic is to check YouTube Studio's own Audience
 * tab and retune these slots to when Xpress Vet's actual viewers are
 * online, which no generic research can substitute for.
 *
 * The GitHub Actions cron (see .github/workflows/youtube-upload-worker.yml)
 * runs at 5am UTC/6am WAT — deliberately before the earliest slot below
 * (8am UTC), since YouTube rejects a publishAt that isn't in the future.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import fetch from 'node-fetch';
import BlogPost from '../models/BlogPost.js';
import Listing from '../models/Listing.js';
import { uploadVideoToYouTube, isYoutubeConfigured } from '../lib/youtubeUpload.js';
import logger from '../lib/logger.js';

const BATCH_SIZE = 6; // combined across both content sources, per sweep
const WORK_DIR = path.join(os.tmpdir(), 'xpress-vet-youtube-upload');
const SHARE_ORIGIN = 'https://go.xpressvetmarketplace.com';

// Nigeria is WAT, UTC+1 year-round (no DST) — these are WAT times converted
// to UTC ({h,m} in UTC). Weekday slots skew toward the 4-8pm WAT peak with
// two earlier check-in slots; weekend slots skew toward the 9am-12pm WAT
// peak with two afternoon/evening secondary slots. Six of each, matching
// BATCH_SIZE.
const WEEKDAY_SLOTS_UTC = [
  { h: 8, m: 0 },   // 9:00am WAT
  { h: 11, m: 0 },  // 12:00pm WAT
  { h: 13, m: 30 }, // 2:30pm WAT
  { h: 16, m: 0 },  // 5:00pm WAT — start of the 4-8pm peak window
  { h: 18, m: 0 },  // 7:00pm WAT
  { h: 19, m: 30 }, // 8:30pm WAT — tail of the peak window
];
const WEEKEND_SLOTS_UTC = [
  { h: 8, m: 0 },   // 9:00am WAT — start of the 9am-12pm peak window
  { h: 9, m: 0 },   // 10:00am WAT
  { h: 10, m: 0 },  // 11:00am WAT
  { h: 11, m: 0 },  // 12:00pm WAT — end of the peak window
  { h: 14, m: 0 },  // 3:00pm WAT — secondary midday-Shorts bump
  { h: 17, m: 0 },  // 6:00pm WAT — secondary evening slot
];

/**
 * Returns an ISO-8601 UTC timestamp for "today, slot N" — always today's
 * date since the cron runs once/day and hands out at most BATCH_SIZE slots
 * per run, so slotIndex never wraps into tomorrow within a single sweep.
 */
function computePublishAt(slotIndex) {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun..6=Sat
  const isWeekend = day === 0 || day === 6;
  const slots = isWeekend ? WEEKEND_SLOTS_UTC : WEEKDAY_SLOTS_UTC;
  const slot = slots[slotIndex % slots.length];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), slot.h, slot.m, 0));
  return d.toISOString();
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.body.pipe(out);
    res.body.on('error', reject);
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

function buildBlogDescription(post) {
  return [
    post.excerpt || '',
    '',
    `Full guide: ${SHARE_ORIGIN}/b/${post.slug}`,
    '',
    'Xpress Vet Marketplace — buy, sell, and find veterinary services and products across Nigeria.',
    '',
    '#XpressVet #VeterinaryTips #PetsOfNigeria #AnimalHealth #Shorts',
  ].join('\n');
}

function buildListingDescription(listing) {
  const price = Number.isFinite(listing.price) ? `₦${listing.price.toLocaleString('en-NG')}` : null;
  return [
    listing.description ? listing.description.slice(0, 300) : '',
    '',
    price ? `Price: ${price}${listing.negotiable ? ' (negotiable)' : ''}` : null,
    listing.city ? `Location: ${listing.city}` : null,
    `View & buy: ${SHARE_ORIGIN}/l/${listing._id}`,
    '',
    'Xpress Vet Marketplace — buy, sell, and find veterinary services and products across Nigeria.',
    '',
    '#XpressVet #PetsOfNigeria #NigeriaTech #Shorts',
  ].filter(Boolean).join('\n');
}

async function claimNextBlogPost() {
  return BlogPost.findOneAndUpdate(
    { youtubeStatus: 'pending' },
    { $set: { youtubeStatus: 'processing' } },
    { sort: { publishedAt: 1 }, new: true },
  ).catch(() => null);
}

async function claimNextListing() {
  return Listing.findOneAndUpdate(
    { youtubeStatus: 'pending' },
    { $set: { youtubeStatus: 'processing' } },
    { sort: { updatedAt: 1 }, new: true },
  ).catch(() => null);
}

async function processBlogPost(post, slotIndex) {
  const tempPath = path.join(WORK_DIR, `blog-${post._id}.mp4`);
  try {
    await downloadToFile(post.videoUrl, tempPath);
    const publishAt = computePublishAt(slotIndex);
    const { videoId, url } = await uploadVideoToYouTube(tempPath, {
      title: post.title,
      description: buildBlogDescription(post),
      tags: ['veterinary', 'pets', 'nigeria', 'xpressvet', ...(post.tags || [])],
      publishAt,
    });
    post.youtubeStatus = 'uploaded';
    post.youtubeVideoId = videoId;
    post.youtubeUrl = url;
    post.youtubeError = null;
    post.youtubeAt = new Date();
    await post.save();
    logger.info('Blog video uploaded to YouTube (scheduled)', { postId: post._id.toString(), url, publishAt });
  } catch (err) {
    post.youtubeStatus = 'failed';
    post.youtubeError = (err.message || 'Unknown YouTube upload error').slice(0, 500);
    await post.save().catch(() => {});
    logger.error('Blog video YouTube upload failed', { postId: post._id.toString(), error: err.message });
  } finally {
    fs.rm(tempPath, () => {});
  }
}

async function processListing(listing, slotIndex) {
  const tempPath = path.join(WORK_DIR, `listing-${listing._id}.mp4`);
  try {
    await downloadToFile(listing.generatedVideoUrl, tempPath);
    const publishAt = computePublishAt(slotIndex);
    const { videoId, url } = await uploadVideoToYouTube(tempPath, {
      title: listing.title,
      description: buildListingDescription(listing),
      tags: ['pets', 'nigeria', 'xpressvet', 'marketplace'],
      publishAt,
    });
    listing.youtubeStatus = 'uploaded';
    listing.youtubeVideoId = videoId;
    listing.youtubeUrl = url;
    listing.youtubeError = null;
    listing.youtubeAt = new Date();
    await listing.save();
    logger.info('Listing video uploaded to YouTube (scheduled)', { listingId: listing._id.toString(), url, publishAt });
  } catch (err) {
    listing.youtubeStatus = 'failed';
    listing.youtubeError = (err.message || 'Unknown YouTube upload error').slice(0, 500);
    await listing.save().catch(() => {});
    logger.error('Listing video YouTube upload failed', { listingId: listing._id.toString(), error: err.message });
  } finally {
    fs.rm(tempPath, () => {});
  }
}

export async function runSweep() {
  if (!isYoutubeConfigured()) {
    logger.info('YouTube upload worker: not configured yet (YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN missing) — skipping sweep. See scripts/youtube-authorize.mjs.');
    return;
  }

  fs.mkdirSync(WORK_DIR, { recursive: true });

  let done = 0;
  while (done < BATCH_SIZE) {
    // `done` doubles as this sweep's slot index — each video claimed gets
    // the next scheduled publish time, so no two uploads in the same
    // sweep share a slot regardless of which source they came from.
    const post = await claimNextBlogPost();
    if (post) { await processBlogPost(post, done); done++; continue; }

    const listing = await claimNextListing();
    if (listing) { await processListing(listing, done); done++; continue; }

    break; // nothing pending in either collection — done for this run
  }
}
