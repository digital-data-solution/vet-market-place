/**
 * One-time bulk download of royalty-free tracks from Jamendo's API into
 * src/assets/listingVideo/music/ — run this once, not from any live server
 * code (the listing-video pipeline never calls an external API at render
 * time, only reads whatever's already on disk in that folder).
 *
 * Setup: add JAMENDO_CLIENT_ID=<your client id> to mobile_backend/.env
 * (get one free at https://devportal.jamendo.com/ — sign up, create an
 * "app", it gives you the client_id). This is a LOCAL-only .env value —
 * the deployed server never needs it, so it does not need to go in Render.
 *
 * Run: node scripts/download-jamendo-tracks.mjs
 *
 * Jamendo tracks are all Creative Commons, but the specific CC variant
 * differs per track — this script prints each track's license URL and
 * only downloads ones the API itself flags as downloadable
 * (audiodownload_allowed), but does NOT verify the license permits your
 * specific commercial use. Check the printed license_ccurl for each
 * downloaded file yourself before shipping it in a real marketing video.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');
const MUSIC_DIR = path.join(BACKEND_DIR, 'src/assets/listingVideo/music');

const env = readFileSync(path.join(BACKEND_DIR, '.env'), 'utf8');
const m = env.match(/^JAMENDO_CLIENT_ID=(.*)$/m);
if (!m || !m[1].trim()) {
  console.error('JAMENDO_CLIENT_ID not found in mobile_backend/.env — see this script\'s header comment for setup.');
  process.exit(1);
}
const clientId = m[1].trim();

const LIMIT = 10; // fetch a few extra since not all tracks allow download
const params = new URLSearchParams({
  client_id: clientId,
  format: 'json',
  limit: String(LIMIT),
  include: 'musicinfo',
  audioformat: 'mp32',
  order: 'popularity_total',
  ccnc: 'false', // exclude NonCommercial-restricted tracks — confirmed this actually filters correctly (tested against the raw API before trusting it)
  ccnd: 'false', // exclude NoDerivatives-restricted tracks
});

const url = `https://api.jamendo.com/v3.0/tracks/?${params.toString()}`;
console.log('Querying Jamendo:', url.replace(clientId, '***'));

const res = await fetch(url);
if (!res.ok) {
  console.error('Jamendo API request failed:', res.status, await res.text());
  process.exit(1);
}
const data = await res.json();
const tracks = data.results || [];

if (!tracks.length) {
  console.log('No tracks returned — try adjusting the `tags` param in this script.');
  process.exit(0);
}

mkdirSync(MUSIC_DIR, { recursive: true });

let downloaded = 0;
for (const track of tracks) {
  console.log(`\n"${track.name}" by ${track.artist_name}`);
  console.log('  check license here:', track.license_ccurl || track.shareurl);
  console.log('  downloadable:', track.audiodownload_allowed);

  if (!track.audiodownload_allowed || !track.audiodownload) {
    console.log('  -> skipped (not downloadable via API)');
    continue;
  }
  const safeName = track.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
  const outPath = path.join(MUSIC_DIR, `${safeName}.mp3`);
  if (existsSync(outPath)) {
    console.log('  -> skipped (already downloaded)');
    continue;
  }
  if (downloaded >= 5) {
    console.log('  -> skipped (already have 5 new ones this run)');
    continue;
  }

  const audioRes = await fetch(track.audiodownload);
  if (!audioRes.ok) {
    console.log('  -> download failed:', audioRes.status);
    continue;
  }
  const buf = Buffer.from(await audioRes.arrayBuffer());
  writeFileSync(outPath, buf);
  downloaded++;
  console.log('  -> saved:', outPath);
}

console.log(`\nDone — ${downloaded} track(s) saved to ${MUSIC_DIR}`);
console.log('Double-check each license_ccurl above actually permits your intended commercial use before shipping.');
