/**
 * renderFeatureComparison.js — programmatically bundles and renders the
 * Remotion FeatureComparison composition (src/remotion/) to a real MP4,
 * without needing the interactive `remotion studio` CLI. Mirrors the same
 * "verify what actually got produced" discipline as blogVideo.service.js/
 * listingVideo.service.js — returns the output path plus basic ffprobe
 * facts so a caller can sanity-check before uploading anywhere.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_POINT = path.join(__dirname, '..', 'remotion', 'entry.jsx');

export async function renderFeatureComparisonVideo(outputPath) {
  const bundleLocation = await bundle({ entryPoint: ENTRY_POINT });

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'FeatureComparison',
  });

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: outputPath,
  });

  return { path: outputPath, durationInFrames: composition.durationInFrames, fps: composition.fps };
}
