/**
 * Runs exactly ONE YouTube-Shorts sweep and exits — same one-shot-for-
 * GitHub-Actions shape as run-scheduled-reels-sweep-once.mjs.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: connectDB } = await import('../src/config/db.js');
const { runSweep } = await import('../src/jobs/youtubeShortsWorker.js');
const { default: logger } = await import('../src/lib/logger.js');

await connectDB();
logger.info('📺 YouTube Shorts one-shot sweep starting');
await runSweep();
logger.info('📺 YouTube Shorts one-shot sweep finished');
process.exit(0);
