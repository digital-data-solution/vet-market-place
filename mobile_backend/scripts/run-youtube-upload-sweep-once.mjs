/**
 * Runs exactly ONE YouTube-upload sweep (a few pending videos, whatever
 * BATCH_SIZE allows in jobs/youtubeUploadWorker.js) and exits — same
 * one-shot-for-GitHub-Actions shape as run-blog-video-sweep-once.mjs /
 * run-listing-video-sweep-once.mjs.
 *
 * Cheap to run even with no work to do — it just no-ops if YOUTUBE_* isn't
 * configured yet, or exits fast if the queue is empty.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: connectDB } = await import('../src/config/db.js');
const { runSweep } = await import('../src/jobs/youtubeUploadWorker.js');
const { default: logger } = await import('../src/lib/logger.js');

await connectDB();
logger.info('📺 YouTube upload one-shot sweep starting');
await runSweep();
logger.info('📺 YouTube upload one-shot sweep finished');
process.exit(0);
