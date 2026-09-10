/**
 * instagramUpload.js — thin wrapper around Meta's Instagram Graph API for
 * posting a Reel to Xpress Vet's own Instagram Business account
 * (@xpressvet).
 *
 * Unlike YouTube (direct file upload), Instagram's API works off a
 * container model against a PUBLICLY REACHABLE video URL — perfect fit
 * here since every video is already hosted on Cloudinary before this ever
 * runs:
 *   1. POST /{ig-user-id}/media  { video_url, caption, media_type:'REELS' }
 *      -> { id: containerId }  (Instagram starts downloading+processing
 *      the video from that URL in the background)
 *   2. Poll GET /{containerId}?fields=status_code until FINISHED (or ERROR)
 *   3. POST /{ig-user-id}/media_publish  { creation_id: containerId }
 *      -> { id: mediaId }  (now actually live on the account)
 *
 * Auth: a long-lived Instagram User Access Token (NOT a short-lived one —
 * those expire in ~1 hour). Long-lived tokens last ~60 days and must be
 * refreshed before they expire — a real operational difference from
 * YouTube's refresh_token, which doesn't expire. Renewal is a lightweight
 * call (scripts/instagram-refresh-token.mjs), not a full re-login. There's
 * no automatic secret-rotation wired up here (would need a GitHub PAT +
 * Render API key with write access to secrets, more infra than this is
 * worth right now) — instead, checkTokenAge() below lets the worker log a
 * loud warning well before expiry so it gets noticed and renewed by hand,
 * rather than silently breaking one day.
 *
 * Env vars required (Render + GitHub Actions secrets):
 *   INSTAGRAM_ACCOUNT_ID     — the numeric Instagram professional account id
 *   INSTAGRAM_ACCESS_TOKEN   — long-lived token, generated via the one-time
 *                              setup (see scripts/instagram-authorize.mjs)
 *   INSTAGRAM_TOKEN_ISSUED_AT — ISO date the current token was issued/last
 *                              refreshed, so checkTokenAge() can warn
 */
import fetch from 'node-fetch';

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TOKEN_LIFETIME_DAYS = 60; // Meta's stated long-lived-token lifetime
const WARN_WITHIN_DAYS = 10;    // start warning this many days before expiry

export function isInstagramConfigured() {
  return Boolean(process.env.INSTAGRAM_ACCOUNT_ID && process.env.INSTAGRAM_ACCESS_TOKEN);
}

/**
 * Returns a warning string if the token is within WARN_WITHIN_DAYS of its
 * ~60-day expiry (or if INSTAGRAM_TOKEN_ISSUED_AT is missing/unparseable,
 * since that means we can't prove it's still fresh), else null.
 */
export function checkTokenAge() {
  const issuedAtRaw = process.env.INSTAGRAM_TOKEN_ISSUED_AT;
  if (!issuedAtRaw) return 'INSTAGRAM_TOKEN_ISSUED_AT is not set — cannot confirm the access token is still fresh. Add it (ISO date) alongside INSTAGRAM_ACCESS_TOKEN so this check can work.';

  const issuedAt = new Date(issuedAtRaw);
  if (Number.isNaN(issuedAt.getTime())) return `INSTAGRAM_TOKEN_ISSUED_AT ("${issuedAtRaw}") isn't a parseable date.`;

  const ageDays = (Date.now() - issuedAt.getTime()) / (1000 * 60 * 60 * 24);
  const daysLeft = TOKEN_LIFETIME_DAYS - ageDays;
  if (daysLeft <= 0) return `Instagram access token is past its ~${TOKEN_LIFETIME_DAYS}-day expected lifetime (issued ${issuedAtRaw}) — posting is likely already failing. Run scripts/instagram-authorize.mjs (via the App Dashboard's "Generate token" button) and update INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_TOKEN_ISSUED_AT.`;
  if (daysLeft <= WARN_WITHIN_DAYS) return `Instagram access token expires in ~${Math.round(daysLeft)} day(s) (issued ${issuedAtRaw}). Run scripts/instagram-refresh-token.mjs to renew it.`;
  return null;
}

async function graphRequest(path, { method = 'GET', params = {} } = {}) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  url.searchParams.set('access_token', process.env.INSTAGRAM_ACCESS_TOKEN);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), { method });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    throw new Error(`Instagram Graph API error (${path}): ${msg}`);
  }
  return data;
}

async function createContainer(videoUrl, caption) {
  const igUserId = process.env.INSTAGRAM_ACCOUNT_ID;
  const data = await graphRequest(`/${igUserId}/media`, {
    method: 'POST',
    params: { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: true },
  });
  return data.id;
}

/**
 * Polls container status until FINISHED, ERROR, or a max wait is hit.
 * Instagram processes the video asynchronously (downloading from
 * video_url, transcoding) — this typically takes well under a minute for
 * a ~25s Short-length clip, but can occasionally take longer.
 */
async function waitForContainerReady(containerId, { maxWaitMs = 5 * 60 * 1000, pollIntervalMs = 5000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const data = await graphRequest(`/${containerId}`, { params: { fields: 'status_code' } });
    if (data.status_code === 'FINISHED') return;
    if (data.status_code === 'ERROR') throw new Error(`Instagram container ${containerId} failed processing (status_code: ERROR).`);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Instagram container ${containerId} didn't finish processing within ${maxWaitMs / 1000}s.`);
}

async function publishContainer(containerId) {
  const igUserId = process.env.INSTAGRAM_ACCOUNT_ID;
  const data = await graphRequest(`/${igUserId}/media_publish`, {
    method: 'POST',
    params: { creation_id: containerId },
  });
  return data.id;
}

/**
 * Posts a Reel from an already-public video URL (a Cloudinary URL, in
 * practice). Returns { mediaId, url }. Throws on failure — caller decides
 * how to record that.
 */
export async function postReelToInstagram(videoUrl, caption) {
  if (!isInstagramConfigured()) throw new Error('Instagram not configured (INSTAGRAM_ACCOUNT_ID/ACCESS_TOKEN missing).');

  const containerId = await createContainer(videoUrl, caption);
  await waitForContainerReady(containerId);
  const mediaId = await publishContainer(containerId);

  // Graph API doesn't hand back a permalink directly from media_publish —
  // fetch it in one extra call rather than guess at a URL shape.
  let url = null;
  try {
    const data = await graphRequest(`/${mediaId}`, { params: { fields: 'permalink' } });
    url = data.permalink || null;
  } catch {
    // Non-fatal — the post succeeded even if we couldn't fetch its permalink.
  }

  return { mediaId, url };
}
