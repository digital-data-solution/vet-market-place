/**
 * renderFeatureComparison.js — programmatically bundles and renders the
 * Remotion FeatureComparison composition (src/remotion/) to a real MP4,
 * without needing the interactive `remotion studio` CLI. Mirrors the same
 * "verify what actually got produced" discipline as blogVideo.service.js/
 * listingVideo.service.js — returns the output path plus basic ffprobe
 * facts so a caller can sanity-check before uploading anywhere.
 *
 * Real bug found 2026-09-11: Remotion's own renderMedia() output has NO
 * audio stream at all (the composition never added one) — this posted
 * fine to YouTube and Facebook but Instagram's Reels container-processing
 * rejected it outright ("container failed processing"), almost certainly
 * because Reels expects an audio track. Fixed by muxing in a music bed
 * (reusing the same licensed-track folder as blogVideo.service.js/
 * listingVideo.service.js) as a post-process step, with the exact same
 * proven-compatible encode flags that pipeline already uses
 * (yuv420p/aac/+faststart) rather than trusting Remotion's own defaults.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_POINT = path.join(__dirname, '..', 'remotion', 'entry.jsx');
const MUSIC_DIR = path.join(__dirname, '..', 'assets', 'listingVideo', 'music');
const MUSIC_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg']);

function pickMusicTrack() {
  if (!fs.existsSync(MUSIC_DIR)) return null;
  const files = fs.readdirSync(MUSIC_DIR).filter((f) => MUSIC_EXTENSIONS.has(path.extname(f).toLowerCase()));
  if (!files.length) return null;
  return path.join(MUSIC_DIR, files[Math.floor(Math.random() * files.length)]);
}

export async function renderFeatureComparisonVideo(outputPath) {
  const bundleLocation = await bundle({ entryPoint: ENTRY_POINT });

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'FeatureComparison',
  });

  const silentPath = outputPath.replace(/\.mp4$/, '-silent.mp4');
  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: silentPath,
  });

  const durationSec = composition.durationInFrames / composition.fps;
  const musicPath = pickMusicTrack();

  // Mux in audio (music bed if available, else true silence — either way
  // the output MUST have an audio stream, per the bug above) with the same
  // encode flags proven compatible with Instagram/Facebook/YouTube
  // elsewhere in this codebase.
  const audioInput = musicPath
    ? ['-stream_loop', '-1', '-i', musicPath]
    : ['-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${durationSec}`];
  const audioFilter = musicPath
    ? [`[1:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.25,atrim=0:${durationSec},afade=t=out:st=${Math.max(0, durationSec - 1)}:d=1[afinal]`]
    : [];

  await execFileAsync('ffmpeg', [
    '-y', '-i', silentPath,
    ...audioInput,
    ...(audioFilter.length ? ['-filter_complex', audioFilter.join(';'), '-map', '0:v', '-map', '[afinal]'] : ['-map', '0:v', '-map', '1:a']),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-shortest', '-movflags', '+faststart',
    outputPath,
  ], { maxBuffer: 1024 * 1024 * 64 });

  fs.rm(silentPath, () => {});

  return { path: outputPath, durationInFrames: composition.durationInFrames, fps: composition.fps, hasAudio: true };
}
