/**
 * Runs exactly ONE Instagram-upload sweep and exits — same one-shot-for-
 * GitHub-Actions shape as the YouTube/blog/listing sweep scripts.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: connectDB } = await import('../src/config/db.js');
const { runSweep } = await import('../src/jobs/instagramUploadWorker.js');
const { default: logger } = await import('../src/lib/logger.js');

await connectDB();
logger.info('📸 Instagram upload one-shot sweep starting');
await runSweep();
logger.info('📸 Instagram upload one-shot sweep finished');
process.exit(0);
