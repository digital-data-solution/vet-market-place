/**
 * scheduleVetTipReels.mjs — uploads the rendered vet-tip Reels
 * (VETFRESH/instagram-videos/out) to Cloudinary and (re)writes their
 * ScheduledReel rows, following the growth-plan calendar: Mon/Wed/Fri,
 * posted by the 18:30 UTC scheduled-reels-worker.yml run.
 *
 *   node scripts/scheduleVetTipReels.mjs            → upload + schedule all
 *   node scripts/scheduleVetTipReels.mjs 01-...     → just these (e.g. after a re-voice)
 *
 * Re-running is safe: the Cloudinary public_id is fixed per video (a re-render
 * overwrites in place) and rows already posted are never touched.
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: connectDB } = await import('../src/config/db.js');
const { default: ScheduledReel } = await import('../src/models/ScheduledReel.js');
const { uploadVideoToCloudinary } = await import('../src/lib/cloudinaryUpload.js');

const OUT = process.env.REELS_OUT || path.join(__dirname, '..', '..', '..', 'instagram-videos', 'out');

// Calendar from Xpress-Vet-Instagram-Growth-Plan.docx (weeks 1–4). The date is
// the day it goes out; the 18:30 UTC run picks it up. Script 12 (prices) isn't made.
const CALENDAR = [
  ['01-mange-ringworm', '2026-10-05'],
  ['07-paracetamol-myth', '2026-10-07'],
  ['06-newcastle', '2026-10-09'],
  ['02-bloat', '2026-10-12'],
  ['04-parvo-one-injection', '2026-10-14'],
  ['10-heat-stress', '2026-10-16'],
  ['03-cat-flu', '2026-10-19'],
  ['08-palm-oil-myth', '2026-10-21'],
  ['11-five-emergency-signs', '2026-10-23'],
  ['05-dog-bite', '2026-10-26'],
  ['09-ticks-indoors', '2026-10-28'],
];

const AI_NOTE = '🎙️ Narrated with an AI voice.';

function captions(key) {
  const base = fs.readFileSync(path.join(OUT, `${key}.txt`), 'utf8').trim();
  const withNote = (text) => text.replace(/\n\nCredits: /, `\n\n${AI_NOTE}\n\nCredits: `);
  return {
    captionInstagram: withNote(base),
    // Facebook makes links clickable, so it gets the real link instead of "link in bio".
    captionFacebook: withNote(base.replace('Full guide: link in bio 👆', 'Full guide: https://go.xpressvetmarketplace.com/Blog?src=fb')),
  };
}

await connectDB();
const only = new Set(process.argv.slice(2));
for (const [key, day] of CALENDAR) {
  if (only.size && !only.has(key)) continue;
  const existing = await ScheduledReel.findOne({ key });
  if (existing && existing.instagramStatus === 'posted') {
    console.log(`${key}: already posted — left alone`);
    continue;
  }
  const { url } = await uploadVideoToCloudinary(path.join(OUT, `${key}.mp4`), { folder: 'vet-tip-reels', publicId: key });
  const postAt = new Date(`${day}T18:00:00Z`);
  await ScheduledReel.findOneAndUpdate(
    { key },
    { $set: { videoUrl: url, postAt, ...captions(key), instagramStatus: 'pending', instagramError: null } },
    { upsert: true },
  );
  console.log(`${key}: scheduled ${day} 19:30 WAT  ${url}`);
}
process.exit(0);
