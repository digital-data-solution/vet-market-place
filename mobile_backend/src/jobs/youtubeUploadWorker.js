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

async function processBlogPost(post) {
  const tempPath = path.join(WORK_DIR, `blog-${post._id}.mp4`);
  try {
    await downloadToFile(post.videoUrl, tempPath);
    const { videoId, url } = await uploadVideoToYouTube(tempPath, {
      title: post.title,
      description: buildBlogDescription(post),
      tags: ['veterinary', 'pets', 'nigeria', 'xpressvet', ...(post.tags || [])],
    });
    post.youtubeStatus = 'uploaded';
    post.youtubeVideoId = videoId;
    post.youtubeUrl = url;
    post.youtubeError = null;
    post.youtubeAt = new Date();
    await post.save();
    logger.info('Blog video uploaded to YouTube', { postId: post._id.toString(), url });
  } catch (err) {
    post.youtubeStatus = 'failed';
    post.youtubeError = (err.message || 'Unknown YouTube upload error').slice(0, 500);
    await post.save().catch(() => {});
    logger.error('Blog video YouTube upload failed', { postId: post._id.toString(), error: err.message });
  } finally {
    fs.rm(tempPath, () => {});
  }
}

async function processListing(listing) {
  const tempPath = path.join(WORK_DIR, `listing-${listing._id}.mp4`);
  try {
    await downloadToFile(listing.generatedVideoUrl, tempPath);
    const { videoId, url } = await uploadVideoToYouTube(tempPath, {
      title: listing.title,
      description: buildListingDescription(listing),
      tags: ['pets', 'nigeria', 'xpressvet', 'marketplace'],
    });
    listing.youtubeStatus = 'uploaded';
    listing.youtubeVideoId = videoId;
    listing.youtubeUrl = url;
    listing.youtubeError = null;
    listing.youtubeAt = new Date();
    await listing.save();
    logger.info('Listing video uploaded to YouTube', { listingId: listing._id.toString(), url });
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
    // Alternate sources so one large backlog (currently the blog videos)
    // doesn't starve the other of upload slots.
    const post = await claimNextBlogPost();
    if (post) { await processBlogPost(post); done++; continue; }

    const listing = await claimNextListing();
    if (listing) { await processListing(listing); done++; continue; }

    break; // nothing pending in either collection — done for this run
  }
}
