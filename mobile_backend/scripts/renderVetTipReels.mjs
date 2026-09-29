/**
 * renderVetTipReels.mjs — renders the VetTipReel Remotion composition for
 * every video prepared by VETFRESH/instagram-videos/prepare.py.
 *
 *   node scripts/renderVetTipReels.mjs [video-id ...]
 *
 * Reads  <REELS_DIR>/spec.json and <REELS_DIR>/work/<id>/props.json
 * Writes <REELS_DIR>/out/<id>.mp4 plus <id>.txt (ready-to-paste caption with
 * the credits CC BY footage/music require).
 */
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, '..');
const REELS_DIR = process.env.REELS_DIR || path.join(BACKEND, '..', '..', 'instagram-videos');
const WORK = path.join(REELS_DIR, 'work');
const OUT = path.join(REELS_DIR, 'out');
const ASSETS = path.join(BACKEND, 'src', 'assets', 'listingVideo');

// Instrumental (Jamendo's vocalinstrumental filter) and CC BY 3.0, not share-alike —
// vocals would fight the narration. Alternated per video for variety.
const MUSIC = [
  { file: 'energy.mp3', credit: 'Music: "Energy" by Pokki DJ, CC BY 3.0 (Jamendo)' },
  { file: 'born-free.mp3', credit: 'Music: "Born Free" by Pokki DJ, CC BY 3.0 (Jamendo)' },
];

const probeSeconds = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

function captionText(video, props, music) {
  const segs = video.segments;
  const credits = [...new Set(props.segments.map((s) => s.credit).filter(Boolean)), music.credit];
  return [
    segs[0].text,
    '',
    'Full guide: link in bio 👆',
    '',
    segs[segs.length - 1].text.replace(/Tell us in the comments\.?$/, 'Tell us in the comments 👇'),
    '',
    video.tags,
    '',
    'Credits: ' + credits.join(' · '),
  ].join('\n');
}

async function main() {
  const spec = JSON.parse(fs.readFileSync(path.join(REELS_DIR, 'spec.json'), 'utf8'));
  const only = new Set(process.argv.slice(2));
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(WORK, '_brand'), { recursive: true });
  fs.copyFileSync(path.join(ASSETS, 'logo.png'), path.join(WORK, '_brand', 'logo.png'));
  for (const m of MUSIC) fs.copyFileSync(path.join(ASSETS, 'music', m.file), path.join(WORK, '_brand', m.file));

  const serveUrl = await bundle({ entryPoint: path.join(BACKEND, 'src', 'remotion', 'entry.jsx'), publicDir: WORK });

  for (const [index, video] of spec.videos.entries()) {
    const music = MUSIC[index % MUSIC.length];
    if (only.size && !only.has(video.id)) continue;
    const propsPath = path.join(WORK, video.id, 'props.json');
    if (!fs.existsSync(propsPath)) { console.log(`skip ${video.id} (not prepared)`); continue; }
    const props = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
    for (const seg of props.segments) {
      if (seg.mediaKind === 'video') seg.mediaDuration = probeSeconds(path.join(WORK, seg.media));
    }
    const inputProps = { title: props.title, segments: props.segments, music: `_brand/${music.file}` };
    const composition = await selectComposition({ serveUrl, id: 'VetTipReel', inputProps });
    const raw = path.join(OUT, `${video.id}.raw.mp4`);
    const final = path.join(OUT, `${video.id}.mp4`);
    const t = Date.now();
    // Low concurrency + capped frame cache: at concurrency 4 the headless browser
    // crashed on this 8 GB laptop (2026-09-28).
    await renderMedia({
      composition, serveUrl, codec: 'h264', outputLocation: raw, inputProps,
      concurrency: Number(process.env.RENDER_CONCURRENCY || 1),
      offthreadVideoCacheSizeInBytes: 256 * 1024 * 1024,
    });
    // Same Instagram-proven output flags as renderFeatureComparison.js, plus: Remotion's
    // frames are full-range (came out yuvj420p) so convert to TV range, and loudness-
    // normalise — the raw mix measured -24.6 LUFS, far quieter than Reels' ~-14.
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw,
      '-vf', 'scale=in_range=full:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-crf', '20',
      '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart', final]);
    fs.rmSync(raw);
    fs.writeFileSync(path.join(OUT, `${video.id}.txt`), captionText(video, props, music));
    console.log(`${video.id}: ${probeSeconds(final).toFixed(1)}s rendered in ${((Date.now() - t) / 1000).toFixed(0)}s`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
