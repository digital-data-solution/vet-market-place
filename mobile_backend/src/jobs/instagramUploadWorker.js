/**
 * Drains BlogPost/Listing rows with instagramStatus:'pending' — posts the
 * already-rendered video (already on Cloudinary, already the right 9:16
 * shape) straight to Xpress Vet's own Instagram account (@xpressvet) as a
 * Reel via the Graph API. No download/re-upload step needed here (unlike
 * YouTube) — Instagram's API takes the Cloudinary URL directly.
 *
 * Built 2026-09-06/10 once Sam said manual copy-paste-from-Telegram wasn't
 * sustainable. See lib/instagramUpload.js's docstring for the auth model
 * and the real operational catch: the access token expires ~60 days after
 * issue and needs manual renewal (scripts/instagram-authorize.mjs) — this
 * worker logs a loud warning via checkTokenAge() well before that happens
 * rather than silently going quiet one day.
 *
 * UNLIKE YouTube, the Graph API has no "upload now, publish later" param
 * for Reels — calling media_publish makes it live immediately. So instead
 * of one daily sweep handing out scheduled publish times, the TIMING comes
 * from WHEN the GitHub Actions cron itself fires — see
 * .github/workflows/instagram-upload-worker.yml, which runs at the same
 * researched Nigeria-engagement windows as the YouTube worker's slots
 * (weekday middays+evenings, weekend late mornings), 2-3 times/day. Each
 * run posts a small batch (BATCH_SIZE), not everything pending — this is
 * the throttle that keeps the cadence natural instead of dumping the whole
 * queue the first time this runs. Instagram's own publish-rate limits
 * (~25-100/day depending on source, never pinned down against Meta's own
 * docs — that site was unreachable while building this) are nowhere near
 * a concern at this volume; the real reason for pacing is content strategy,
 * same as everywhere else in this pipeline.
 */
import BlogPost from '../models/BlogPost.js';
import Listing from '../models/Listing.js';
import { postReelToInstagram, isInstagramConfigured, checkTokenAge } from '../lib/instagramUpload.js';
import { postVideoToFacebookPage, isFacebookConfigured } from '../lib/facebookUpload.js';
import logger from '../lib/logger.js';

const BATCH_SIZE = 2; // combined across both content sources, per sweep — see the cron for how often sweeps run
const SHARE_ORIGIN = 'https://go.xpressvetmarketplace.com';

function buildBlogCaption(post) {
  return [
    `${post.title} 🐾`,
    '',
    'Free vet-backed tips, no login needed.',
    '',
    `📖 Full guide: ${SHARE_ORIGIN}/b/${post.slug}`,
    '',
    '#XpressVet #VeterinaryTips #PetsOfNigeria #AnimalHealth #Reels',
  ].join('\n');
}

function buildListingCaption(listing) {
  const price = Number.isFinite(listing.price) ? `₦${listing.price.toLocaleString('en-NG')}` : null;
  const location = listing.city ? ` in ${listing.city}` : '';
  return [
    'Every listing on Xpress Vet gets a video ad like this — made completely automatically. 🎬',
    '',
    `"${listing.title}"${price ? ` — ${price}` : ''}${location}`,
    '',
    `📲 ${SHARE_ORIGIN}/l/${listing._id}`,
    '',
    '#XpressVet #PetsOfNigeria #SmallBusinessNigeria #Reels #NigeriaTech',
  ].join('\n');
}

async function claimNextBlogPost() {
  return BlogPost.findOneAndUpdate(
    { instagramStatus: 'pending' },
    { $set: { instagramStatus: 'processing' } },
    { sort: { publishedAt: 1 }, new: true },
  ).catch(() => null);
}

async function claimNextListing() {
  return Listing.findOneAndUpdate(
    { instagramStatus: 'pending' },
    { $set: { instagramStatus: 'processing' } },
    { sort: { updatedAt: 1 }, new: true },
  ).catch(() => null);
}

// Facebook posting is best-effort, attempted alongside Instagram using the
// same video + caption — never blocks or is blocked by the Instagram
// result. Same System User token, just a different Graph API endpoint
// (see lib/facebookUpload.js).
async function tryPostToFacebook(doc, videoUrl, caption, label) {
  if (!isFacebookConfigured()) return;
  try {
    const { videoId, url } = await postVideoToFacebookPage(videoUrl, caption);
    doc.facebookStatus = 'posted';
    doc.facebookVideoId = videoId;
    doc.facebookUrl = url;
    doc.facebookError = null;
    doc.facebookPostedAt = new Date();
    logger.info(`${label} video posted to Facebook`, { id: doc._id.toString(), url });
  } catch (err) {
    doc.facebookStatus = 'failed';
    doc.facebookError = (err.message || 'Unknown Facebook post error').slice(0, 500);
    logger.error(`${label} video Facebook post failed`, { id: doc._id.toString(), error: err.message });
  }
}

async function processBlogPost(post) {
  try {
    const { mediaId, url } = await postReelToInstagram(post.videoUrl, buildBlogCaption(post));
    post.instagramStatus = 'posted';
    post.instagramMediaId = mediaId;
    post.instagramUrl = url;
    post.instagramError = null;
    post.instagramPostedAt = new Date();
    await tryPostToFacebook(post, post.videoUrl, buildBlogCaption(post), 'Blog');
    await post.save();
    logger.info('Blog video posted to Instagram', { postId: post._id.toString(), url });
  } catch (err) {
    post.instagramStatus = 'failed';
    post.instagramError = (err.message || 'Unknown Instagram post error').slice(0, 500);
    await tryPostToFacebook(post, post.videoUrl, buildBlogCaption(post), 'Blog');
    await post.save().catch(() => {});
    logger.error('Blog video Instagram post failed', { postId: post._id.toString(), error: err.message });
  }
}

async function processListing(listing) {
  try {
    const { mediaId, url } = await postReelToInstagram(listing.generatedVideoUrl, buildListingCaption(listing));
    listing.instagramStatus = 'posted';
    listing.instagramMediaId = mediaId;
    listing.instagramUrl = url;
    listing.instagramError = null;
    listing.instagramPostedAt = new Date();
    await tryPostToFacebook(listing, listing.generatedVideoUrl, buildListingCaption(listing), 'Listing');
    await listing.save();
    logger.info('Listing video posted to Instagram', { listingId: listing._id.toString(), url });
  } catch (err) {
    listing.instagramStatus = 'failed';
    listing.instagramError = (err.message || 'Unknown Instagram post error').slice(0, 500);
    await tryPostToFacebook(listing, listing.generatedVideoUrl, buildListingCaption(listing), 'Listing');
    await listing.save().catch(() => {});
    logger.error('Listing video Instagram post failed', { listingId: listing._id.toString(), error: err.message });
  }
}

export async function runSweep() {
  if (!isInstagramConfigured()) {
    logger.info('Instagram upload worker: not configured yet (INSTAGRAM_ACCOUNT_ID/ACCESS_TOKEN missing) — skipping sweep. See scripts/instagram-authorize.mjs.');
    return;
  }

  const tokenWarning = checkTokenAge();
  if (tokenWarning) logger.error(`Instagram token warning: ${tokenWarning}`); // logger.error, not .info — this deserves attention even though it's not a hard failure yet

  let done = 0;
  while (done < BATCH_SIZE) {
    const post = await claimNextBlogPost();
    if (post) { await processBlogPost(post); done++; continue; }

    const listing = await claimNextListing();
    if (listing) { await processListing(listing); done++; continue; }

    break; // nothing pending in either collection — done for this run
  }
}
