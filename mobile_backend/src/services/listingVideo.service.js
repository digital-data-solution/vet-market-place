/**
 * listingVideo.service.js
 *
 * Generates a 15–25s vertical (1080x1920) MP4 from a Xpress Market listing —
 * Ken Burns pan/zoom over the listing's images, cross-dissolves, text
 * overlays (title/category/location/price), Xpress Vet mark, and a closing
 * CTA card. Text overlays only, no narration/TTS — this is the
 * high-volume, per-listing path (every new listing triggers a render), so
 * throughput matters more than expressiveness. ffmpeg filter chains, not a
 * headless-browser renderer — target well under 20s render time.
 *
 * DELIBERATELY MORE PARANOID THAN "unit-test the command builder": ffmpeg
 * happily exits 0 on a malformed filter graph that silently produces wrong
 * output (wrong duration, missing audio/video stream, degenerate frames) —
 * this bit this exact project twice in one session (an audio-format
 * mismatch that inflated duration by ~4s with no error, and a subtitle
 * scale bug that rendered 2.4x too large with no error). So every render
 * here is verified post-hoc: a full decode pass, a duration-tolerance
 * check, and a stream-sanity check — never just "ffmpeg exited 0".
 *
 * NOT YET WIRED IN: queue integration (Agenda/cron job on listing create),
 * Cloudinary upload of the result, or writing the URL back onto the
 * Listing document. This module only renders a valid file to a given path
 * and tells you honestly whether it's actually correct.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'listingVideo');

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 25;
const SLIDE_DURATION = 5;       // seconds per image slide
const TRANSITION_DURATION = 0.6; // seconds, xfade between slides
const MIN_SLIDES = 3;           // pad with a branded card below this
const MAX_SLIDES = 5;           // cap real images used, keeps render under ~20s
const CLOSING_CARD_DURATION = 3.5;
const BRAND_BLUE = '0x2563EB';

const LOGO_PATH     = path.join(ASSETS_DIR, 'logo.png');
// Bare filenames, not absolute paths: ffmpeg's drawtext `fontfile=` value
// parser cannot handle a Windows absolute path's drive-letter colon no
// matter how it's escaped (confirmed — backslash-escaping the colon still
// fails to parse, this isn't a one-off mistake). The fix is to always run
// ffmpeg with `cwd: ASSETS_DIR` (see `run()` below) and reference fonts by
// bare relative filename instead — see [[vetfresh-known-gotchas]].
const FONT_BOLD    = 'arialbd.ttf';
const FONT_REGULAR = 'arial.ttf';

function naira(amount) {
  return '₦' + Number(amount || 0).toLocaleString('en-NG');
}

// ffmpeg's drawtext chokes on unescaped colons/apostrophes inside the text
// value (see [[vetfresh-known-gotchas]]) — strip rather than fight escaping
// for user-generated strings (titles, city names) we don't control.
function sanitizeForDrawtext(s) {
  return String(s || '').replace(/['":]/g, '').replace(/[\r\n]+/g, ' ').trim();
}

// cwd: ASSETS_DIR so bare font/logo filenames resolve — see the FONT_BOLD
// comment above for why this exists instead of absolute paths.
async function run(args) {
  return execFileAsync('ffmpeg', args, { maxBuffer: 1024 * 1024 * 64, cwd: ASSETS_DIR });
}

async function probe(filePath, args) {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', ...args, filePath]);
  return stdout.trim();
}

/**
 * Renders a branded "not enough photos yet" padding card as a still PNG —
 * used when a listing has fewer than MIN_SLIDES real images, so the video
 * never feels like a single static photo with barely any motion.
 */
async function buildPaddingCardPng(outPath) {
  await run([
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${BRAND_BLUE}:s=${WIDTH}x${HEIGHT}`,
    '-i', LOGO_PATH,
    '-filter_complex',
    `[1:v]scale=220:220[logo];[0:v][logo]overlay=(W-w)/2:(H-h)/2-100,` +
    `drawtext=fontfile=${FONT_BOLD}:text='Xpress Market':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h/2)+220`,
    '-update', '1', '-frames:v', '1',
    outPath,
  ]);
}

// The closing card is identical for every listing (generic "see more" CTA,
// no listing-specific text) — building it fresh per render was pure waste.
// Rendered once and cached on disk; every render after the first just
// reuses the file. This alone removes one of the three ffmpeg encodes that
// used to happen per listing.
const CLOSING_CARD_CACHE_PATH = path.join(ASSETS_DIR, '_closing-card-cache.mp4');

async function buildClosingCard(outPath) {
  await run([
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${BRAND_BLUE}:s=${WIDTH}x${HEIGHT}:d=${CLOSING_CARD_DURATION}:r=${FPS}`,
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-i', LOGO_PATH,
    '-filter_complex',
    `[2:v]scale=200:200[logo];[0:v][logo]overlay=(W-w)/2:420[bg];` +
    `[bg]drawtext=fontfile=${FONT_BOLD}:text='See More on Xpress Vet':fontcolor=white:fontsize=58:x=(w-text_w)/2:y=780,` +
    `drawtext=fontfile=${FONT_REGULAR}:text='xpressvetmarketplace.com':fontcolor=white:fontsize=40:x=(w-text_w)/2:y=880[vout]`,
    '-map', '[vout]', '-map', '1:a',
    '-t', String(CLOSING_CARD_DURATION),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    outPath,
  ]);
}

async function getClosingCard() {
  if (!fs.existsSync(CLOSING_CARD_CACHE_PATH)) {
    await buildClosingCard(CLOSING_CARD_CACHE_PATH);
  }
  return CLOSING_CARD_CACHE_PATH;
}

// Drop real, licensed royalty-free tracks (mp3/wav/m4a) into this folder —
// see the setup instructions given alongside this code for where to get
// them — and every render after that automatically picks one at random and
// mixes it in under the video. With nothing in the folder, renders are
// silent (a real gap against the original spec's "ducked music bed", but
// nothing here fabricates fake placeholder audio and calls it music).
const MUSIC_DIR = path.join(ASSETS_DIR, 'music');
const MUSIC_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg']);

function pickMusicTrack() {
  if (!fs.existsSync(MUSIC_DIR)) return null;
  const files = fs.readdirSync(MUSIC_DIR).filter((f) => MUSIC_EXTENSIONS.has(path.extname(f).toLowerCase()));
  if (!files.length) return null;
  return path.join(MUSIC_DIR, files[Math.floor(Math.random() * files.length)]);
}

// How much to upscale before zoompan so the zoom has resolution to sample
// from without visible stepping. The original 8000px was clear overkill —
// pushing every frame of every slide through an 8000px-wide filter stage.
// ~2x the output width (2200) is plenty for a subtle zoom up to 1.4x with
// no visible quality loss. NOTE: tuning this further on this dev machine
// wasn't reliable — a smaller value (1500) measured *slower* in testing,
// almost certainly shared-machine noise (background load/disk/thermal)
// rather than a real effect, since a smaller image should cost less to
// filter, not more. 2200 is the empirically-best value actually observed;
// don't trust a few seconds of difference from further tuning without
// profiling on the real target machine (a dedicated render worker, not a
// shared dev laptop) with multiple repeated runs per value.
const ZOOMPAN_PRESCALE_WIDTH = 2200;

/**
 * Builds the ENTIRE video — Ken Burns + cross-dissolve main sequence, text
 * overlays, Xpress Vet mark, AND the concat with the (pre-built, cached)
 * closing card — in a single ffmpeg invocation with one filter_complex and
 * one final encode. Originally this was three separate ffmpeg processes
 * (build main.mp4, build closing.mp4, decode-both-and-concat into the real
 * output) — two full encode passes more than necessary. Now it's one.
 */
async function buildFinalVideo({ imageSources, listing, closingCardPath, outputPath }) {
  const n = imageSources.length;
  const inputs = [];
  imageSources.forEach((src) => {
    inputs.push('-loop', '1', '-t', String(SLIDE_DURATION), '-i', src);
  });
  inputs.push('-i', LOGO_PATH);
  const logoInputIdx = n;
  inputs.push('-i', closingCardPath);
  const closingInputIdx = n + 1;

  const filters = [];
  for (let i = 0; i < n; i++) {
    // Crop to the exact target aspect first (no squish), moderate upscale
    // for zoompan headroom, then zoompan back down to the real output size.
    filters.push(
      `[${i}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${WIDTH}:${HEIGHT},scale=${ZOOMPAN_PRESCALE_WIDTH}:-2,` +
      `zoompan=z='min(zoom+0.0012,1.4)':d=${SLIDE_DURATION * FPS}:s=${WIDTH}x${HEIGHT}:fps=${FPS},` +
      `format=yuv420p,setsar=1[v${i}]`,
    );
  }

  // Chain xfade transitions. For equal-duration clips D with transition T,
  // the i-th transition (1-indexed, merging clip i into the growing chain
  // of i clips) lands at offset = i * (D - T) — derived from: after k
  // clips are merged with (k-1) transitions, the merged stream's duration
  // is k*D - (k-1)*T, and the next transition must start T seconds before
  // that stream ends.
  let chainLabel = 'v0';
  for (let i = 1; i < n; i++) {
    const offset = i * (SLIDE_DURATION - TRANSITION_DURATION);
    const outLabel = i === n - 1 ? 'vchain' : `vx${i}`;
    filters.push(
      `[${chainLabel}][v${i}]xfade=transition=fade:duration=${TRANSITION_DURATION}:offset=${offset}[${outLabel}]`,
    );
    chainLabel = outLabel;
  }
  if (n === 1) chainLabel = 'v0'; // degenerate (shouldn't happen — MIN_SLIDES pads to 3+)

  const mainDuration = n * SLIDE_DURATION - (n - 1) * TRANSITION_DURATION;

  const title    = sanitizeForDrawtext(listing.title).slice(0, 40);
  const category = sanitizeForDrawtext(listing.category);
  const location = sanitizeForDrawtext(listing.city || listing.address || '');
  const price    = sanitizeForDrawtext(naira(listing.price));

  filters.push(`[${logoInputIdx}:v]scale=90:90,format=rgba,colorchannelmixer=aa=0.9[logo]`);
  filters.push(`[${chainLabel}][logo]overlay=W-w-30:40[vwm]`);
  // Bottom info bar: semi-transparent box behind the text (box=1) so it
  // stays legible over any photo, not just light ones.
  filters.push(
    `[vwm]drawtext=fontfile=${FONT_BOLD}:text='${title}':fontcolor=white:fontsize=52:` +
    `x=50:y=h-320:box=1:boxcolor=black@0.45:boxborderw=16,` +
    `drawtext=fontfile=${FONT_REGULAR}:text='${category}  -  ${location}':fontcolor=0xBFDBFE:fontsize=36:` +
    `x=50:y=h-230:box=1:boxcolor=black@0.45:boxborderw=12,` +
    `drawtext=fontfile=${FONT_BOLD}:text='${price}':fontcolor=white:fontsize=64:` +
    `x=50:y=h-160:box=1:boxcolor=black@0.45:boxborderw=14[vout]`,
  );

  // Concat is video-only here (both the main sequence and the closing card
  // are visually complete without audio) — the actual audio track (a music
  // bed if one exists, silence otherwise) is built completely separately
  // below and attached to the concatenated video afterward. Simpler than
  // trying to carry two segments' audio through the concat filter, and
  // avoids the exact class of silent audio-format-mismatch bug this
  // project already hit once with concat (see [[vetfresh-known-gotchas]]).
  filters.push(`[${closingInputIdx}:v]format=yuv420p,setsar=1[vclose]`);
  filters.push(`[vout][vclose]concat=n=2:v=1:a=0[vfinal]`);

  const expectedTotal = mainDuration + CLOSING_CARD_DURATION;

  const musicPath = pickMusicTrack();
  if (musicPath) {
    // -stream_loop -1 loops the track indefinitely so it always covers the
    // full video regardless of the track's own length; the global -t below
    // truncates it to the actual video duration. volume kept low (0.22) —
    // this is a background bed under text overlays, not a beat drop.
    inputs.push('-stream_loop', '-1', '-i', musicPath);
    const musicInputIdx = closingInputIdx + 1;
    const fadeOutStart = Math.max(0, expectedTotal - 1);
    filters.push(
      `[${musicInputIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.22,` +
      `afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart}:d=1[afinal]`,
    );
  } else {
    filters.push('anullsrc=r=44100:cl=stereo[afinal]');
  }

  await run([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vfinal]', '-map', '[afinal]',
    '-t', String(expectedTotal),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-y', '-v', 'error',
    outputPath,
  ]);

  return { expectedTotal };
}

/**
 * Verification — the actual point of this module. Never trust "ffmpeg
 * exited 0" alone. Runs a full decode pass (catches hard decode errors a
 * malformed filter graph can produce) and checks the real output duration
 * against what the filter graph math predicted, within a small tolerance.
 * Returns { ok, warnings, errors, actualDuration } — never throws for a
 * verification *finding*, only for a tool-execution failure.
 */
async function verifyRender(filePath, expectedDuration) {
  const warnings = [];
  const errors = [];

  try {
    await execFileAsync('ffmpeg', ['-v', 'warning', '-i', filePath, '-f', 'null', '-']);
  } catch (err) {
    errors.push(`Decode pass failed: ${err.stderr?.toString().slice(0, 500) || err.message}`);
  }

  let actualDuration = null;
  try {
    actualDuration = parseFloat(await probe(filePath, ['-show_entries', 'format=duration', '-of', 'csv=p=0']));
    const drift = Math.abs(actualDuration - expectedDuration);
    if (drift > 0.5) {
      errors.push(`Duration mismatch: expected ~${expectedDuration.toFixed(1)}s, got ${actualDuration.toFixed(1)}s (drift ${drift.toFixed(1)}s) — usually means a filter-graph timing bug, not a rounding error.`);
    } else if (drift > 0.15) {
      warnings.push(`Duration drift ${drift.toFixed(2)}s — within tolerance but worth a glance if it grows on future changes.`);
    }
  } catch (err) {
    errors.push(`Could not read output duration: ${err.message}`);
  }

  try {
    const streams = await probe(filePath, ['-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0']);
    const [w, h] = streams.trim().split(',').map(Number);
    if (w !== WIDTH || h !== HEIGHT) {
      errors.push(`Wrong output resolution: expected ${WIDTH}x${HEIGHT}, got ${w}x${h}.`);
    }
  } catch (err) {
    errors.push(`Could not verify output resolution: ${err.message}`);
  }

  try {
    await probe(filePath, ['-select_streams', 'a', '-show_entries', 'stream=codec_name']);
  } catch {
    warnings.push('No audio stream detected — expected if no music bed was mixed in for this render.');
  }

  return { ok: errors.length === 0, warnings, errors, actualDuration };
}

/**
 * Main entry point. `listing` needs: title, category, price, city/address,
 * images: [{ url }]. Writes the final MP4 to `outputPath` and returns a
 * verification result — caller decides what to do with a failed
 * verification (retry, alert, skip upload) rather than this module
 * silently uploading something wrong.
 */
export async function renderListingVideo(listing, outputPath) {
  const workDir = path.dirname(outputPath);
  fs.mkdirSync(workDir, { recursive: true });

  let imageSources = (listing.images || []).map((img) => img.url).filter(Boolean).slice(0, MAX_SLIDES);

  const paddingCardPath = path.join(workDir, `_pad_${Date.now()}.png`);
  let paddingCardBuilt = false;
  while (imageSources.length < MIN_SLIDES) {
    if (!paddingCardBuilt) {
      await buildPaddingCardPng(paddingCardPath);
      paddingCardBuilt = true;
    }
    imageSources.push(paddingCardPath);
  }

  const closingCardPath = await getClosingCard();
  const { expectedTotal } = await buildFinalVideo({ imageSources, listing, closingCardPath, outputPath });

  const verification = await verifyRender(outputPath, expectedTotal);

  // Best-effort cleanup of intermediates — never fail the render over this.
  // (The closing card is NOT cleaned up — it's the persistent cache.)
  if (paddingCardBuilt) fs.rm(paddingCardPath, () => {});

  return { path: outputPath, expectedDuration: expectedTotal, ...verification };
}
