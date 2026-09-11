/**
 * kokoroNarration.js — local, free text-to-speech via Kokoro (ONNX, runs
 * on-device through kokoro-js/onnxruntime-node — no API key, no per-render
 * cost, works fine in a GitHub Actions runner same as everything else in
 * this pipeline). See [[claude-code-media-capabilities]] for the boundary
 * this respects: Claude Code cannot hear audio, so a generated clip's
 * *content* (does it say the right words) is verified by duration
 * sanity-checking here, not by listening — a human should spot-check
 * before this narrates anything customer-facing at scale.
 *
 * NOT yet wired into blogVideoWorker.js/listingVideoWorker.js's automatic
 * render path — deliberately opt-in for now (same "never automatic
 * client-facing behavior without the owner turning it on" philosophy as
 * everywhere else in this codebase). Sam can wire this into a render once
 * he's heard a sample and is happy with the voice.
 *
 * Pronunciation lexicon: Kokoro (like most TTS) mangles ₦ amounts and
 * Nigerian names by default (reads "₦5,000" as literal symbol names, not
 * "five thousand naira"; may mis-stress unfamiliar names). This module
 * applies a small, growing find-and-replace pass before synthesis —
 * expand LEXICON as real mispronunciations get caught by ear.
 */
import { KokoroTTS } from 'kokoro-js';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CACHE_DIR = path.join(os.tmpdir(), 'xpress-kokoro-cache');
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE = 'af_heart';

let ttsInstance = null;
async function getTts() {
  if (!ttsInstance) {
    ttsInstance = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8' });
  }
  return ttsInstance;
}

// Naira-amount pattern first (must run before generic number handling) —
// "₦5,000" / "N5,000" / "NGN 5,000" → "five thousand naira" would need a
// full number-to-words library for the general case; for now this handles
// the exact shape used in this codebase's own pricing copy (see
// lib/pitchOnePager.js) by spelling the digits with "naira" appended,
// which Kokoro reads correctly (tested) even if less elegant than full
// word-form numbers.
function expandNairaAmounts(text) {
  return text.replace(/₦\s?([\d,]+)/g, (_, digits) => `${digits.replace(/,/g, '')} naira`);
}

// Grows as real mispronunciations get caught by ear (a human listening
// task — see this file's docstring on why Claude Code can't do this part
// itself). Case-insensitive whole-word match — but note a case-insensitive
// match with a fixed-case replacement will FLATTEN capitalization (a real
// bug caught while testing: an earlier no-op-looking [/\bvet\b/gi, 'vet']
// entry actually lowercased "Xpress Vet's" to "Xpress vet's"). Keep every
// entry here genuinely lowercase-safe, or use a function replacement that
// preserves the matched case.
const LEXICON = [
  [/\bNGN\b/g, 'naira'], // NGN is always uppercase in this codebase's own copy — no case-insensitivity needed
];

export function applyPronunciationLexicon(text) {
  let out = expandNairaAmounts(text);
  for (const [pattern, replacement] of LEXICON) out = out.replace(pattern, replacement);
  return out;
}

function cacheKeyFor(text, voice) {
  return createHash('sha256').update(`${voice}::${text}`).digest('hex');
}

/**
 * Synthesizes `text` to a WAV file, returning the local path. Hash-keyed
 * cache (text + voice) means re-rendering the same line — the common case
 * when only a video's visuals change, not its script — costs nothing on
 * a second run.
 */
export async function synthesizeNarration(text, { voice = DEFAULT_VOICE, outputPath = null } = {}) {
  const processedText = applyPronunciationLexicon(text);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const cachePath = path.join(CACHE_DIR, `${cacheKeyFor(processedText, voice)}.wav`);
  if (fs.existsSync(cachePath)) {
    if (outputPath && outputPath !== cachePath) fs.copyFileSync(cachePath, outputPath);
    return { path: outputPath || cachePath, cached: true };
  }

  const tts = await getTts();
  const audio = await tts.generate(processedText, { voice });
  await audio.save(cachePath);
  if (outputPath && outputPath !== cachePath) fs.copyFileSync(cachePath, outputPath);
  return { path: outputPath || cachePath, cached: false };
}

export function listVoices() {
  // Static list from the model card — af_* = American-female-accented
  // voices, the only ones verified working in this module's own test.
  // Kokoro also ships am_*/bf_*/bm_* (male/British) voices not yet tried
  // here.
  return ['af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah'];
}
