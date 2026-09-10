/**
 * facebookUpload.js — posts a video directly to Xpress Vet's Facebook Page
 * feed ("DOGS and knowing," repurposed — see [[xpress-vet-listing-video-pipeline]]
 * memory for why that Page specifically).
 *
 * IMPORTANT real gap found 2026-09-10: the System User token
 * (`INSTAGRAM_ACCESS_TOKEN`) that works fine for Instagram and regular Page
 * text/photo posts is NOT enough for the Page *video* endpoint — even with
 * `pages_manage_posts` confirmed granted, POSTing to /{page-id}/videos with
 * it returns `(#100) No permission to publish the video`. Video publishing
 * needs a genuine Page Access Token (a distinct token type, historically
 * tied to a `publish_video` scope). Rather than store a second long-lived
 * secret in .env, we derive it fresh on every call from the System User
 * token via the standard Graph API exchange
 * (`GET /{page-id}?fields=access_token`) — cheap, no extra secret to
 * rotate, and confirmed working live (first real post:
 * https://graph.facebook.com/v21.0/2089418308382756 → permalink
 * /reel/2089418308382756/, 2026-09-10T15:35:55Z).
 *
 * Simpler than Instagram once you have the right token: a single POST to
 * /{page-id}/videos with a `file_url` pointing at the already-hosted
 * Cloudinary video — no container/poll/publish dance, Facebook handles the
 * fetch+process synchronously (or returns quickly with a video id you can
 * poll if it takes longer, though in practice sub-90s clips finish fast).
 */
import fetch from 'node-fetch';

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export function isFacebookConfigured() {
  return Boolean(process.env.FACEBOOK_PAGE_ID && process.env.INSTAGRAM_ACCESS_TOKEN);
}

// Derives a real Page Access Token from the System User token. Not cached —
// this runs at most a few times/day (worker BATCH_SIZE=2, a handful of
// sweeps/day) so the extra round-trip is negligible, and staying
// stateless avoids ever serving a stale token after a permissions change.
async function getPageAccessToken(pageId) {
  const url = new URL(`${GRAPH_BASE}/${pageId}`);
  url.searchParams.set('fields', 'access_token');
  url.searchParams.set('access_token', process.env.INSTAGRAM_ACCESS_TOKEN);

  const res = await fetch(url.toString());
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(`Failed to derive Page Access Token: ${data.error?.message || `HTTP ${res.status}`}`);
  }
  return data.access_token;
}

/**
 * Posts a video to the Page's feed. Returns { videoId, url }. Throws on
 * failure — caller decides how to record that (best-effort alongside
 * Instagram, never blocks it).
 */
export async function postVideoToFacebookPage(videoUrl, description) {
  if (!isFacebookConfigured()) throw new Error('Facebook not configured (FACEBOOK_PAGE_ID/INSTAGRAM_ACCESS_TOKEN missing).');

  const pageId = process.env.FACEBOOK_PAGE_ID;
  const pageAccessToken = await getPageAccessToken(pageId);

  const url = new URL(`${GRAPH_BASE}/${pageId}/videos`);
  url.searchParams.set('access_token', pageAccessToken);
  url.searchParams.set('file_url', videoUrl);
  url.searchParams.set('description', description);

  const res = await fetch(url.toString(), { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(`Facebook Graph API error: ${data.error?.message || `HTTP ${res.status}`}`);
  }

  const videoId = data.id;
  return { videoId, url: `https://www.facebook.com/${pageId}/videos/${videoId}` };
}
