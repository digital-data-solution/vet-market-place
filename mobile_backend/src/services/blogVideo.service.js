/**
 * blogVideo.service.js
 *
 * Turns a published BlogPost into a short (~20-25s) vertical (1080x1920)
 * "tips" video — title card, then each bullet from the post's "## Key
 * Points" section as its own branded text slide, then a closing CTA card.
 * Built so Sam has a steady stream of TikTok/Instagram content that never
 * depends on whether anyone's actively listing on Xpress Market — reuses
 * the 50-post content pipeline that already exists (see
 * [[xpress-vet-content-pipeline]]) instead of needing new writing per post.
 *
 * Deliberately simpler/faster than listingVideo.service.js: pure text
 * cards, no photos, no Ken Burns/zoompan — a render here should take well
 * under the photo-video pipeline's time. Same verification discipline
 * though (decode pass + duration check) — never trust "ffmpeg exited 0".
 *
 * Parser requires a "## Key Points" section (confirmed present in 49/51
 * published posts as of 2026-09-06) — posts without one are skipped by the
 * caller, not silently rendered with garbage content.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { detectBlankStretches } from '../lib/videoFrameQa.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Reuse the exact same assets folder as listingVideo.service.js — same
// logo/fonts/music, no need to duplicate them.
const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'listingVideo');
const MUSIC_DIR = path.join(ASSETS_DIR, 'music');
const MUSIC_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg']);

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 25;
const TITLE_DURATION = 3.5;
const POINT_DURATION = 4.5;
const CTA_DURATION = 3.5;
const MAX_POINTS = 4; // cap so the video stays a snappy ~20-25s, not a full re-read of the article
const BRAND_BLUE = '0x2563EB';
const FONT_BOLD = 'arialbd.ttf';
const FONT_REGULAR = 'arial.ttf';
const LOGO_PATH = path.join(ASSETS_DIR, 'logo.png');

async function run(args) {
  return execFileAsync('ffmpeg', args, { maxBuffer: 1024 * 1024 * 64, cwd: ASSETS_DIR });
}
async function probe(filePath, args) {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', ...args, filePath]);
  return stdout.trim();
}

function pickMusicTrack() {
  if (!fs.existsSync(MUSIC_DIR)) return null;
  const files = fs.readdirSync(MUSIC_DIR).filter((f) => MUSIC_EXTENSIONS.has(path.extname(f).toLowerCase()));
  if (!files.length) return null;
  return path.join(MUSIC_DIR, files[Math.floor(Math.random() * files.length)]);
}

// ffmpeg's drawtext chokes on unescaped colons/apostrophes/quotes — strip
// rather than fight escaping for content we don't fully control (same
// approach as listingVideo.service.js). Markdown bold (**word**) is
// stripped to plain text; links [text](url) keep just the text.
function sanitizeForDrawtext(s) {
  return String(s || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/['":]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * Extracts up to MAX_POINTS bullet lines from a post's "## Key Points"
 * section. Returns [] if the section doesn't exist — caller decides
 * whether to skip the post entirely rather than render something empty.
 */
export function extractKeyPoints(contentMarkdown) {
  // Deliberately NOT a single regex with a $ -based end-of-section lookahead:
  // with the /m flag (needed for ^ to match "## Key Points" at a line
  // start), $ matches the end of EVERY line, not just the string's end —
  // a lazy [\s\S]*? then stops after the very first line, silently
  // capturing only 1 bullet instead of the whole section (hit exactly
  // this, verified via a direct test against a real post before trusting
  // it). Plain indexOf/slice sidesteps the ambiguity entirely.
  const marker = '## Key Points';
  const startIdx = contentMarkdown.indexOf(marker);
  if (startIdx === -1) return [];
  const after = contentMarkdown.slice(startIdx + marker.length);
  const nextHeadingIdx = after.search(/\n##[^#]/); // next H2 (not H3+)
  const section = nextHeadingIdx === -1 ? after : after.slice(0, nextHeadingIdx);

  const bullets = section
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
  return bullets.slice(0, MAX_POINTS);
}

// Simple word-wrap for drawtext (which doesn't wrap on its own) — breaks a
// long bullet into ~2-3 lines that fit the 1080-wide canvas at the chosen
// font size. Returns an array of lines — NOT a single \n-joined string.
//
// A \n-in-one-drawtext approach was tried first and looked fine in code, but
// a real rendered preview frame showed it silently broken: ffmpeg's filter
// string parser strips the backslash before handing the value to drawtext,
// so "\n" arrives as a bare "n" character glued onto the previous word
// ("vaccinatednflock") with no line break at all — confirmed by actually
// looking at the output frame, not by re-reading the ffmpeg docs. Emitting
// one drawtext filter per line (each self-centered via its own text_w) sidesteps
// the escaping entirely and is the robust way to do multi-line drawtext.
function wrapTextLines(text, maxCharsPerLine) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).trim().length > maxCharsPerLine) {
      lines.push(current.trim());
      current = w;
    } else {
      current = (current + ' ' + w).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

// Emits one drawtext filter per line, each vertically stacked and
// independently horizontally centered (x=(w-text_w)/2 uses that filter's
// own rendered width, so lines of different lengths all center correctly).
function stackedDrawtext({ chain, lines, fontfile, fontsize, fontcolor, centerY, lineHeight, prefix }) {
  const parts = [];
  const totalHeight = lines.length * lineHeight;
  const startY = centerY - totalHeight / 2;
  let cur = chain;
  lines.forEach((line, i) => {
    const y = Math.round(startY + i * lineHeight);
    const out = `${prefix}${i}`;
    parts.push(
      `[${cur}]drawtext=fontfile=${fontfile}:text='${line}':fontcolor=${fontcolor}:fontsize=${fontsize}:` +
      `x=(w-text_w)/2:y=${y}[${out}]`,
    );
    cur = out;
  });
  return { parts, chain: cur };
}

function buildTextSlideFilter({ inputIdx, logoIdx, heading, headingSize, body, bodySize, outLabel }) {
  const parts = [`[${inputIdx}:v]format=yuv420p,setsar=1[base${inputIdx}]`];
  let chain = `base${inputIdx}`;
  if (logoIdx !== null) {
    parts.push(`[${logoIdx}:v]scale=90:90,format=rgba,colorchannelmixer=aa=0.9[logo${inputIdx}]`);
    parts.push(`[${chain}][logo${inputIdx}]overlay=W-w-30:40[wm${inputIdx}]`);
    chain = `wm${inputIdx}`;
  }
  const hasBoth = Boolean(heading) && Boolean(body);
  if (heading) {
    const lines = wrapTextLines(sanitizeForDrawtext(heading), 22);
    const { parts: hParts, chain: hChain } = stackedDrawtext({
      chain, lines, fontfile: FONT_BOLD, fontsize: headingSize, fontcolor: 'white',
      centerY: hasBoth ? HEIGHT / 2 - 140 : HEIGHT / 2,
      lineHeight: headingSize + 14,
      prefix: `h${inputIdx}_`,
    });
    parts.push(...hParts);
    chain = hChain;
  }
  if (body) {
    const lines = wrapTextLines(sanitizeForDrawtext(body), 30);
    const { parts: bParts, chain: bChain } = stackedDrawtext({
      chain, lines, fontfile: FONT_REGULAR, fontsize: bodySize, fontcolor: '0xBFDBFE',
      centerY: hasBoth ? HEIGHT / 2 + 120 : HEIGHT / 2,
      lineHeight: bodySize + 10,
      prefix: `b${inputIdx}_`,
    });
    parts.push(...bParts);
    chain = bChain;
  }
  // Rename final chain to the requested outLabel (copy is a no-op filter,
  // just relabels the pad so downstream concat can address it by name).
  parts.push(`[${chain}]copy[${outLabel}]`);
  return parts.join(';');
}

/**
 * Renders the full teaser video for a blog post. `post` needs: title,
 * contentMarkdown. Returns { path, expectedDuration, ok, warnings, errors,
 * actualDuration } — same verified-result shape as listingVideo.service.js.
 */
export async function renderBlogTeaser(post, outputPath) {
  const points = extractKeyPoints(post.contentMarkdown);
  if (!points.length) {
    throw new Error('No "## Key Points" section found — cannot build a teaser for this post.');
  }

  const workDir = path.dirname(outputPath);
  fs.mkdirSync(workDir, { recursive: true });

  const slides = [
    { duration: TITLE_DURATION, heading: post.title, headingSize: 68, body: null, bodySize: 0 },
    ...points.map((p) => ({ duration: POINT_DURATION, heading: null, headingSize: 0, body: p, bodySize: 52 })),
    { duration: CTA_DURATION, heading: 'Read the full guide', headingSize: 56, body: 'Free on the Xpress Vet blog — xpressvetmarketplace.com', bodySize: 36 },
  ];

  const inputs = [];
  slides.forEach((s) => {
    inputs.push('-f', 'lavfi', '-i', `color=c=${BRAND_BLUE}:s=${WIDTH}x${HEIGHT}:d=${s.duration}:r=${FPS}`);
  });
  inputs.push('-i', LOGO_PATH);
  const logoIdx = slides.length;

  const filters = slides.map((s, i) =>
    buildTextSlideFilter({
      inputIdx: i, logoIdx, heading: s.heading, headingSize: s.headingSize,
      body: s.body, bodySize: s.bodySize, outLabel: `v${i}`,
    }),
  );
  const concatInputs = slides.map((_, i) => `[v${i}]`).join('');
  filters.push(`${concatInputs}concat=n=${slides.length}:v=1:a=0[vfinal]`);

  const expectedTotal = slides.reduce((sum, s) => sum + s.duration, 0);

  const musicPath = pickMusicTrack();
  if (musicPath) {
    inputs.push('-stream_loop', '-1', '-i', musicPath);
    const musicIdx = logoIdx + 1;
    const fadeOutStart = Math.max(0, expectedTotal - 1);
    filters.push(
      `[${musicIdx}:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.22,` +
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

  // Verification — same discipline as listingVideo.service.js: never trust
  // "ffmpeg exited 0" alone.
  const warnings = [];
  const errors = [];
  try {
    await execFileAsync('ffmpeg', ['-v', 'warning', '-i', outputPath, '-f', 'null', '-']);
  } catch (err) {
    errors.push(`Decode pass failed: ${err.stderr?.toString().slice(0, 500) || err.message}`);
  }
  let actualDuration = null;
  try {
    actualDuration = parseFloat(await probe(outputPath, ['-show_entries', 'format=duration', '-of', 'csv=p=0']));
    const drift = Math.abs(actualDuration - expectedTotal);
    if (drift > 0.5) errors.push(`Duration mismatch: expected ~${expectedTotal.toFixed(1)}s, got ${actualDuration.toFixed(1)}s.`);
    else if (drift > 0.15) warnings.push(`Duration drift ${drift.toFixed(2)}s.`);
  } catch (err) {
    errors.push(`Could not read output duration: ${err.message}`);
  }

  // Blank-slide check (see lib/videoFrameQa.js) — a drawtext/overlay filter
  // silently no-op'ing produces a technically-valid, decodable file with a
  // flat-color slide, which the decode-pass/duration checks above can't
  // catch on their own. Logged as a warning, not an error — doesn't block
  // the render, just gets surfaced for a human/Claude to spot-check.
  const blankFrameWarnings = await detectBlankStretches(outputPath).catch((err) => [`Blank-slide check itself failed: ${err.message}`]);
  warnings.push(...blankFrameWarnings);

  return { path: outputPath, expectedDuration: expectedTotal, ok: errors.length === 0, warnings, errors, actualDuration };
}
