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

// Per-post stats (Sept 2026, 60 Reels): cat/dog clinical topics reached
// ~130-215 accounts each, most poultry posts under 20 — so cat/dog posts
// jump the queue. Tags are free-form, hence the case-insensitive match.
const PRIORITY_TAGS = [/^cats?$/i, /^dogs?$/i];

// Promo Reels (pricing, listing video ads, feature announcements) all
// reached under 20 accounts, so Sam dropped them from Instagram (2026-09-28).
// They still go to the Facebook Page, where caption links are clickable.
// Listings are always promo; blog posts are promo when tagged like these.
const PROMO_TAGS = [/^xpress market$/i, /^new feature$/i];
const isPromoPost = (post) => (post.tags || []).some((t) => PROMO_TAGS.some((re) => re.test(t)));

// Only 5 comments across those 60 Reels. Ending on a question invites them,
// and comments are what gets a Reel shown to more people.
function commentPrompt(tags = []) {
  const has = (re) => tags.some((t) => re.test(t));
  if (has(/^cats?$/i)) return 'Has your cat ever had this? Tell us in the comments 👇';
  if (has(/^dogs?$/i)) return 'Has your dog ever had this? Tell us in the comments 👇';
  if (has(/^(poultry|chickens?|broilers?|layers?)$/i)) return 'Have you seen this on your farm? Tell us in the comments 👇';
  if (has(/^(cattle|goats?|sheep|pigs?|livestock|ruminants?)$/i)) return 'Have you seen this in your herd? Tell us in the comments 👇';
  return 'Got a question for a vet? Ask in the comments 👇';
}

// Instagram captions can't hold clickable links, so the Instagram version
// points to the link in bio (set to /Blog?src=ig by hand in the Instagram
// app — the Graph API can't edit the bio). With a bare URL in the caption,
// 38 Reels reaching ~1.5k accounts drove only ~27 blog views (Sept 2026).
// Facebook DOES make caption links clickable, so it gets the direct link.
// ?src= tags feed models/ShareClick.js so clicks per platform are countable.
function buildBlogCaption(post, platform = 'ig') {
  const link = platform === 'ig'
    ? '📖 Full guide → link in bio'
    : `📖 Full guide: ${SHARE_ORIGIN}/b/${post.slug}?src=${platform}`;
  return [
    `${post.title} 🐾`,
    '',
    'Free vet-backed tips, no login needed.',
    '',
    commentPrompt(post.tags),
    '',
    link,
    '',
    '#XpressVet #VeterinaryTips #PetsOfNigeria #AnimalHealth #Reels',
  ].join('\n');
}

function buildListingCaption(listing, platform = 'ig') {
  const price = Number.isFinite(listing.price) ? `₦${listing.price.toLocaleString('en-NG')}` : null;
  const location = listing.city ? ` in ${listing.city}` : '';
  const link = platform === 'ig'
    ? '📲 See it on Xpress Vet → link in bio'
    : `📲 ${SHARE_ORIGIN}/l/${listing._id}?src=${platform}`;
  return [
    'Every listing on Xpress Vet gets a video ad like this — made completely automatically. 🎬',
    '',
    `"${listing.title}"${price ? ` — ${price}` : ''}${location}`,
    '',
    link,
    '',
    '#XpressVet #PetsOfNigeria #SmallBusinessNigeria #Reels #NigeriaTech',
  ].join('\n');
}

async function claimNextBlogPost() {
  const claim = (filter) => BlogPost.findOneAndUpdate(
    { instagramStatus: 'pending', ...filter },
    { $set: { instagramStatus: 'processing' } },
    { sort: { publishedAt: 1 }, new: true },
  ).catch(() => null);
  return (await claim({ tags: { $in: PRIORITY_TAGS } })) || claim({});
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
  if (doc.facebookStatus === 'posted') return; // an Instagram retry must not double-post to the Page
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

// Facebook only; instagramStatus goes back to 'none' so it isn't re-claimed
// ('none' is also what the video workers treat as "never queued").
async function processFacebookOnly(doc, videoUrl, caption, label) {
  await tryPostToFacebook(doc, videoUrl, caption, label);
  doc.instagramStatus = 'none';
  await doc.save().catch(() => {});
  logger.info(`${label} promo video skipped on Instagram`, { id: doc._id.toString() });
}

async function processBlogPost(post) {
  if (isPromoPost(post)) return processFacebookOnly(post, post.videoUrl, buildBlogCaption(post, 'fb'), 'Blog');
  try {
    const { mediaId, url } = await postReelToInstagram(post.videoUrl, buildBlogCaption(post));
    post.instagramStatus = 'posted';
    post.instagramMediaId = mediaId;
    post.instagramUrl = url;
    post.instagramError = null;
    post.instagramPostedAt = new Date();
    await tryPostToFacebook(post, post.videoUrl, buildBlogCaption(post, 'fb'), 'Blog');
    await post.save();
    logger.info('Blog video posted to Instagram', { postId: post._id.toString(), url });
  } catch (err) {
    post.instagramStatus = 'failed';
    post.instagramError = (err.message || 'Unknown Instagram post error').slice(0, 500);
    await tryPostToFacebook(post, post.videoUrl, buildBlogCaption(post, 'fb'), 'Blog');
    await post.save().catch(() => {});
    logger.error('Blog video Instagram post failed', { postId: post._id.toString(), error: err.message });
  }
}

async function processListing(listing) {
  return processFacebookOnly(listing, listing.generatedVideoUrl, buildListingCaption(listing, 'fb'), 'Listing');
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
    // Facebook-only promo items don't use up an Instagram slot.
    const post = await claimNextBlogPost();
    if (post) { const promo = isPromoPost(post); await processBlogPost(post); if (!promo) done++; continue; }

    const listing = await claimNextListing();
    if (listing) { await processListing(listing); continue; }

    break; // nothing pending in either collection — done for this run
  }
}
