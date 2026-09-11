/**
 * videoFrameQa.js — frame-extraction QA for rendered videos.
 *
 * Real boundary: Claude Code cannot watch a video file directly. What it CAN
 * do is run ffmpeg to pull evenly-spaced frames out of one, then look at
 * those frames as still images (which it perceives natively) — enough to
 * catch a broken render (missing image, mid-render crash, a text card that
 * overflows its safe zone, a black/blank slide) before it goes out to
 * Instagram/Facebook/YouTube, rather than after. See
 * [[claude-code-media-capabilities]] for the full boundary this respects.
 *
 * Two checks, deliberately kept cheap and automatable (no vision call
 * needed for the pass/fail signal — only for a human/Claude spot-check of
 * the extracted frames):
 *   1. Blank/near-solid-color frame detection via ffmpeg's own `blackdetect`
 *      filter — catches the most common real failure mode seen in this
 *      pipeline's history (a slide that renders as a flat color because a
 *      drawtext/overlay filter silently no-op'd).
 *   2. Duration sanity check via ffprobe — catches a render that's
 *      drastically shorter/longer than expected (a sign a filter chain
 *      broke partway through).
 *
 * Extracted frames are saved to disk and their paths returned so a human
 * (or Claude, via the Read tool) can actually look at them — this module
 * does not itself judge whether a frame "looks right," only whether it's
 * suspiciously blank or the duration is off.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';

const execFileAsync = promisify(execFile);

const DEFAULT_FRAME_COUNT = 6;
const BLACKDETECT_MIN_DURATION = 0.5; // seconds a frame must be "black" to flag — avoids false positives on brief legitimate cuts-to-black

async function probeDuration(videoPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);
  return parseFloat(stdout.trim());
}

/**
 * Extracts `frameCount` evenly-spaced frames from a video (local path or
 * any ffmpeg-readable URL, e.g. a Cloudinary link) into `outDir`. Returns
 * { framePaths, duration, blankFrameWarnings, durationWarning }.
 *
 * `expectedDurationSec` (optional): if given, flags a duration mismatch
 * beyond `durationToleranceSec` (default 3s) — mirrors the same
 * duration-tolerance discipline already used in blogVideo.service.js/
 * listingVideo.service.js's own post-render verification.
 */
export async function extractQaFrames(videoPath, {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpress-video-qa-')),
  frameCount = DEFAULT_FRAME_COUNT,
  expectedDurationSec = null,
  durationToleranceSec = 3,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });

  const duration = await probeDuration(videoPath);
  const durationWarning = (expectedDurationSec !== null && Math.abs(duration - expectedDurationSec) > durationToleranceSec)
    ? `Duration ${duration.toFixed(1)}s is more than ${durationToleranceSec}s off the expected ${expectedDurationSec}s — a filter chain may have broken partway through the render.`
    : null;

  // Evenly-spaced timestamps, avoiding the very first/last frame (often a
  // deliberate fade) so the sample better represents mid-content.
  const margin = duration * 0.05;
  const usable = duration - margin * 2;
  const framePaths = [];
  for (let i = 0; i < frameCount; i++) {
    const t = margin + (usable * i) / Math.max(1, frameCount - 1);
    const framePath = path.join(outDir, `frame-${String(i + 1).padStart(2, '0')}-${t.toFixed(1)}s.jpg`);
    await execFileAsync('ffmpeg', [
      '-y', '-ss', t.toFixed(2), '-i', videoPath,
      '-frames:v', '1', '-q:v', '2', framePath,
    ], { maxBuffer: 1024 * 1024 * 32 });
    framePaths.push(framePath);
  }

  const blankFrameWarnings = await detectBlankStretches(videoPath);

  return { framePaths, duration, durationWarning, blankFrameWarnings, outDir };
}

/**
 * Scans the WHOLE video (via ffmpeg's blackdetect) for any stretch of
 * near-solid-black lasting >= BLACKDETECT_MIN_DURATION — catches a blank
 * slide (a real, recurring failure mode: a drawtext/overlay filter that
 * silently no-ops) even if a frame sample happens to miss it. Exported on
 * its own so the render pipelines (blogVideo.service.js,
 * listingVideo.service.js) can call just this cheap check inline, without
 * paying for full frame extraction on every render.
 */
export async function detectBlankStretches(videoPath) {
  try {
    const { stderr } = await execFileAsync('ffmpeg', [
      '-i', videoPath,
      '-vf', `blackdetect=d=${BLACKDETECT_MIN_DURATION}:pic_th=0.98`,
      '-an', '-f', 'null', '-',
    ], { maxBuffer: 1024 * 1024 * 32 });
    const matches = [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)];
    return matches.map((m) => `Blank/black stretch from ${m[1]}s to ${m[2]}s (${m[3]}s long) — check this is intentional (a transition), not a broken slide.`);
  } catch (err) {
    // blackdetect failing entirely (e.g. codec issue) is itself worth surfacing, not swallowing silently.
    return [`blackdetect check itself failed to run: ${err.message} — could not verify this render is free of blank slides.`];
  }
}
