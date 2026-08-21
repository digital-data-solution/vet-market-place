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

import fetch from 'node-fetch';
import logger from '../lib/logger.js';

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const CHANNEL_ID  = process.env.TELEGRAM_CHANNEL_ID || '';
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
