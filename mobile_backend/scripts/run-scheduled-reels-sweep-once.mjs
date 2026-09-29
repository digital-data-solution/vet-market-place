/**
 * Runs exactly ONE scheduled-Reels sweep and exits — same one-shot-for-
 * GitHub-Actions shape as run-instagram-upload-sweep-once.mjs.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: connectDB } = await import('../src/config/db.js');
const { runSweep } = await import('../src/jobs/scheduledReelWorker.js');
const { default: logger } = await import('../src/lib/logger.js');

await connectDB();
logger.info('🎬 Scheduled Reels one-shot sweep starting');
await runSweep();
logger.info('🎬 Scheduled Reels one-shot sweep finished');
process.exit(0);
