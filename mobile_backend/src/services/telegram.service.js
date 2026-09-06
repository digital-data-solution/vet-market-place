// Posts new Xpress Market listings to a public Telegram channel — a plain
// chronological broadcast feed with no algorithmic reach-throttling (unlike
// Facebook/Instagram Pages, where API-published posts are still subject to
// feed-ranking). See memory: xpress-vet-social-autopost for the full
// legal/platform-comparison writeup behind this choice.
//
// Setup (one-time, done by a human via Telegram, not by this code):
//   1. Message @BotFather in Telegram -> /newbot -> follow prompts -> copy the token.
//   2. Create a public channel (e.g. @XpressVetListings) and add the bot as an
//      admin with "Post Messages" permission.
//   3. Get the channel id: either the @handle itself (e.g. "@XpressVetListings")
//      or, for a private channel, forward any message from it to @userinfobot.
//   4. Set these two env vars in Render (see memory: env-vars-via-render —
//      never write these into a committed .env file):
//        TELEGRAM_BOT_TOKEN=<token from BotFather>
//        TELEGRAM_CHANNEL_ID=<@handle or numeric -100... id>
//
// If either env var is unset, every call below is a no-op — same
// degrade-gracefully pattern as Redis (see vetfresh-known-gotchas memory).
// This never throws; callers can fire-and-forget with .catch(() => {}) same
// as sendListingLiveEmail, but errors are logged here either way.
//
// Second target, shipped 2026-08-21: a private "WhatsApp drafts" channel on
// the SAME bot (TELEGRAM_WA_DRAFTS_CHAT_ID). This does NOT post to WhatsApp
// itself — there's no legitimate API for that (see memory: xpress-vet-social-
// autopost). It pushes a ready-to-copy-paste draft, formatted with WhatsApp's
// own *bold*/_italic_/~strike~ markers, into a private Telegram channel only
// the user can see, so they can paste it into WhatsApp by hand. Set up the
// same way as the public channel (@BotFather, add the bot as admin), just a
// second, private channel instead of a public one.

import fetch from 'node-fetch';
import logger from '../lib/logger.js';
import Listing from '../models/Listing.js';

const BOT_TOKEN         = process.env.TELEGRAM_BOT_TOKEN || '';
const CHANNEL_ID        = process.env.TELEGRAM_CHANNEL_ID || '';
const WA_DRAFTS_CHAT_ID = process.env.TELEGRAM_WA_DRAFTS_CHAT_ID || '';
const SHARE_ORIGIN = 'https://go.xpressvetmarketplace.com';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatPrice(price, currency) {
  if (!Number.isFinite(price)) return null;
  const symbol = currency === 'NGN' ? '₦' : `${currency} `;
  return `${symbol}${price.toLocaleString('en-NG')}`;
}

function buildCaption(listing) {
  const lines = [`🆕 <b>${esc(listing.title)}</b>`];
  const price = formatPrice(listing.price, listing.currency);
  if (price) lines.push(price + (listing.negotiable ? ' (negotiable)' : ''));
  if (listing.city) lines.push(`📍 ${esc(listing.city)}`);
  lines.push(`${SHARE_ORIGIN}/l/${listing._id}`);
  return lines.join('\n');
}

/**
 * Post a newly-created Xpress Market listing to the configured Telegram
 * channel. Safe to call unconditionally — no-ops if not configured, never
 * throws.
 */
export async function postListingToTelegram(listing) {
  if (!BOT_TOKEN || !CHANNEL_ID) return; // integration not set up yet

  const caption = buildCaption(listing);
  const photoUrl = listing.images?.[0]?.url || null;
  const method = photoUrl ? 'sendPhoto' : 'sendMessage';
  const body = photoUrl
    ? { chat_id: CHANNEL_ID, photo: photoUrl, caption, parse_mode: 'HTML' }
    : { chat_id: CHANNEL_ID, text: caption, parse_mode: 'HTML', disable_web_page_preview: false };

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      logger.error('Telegram post failed', { listingId: listing._id, status: res.status, description: data.description });
    }
  } catch (error) {
    logger.error('Telegram post error', { listingId: listing._id, error: error.message });
  }
}

/**
 * Posts a listing's auto-generated video ad (services/listingVideo.service.js)
 * to the same public channel, once it's ready — a SEPARATE post from
 * postListingToTelegram above, not a replacement. The photo post already
 * fires immediately at listing-creation time; the video isn't ready for up
 * to ~30 minutes after that (see jobs/listingVideoWorker.js's schedule), so
 * this is a natural follow-up post rather than something to merge into one.
 * Called from listingVideoWorker.js's success path, fire-and-forget.
 */
export async function postListingVideoToTelegram(listing) {
  if (!BOT_TOKEN || !CHANNEL_ID) return; // integration not set up yet
  if (!listing.generatedVideoUrl) return;

  const price = formatPrice(listing.price, listing.currency);
  const lines = [`🎬 <b>${esc(listing.title)}</b> — video ad`];
  if (price) lines.push(price + (listing.negotiable ? ' (negotiable)' : ''));
  if (listing.city) lines.push(`📍 ${esc(listing.city)}`);
  lines.push(`${SHARE_ORIGIN}/l/${listing._id}`);
  const caption = lines.join('\n');

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHANNEL_ID, video: listing.generatedVideoUrl, caption, parse_mode: 'HTML' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      logger.error('Telegram video post failed', { listingId: listing._id, status: res.status, description: data.description });
    }
  } catch (error) {
    logger.error('Telegram video post error', { listingId: listing._id, error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp drafts (private channel, same bot)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a WhatsApp-ready caption: raw *bold* and pin-emoji formatting, no
 * HTML/Markdown escaping — this is never sent through Telegram's own
 * parse_mode, see the critical note in postListingToWhatsAppDrafts.
 * Telegram's media-caption limit is 1024 chars; only the description is
 * ever trimmed to fit — the heading and the trailing link block are never
 * truncated.
 */
function buildWhatsAppCaption(listing) {
  const price = formatPrice(listing.price, listing.currency);
  const link = `${SHARE_ORIGIN}/l/${listing._id}`;

  const head = [
    '*New on Xpress Vet Marketplace*',
    '',
    `*${listing.title}*`,
    price ? price + (listing.negotiable ? ' (negotiable)' : '') : null,
    listing.city ? `📍 ${listing.city}` : null,
  ].filter(Boolean).join('\n');

  const tail = `\n\nView & buy:\n${link}`;

  const desc = (listing.description || '').trim();
  const budget = 1024 - head.length - tail.length - 2; // -2 for the blank line before it
  let body = '';
  if (desc && budget > 20) {
    body = '\n\n' + (desc.length > budget ? desc.slice(0, budget - 1).trimEnd() + '…' : desc);
  }

  return `${head}${body}${tail}`;
}

/**
 * Push a WhatsApp-ready draft of a newly-created listing into the private
 * drafts channel. No-ops if not configured, if there's no photo to draft
 * from, or if this listing already has a draft (idempotency guard — mirrors
 * the sellerAgreementAcceptedAt pattern in market.controller.js). Never
 * throws; call this in its own try/catch (or fire-and-forget with
 * .catch(() => {})) separate from postListingToTelegram — a failed draft
 * push must never affect the live public post or the listing itself.
 */
export async function postListingToWhatsAppDrafts(listing) {
  if (!BOT_TOKEN || !WA_DRAFTS_CHAT_ID) return; // integration not set up yet
  if (listing.whatsappDraftedAt) return;        // already drafted — don't re-queue

  const photoUrl = listing.images?.[0]?.url || null;
  if (!photoUrl) return; // draft is photo-first; nothing to draft without one

  const caption = buildWhatsAppCaption(listing);

  // CRITICAL: no parse_mode. Telegram's MarkdownV2 would consume the bare
  // asterisks below as ITS OWN formatting syntax and strip them — WhatsApp
  // needs those asterisks to survive raw so *bold* still reads as *bold*
  // after a straight copy-paste. Sending with no parse_mode at all means
  // Telegram treats the text as plain and passes it through untouched.
  const body = { chat_id: WA_DRAFTS_CHAT_ID, photo: photoUrl, caption };

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      logger.error('Telegram WhatsApp-draft post failed', { listingId: listing._id, status: res.status, description: data.description });
      return;
    }
    await Listing.updateOne(
      { _id: listing._id, whatsappDraftedAt: null },
      { $set: { whatsappDraftedAt: new Date() } },
    );
  } catch (error) {
    logger.error('Telegram WhatsApp-draft post error', { listingId: listing._id, error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TikTok drafts (same private channel as WhatsApp drafts, same bot)
//
// TikTok's Content Posting API restricts unaudited apps to PRIVATE-only
// posts (see [[xpress-vet-marketing-next-steps]] memory / the audit
// research done 2026-09-06) — real public auto-posting isn't available
// until Sam applies for and passes that audit, which needs a real posting
// history as evidence first. Until then, this is the same "automate the
// prep, human clicks the last button" pattern already proven for WhatsApp:
// the finished video + a ready caption land in Sam's private drafts
// channel the moment a listing's video is ready, so posting to TikTok by
// hand takes 10 seconds (open Telegram, save video, copy caption, paste)
// instead of him having to come ask Claude for a caption each time.
// ─────────────────────────────────────────────────────────────────────────────

function buildTikTokCaption(listing) {
  const price = formatPrice(listing.price, listing.currency);
  const location = listing.city ? ` in ${listing.city}` : '';
  return [
    'Every listing on Xpress Vet gets a video ad like this — made completely automatically. 🎬',
    '',
    `"${listing.title}"${price ? ` — ${price}` : ''}${location}`,
    '',
    '📲 xpressvetmarketplace.com',
    '',
    '#XpressVet #PetsOfNigeria #SmallBusinessNigeria #AI #NigeriaTech',
  ].join('\n');
}

/**
 * Push a TikTok-ready draft (the actual generated video + a ready caption)
 * into the private drafts channel once a listing's video is 'ready'. Same
 * idempotency guard shape as postListingToWhatsAppDrafts (tiktokDraftedAt).
 * Never throws; call fire-and-forget from listingVideoWorker.js.
 */
export async function postListingVideoToTikTokDrafts(listing) {
  if (!BOT_TOKEN || !WA_DRAFTS_CHAT_ID) return; // integration not set up yet
  if (listing.tiktokDraftedAt) return;           // already drafted
  if (!listing.generatedVideoUrl) return;

  const caption = `🎵 TIKTOK DRAFT\n\n${buildTikTokCaption(listing)}`;
  const body = { chat_id: WA_DRAFTS_CHAT_ID, video: listing.generatedVideoUrl, caption };

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      logger.error('Telegram TikTok-draft post failed', { listingId: listing._id, status: res.status, description: data.description });
      return;
    }
    await Listing.updateOne(
      { _id: listing._id, tiktokDraftedAt: null },
      { $set: { tiktokDraftedAt: new Date() } },
    );
  } catch (error) {
    logger.error('Telegram TikTok-draft post error', { listingId: listing._id, error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Instagram Reels drafts (same private channel, same bot)
//
// Unlike a plain Facebook Page post, Reels get pushed through Instagram's
// own discovery feed — real organic reach even for a brand-new account, not
// just followers-only. Deliberately NOT automated via the Graph API (see
// [[xpress-vet-social-autopost]] memory — evaluated and skipped for regular
// feed posts due to algorithmic throttling; Reels specifically might behave
// differently but that's unverified and not worth building until there's a
// reason to). Since every generated video is already the exact vertical
// format Reels wants, this costs nothing extra — same file, same drafts
// pattern as TikTok, just a different caption/label.
// ─────────────────────────────────────────────────────────────────────────────

function buildInstagramCaption(listing) {
  const price = formatPrice(listing.price, listing.currency);
  const location = listing.city ? ` in ${listing.city}` : '';
  return [
    'Every listing on Xpress Vet gets a video ad like this — made completely automatically. 🎬',
    '',
    `"${listing.title}"${price ? ` — ${price}` : ''}${location}`,
    '',
    '📲 Link in bio — xpressvetmarketplace.com',
    '',
    '#XpressVet #PetsOfNigeria #SmallBusinessNigeria #ReelsNigeria #NigeriaTech',
  ].join('\n');
}

/**
 * Push an Instagram-Reels-ready draft into the private drafts channel once
 * a listing's video is 'ready'. Same idempotency guard shape as the TikTok
 * and WhatsApp drafts. Never throws; call fire-and-forget from
 * listingVideoWorker.js.
 */
export async function postListingVideoToInstagramDrafts(listing) {
  if (!BOT_TOKEN || !WA_DRAFTS_CHAT_ID) return; // integration not set up yet
  if (listing.instagramDraftedAt) return;        // already drafted
  if (!listing.generatedVideoUrl) return;

  const caption = `📸 INSTAGRAM REELS DRAFT\n\n${buildInstagramCaption(listing)}`;
  const body = { chat_id: WA_DRAFTS_CHAT_ID, video: listing.generatedVideoUrl, caption };

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      logger.error('Telegram Instagram-draft post failed', { listingId: listing._id, status: res.status, description: data.description });
      return;
    }
    await Listing.updateOne(
      { _id: listing._id, instagramDraftedAt: null },
      { $set: { instagramDraftedAt: new Date() } },
    );
  } catch (error) {
    logger.error('Telegram Instagram-draft post error', { listingId: listing._id, error: error.message });
  }
}
