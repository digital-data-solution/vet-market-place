/**
 * youtubeUpload.js — thin wrapper around the YouTube Data API v3 for
 * uploading a video file to Xpress Vet's own YouTube channel.
 *
 * Auth: OAuth2 with a long-lived refresh token, NOT a service account —
 * YouTube channel uploads can only be authorized by a real Google account
 * that owns/manages the channel (service accounts have no channel of their
 * own). The refresh token is generated ONCE, by hand, by whoever owns the
 * channel — see scripts/youtube-authorize.mjs's docstring for that
 * one-time setup. This file only ever consumes an existing refresh token;
 * it never performs the interactive login itself.
 *
 * Env vars required (Render + GitHub Actions secrets — never in a
 * committed .env):
 *   YOUTUBE_CLIENT_ID
 *   YOUTUBE_CLIENT_SECRET
 *   YOUTUBE_REFRESH_TOKEN
 *
 * Quota: as of the June 2026 YouTube API change, videos.insert has its own
 * dedicated bucket — 1 unit per call, 100 calls/day by default — separate
 * from the general 10,000-unit daily quota (confirmed via a live search
 * before building this, not assumed from older docs that still say 1,600
 * units). jobs/youtubeUploadWorker.js still paces uploads well under that
 * (see its BATCH_SIZE comment) — partly quota headroom, partly because
 * dumping dozens of videos on a channel in one day looks spammy and hurts
 * organic reach more than it helps.
 */
import { google } from 'googleapis';
import fs from 'fs';

function getOAuthClient() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null; // not set up yet — caller no-ops

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

/**
 * Returns true only if all 3 YouTube env vars are present — lets callers
 * skip cleanly (no wasted download) rather than fail mid-upload.
 */
export function isYoutubeConfigured() {
  return Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN);
}

/**
 * Uploads a local video file as a YouTube Short (public, category "Pets &
 * Animals"). Returns { videoId, url }. Throws on failure — caller decides
 * how to record that (see youtubeUploadWorker.js).
 *
 * `#Shorts` in the title is what gets a vertical/short video correctly
 * routed into the Shorts shelf rather than treated as a regular upload.
 */
/**
 * `publishAt` (optional): an ISO-8601 timestamp in the future. When given,
 * the video uploads as private and YouTube itself flips it to public at
 * that exact moment — no separate "go live now" call or polling needed on
 * our side, YouTube's own servers do it. Omit it (as one-off/manual calls
 * typically will) to publish immediately, same as before.
 */
export async function uploadVideoToYouTube(filePath, { title, description, tags = [], publishAt = null }) {
  const auth = getOAuthClient();
  if (!auth) throw new Error('YouTube not configured (YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN missing).');

  const youtube = google.youtube({ version: 'v3', auth });

  const status = publishAt
    ? { privacyStatus: 'private', publishAt, selfDeclaredMadeForKids: false } // YouTube requires 'private' whenever publishAt is set
    : { privacyStatus: 'public', selfDeclaredMadeForKids: false };

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        // YouTube's title cap is 100 chars total — reserve room for the
        // ' #Shorts' suffix (8 chars) so the combined string never exceeds
        // it. Real bug hit 2026-09-10: title.slice(0, 95) + ' #Shorts' can
        // total 103 chars whenever the source title is >=95 chars, which
        // YouTube rejects outright ("invalid or empty video title" — a
        // confusing error for what's actually a length violation). Every
        // title uploaded before that day happened to be under 95 chars
        // pre-slice, so this never surfaced until a longer combined
        // course+lesson title did.
        title: title.slice(0, 100 - ' #Shorts'.length) + ' #Shorts',
        description,
        tags,
        categoryId: '15', // Pets & Animals
      },
      status,
    },
    media: {
      body: fs.createReadStream(filePath),
    },
  });

  const videoId = res.data.id;
  return { videoId, url: `https://youtube.com/shorts/${videoId}` };
}
