/**
 * hookVariants.js — A/B hook-variant generation for the auto-video
 * pipeline. Real gap this closes: every teaser video so far has opened
 * with the post/listing title verbatim as the hook — no way to tell
 * whether a punchier opening line would get more of the first 2 seconds'
 * attention (the single biggest lever for short-form retention), because
 * there was only ever one version to compare against.
 *
 * Deliberately template-based, not an LLM call at render time — keeps
 * this free/fast/deterministic (same post always gets the same variant
 * assignment, so a re-render doesn't silently change what's being tested)
 * and avoids the real risk of a generated hook overclaiming something the
 * product doesn't do (compliance passes on hook copy stay a human's job
 * for now, same as everywhere else in this pipeline).
 *
 * Variant 0 is always the plain title — the control. Every other index is
 * a templated reframing of the same title, never inventing new claims.
 */

/**
 * Returns an array of hook strings for a title — index 0 is always the
 * literal title (the control/original behavior).
 */
export function generateHookVariants(title) {
  const clean = String(title || '').trim().replace(/[.?!]+$/, '');
  return [
    clean, // variant 0: control — the plain title, exactly as before
    `Did you know? ${clean}`, // variant 1: curiosity-gap framing
    `Every Nigerian pet/farm owner should know this: ${clean}`, // variant 2: stakes framing
  ];
}

/**
 * Deterministic variant index for a given document id — same id always
 * maps to the same variant, so a re-render (e.g. a retry after a
 * transient failure) never silently swaps which hook a post is testing.
 * Spreads across `variantCount` via a cheap string hash, not crypto-grade
 * but doesn't need to be — this only needs an even-ish distribution.
 */
export function pickVariantIndex(id, variantCount) {
  const s = String(id);
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % variantCount;
}
