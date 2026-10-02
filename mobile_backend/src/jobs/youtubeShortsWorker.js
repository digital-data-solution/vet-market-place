/**
 * Uploads pending YouTubeShort rows to Xpress Vet's YouTube channel. Each one
 * goes up as private + publishAt, so YouTube publishes it at its slot — the
 * whole calendar can be uploaded ahead of time. A row whose slot has already
 * passed (late render, missed run) publishes 15 minutes after upload instead.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import fetch from 'node-fetch';
import YouTubeShort from '../models/YouTubeShort.js';
import { uploadVideoToYouTube, isYoutubeConfigured } from '../lib/youtubeUpload.js';
import logger from '../lib/logger.js';

const BATCH_SIZE = 8; // videos.insert has its own 100/day bucket; this just keeps a run short
const WORK_DIR = path.join(os.tmpdir(), 'xpress-vet-youtube-shorts');

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  await fs.promises.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

export async function runSweep() {
  if (!isYoutubeConfigured()) {
    logger.info('YouTube Shorts: YouTube not configured — skipping sweep.');
    return;
  }
  fs.mkdirSync(WORK_DIR, { recursive: true });
  for (let i = 0; i < BATCH_SIZE; i += 1) {
    const short = await YouTubeShort.findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'processing' } },
      { sort: { publishAt: 1 }, new: true },
    );
    if (!short) break;
    const file = path.join(WORK_DIR, `${short.key}.mp4`);
    try {
      await download(short.videoUrl, file);
      const earliest = Date.now() + 15 * 60 * 1000;
      const publishAt = new Date(Math.max(short.publishAt.getTime(), earliest)).toISOString();
      const { videoId, url } = await uploadVideoToYouTube(file, {
        title: short.title, description: short.description, tags: short.tags, publishAt, syntheticMedia: true,
      });
      short.status = 'uploaded';
      short.videoId = videoId;
      short.url = url;
      short.error = null;
      short.uploadedAt = new Date();
      logger.info('YouTube Short uploaded', { key: short.key, url, publishAt });
    } catch (err) {
      short.status = 'failed';
      short.error = (err.message || 'Unknown YouTube upload error').slice(0, 500);
      logger.error('YouTube Short upload failed', { key: short.key, error: err.message });
    } finally {
      fs.rmSync(file, { force: true });
    }
    await short.save();
  }
}
