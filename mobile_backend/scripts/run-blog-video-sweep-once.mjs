/**
 * Runs exactly ONE blog-video sweep (a few pending posts, whatever
 * BATCH_SIZE allows in jobs/blogVideoWorker.js) and exits — built for
 * GitHub Actions' scheduled workflows, mirrors
 * run-listing-video-sweep-once.mjs exactly.
 *
 * Not run directly in normal use — see
 * .github/workflows/blog-video-worker.yml.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: connectDB } = await import('../src/config/db.js');
const { runSweep } = await import('../src/jobs/blogVideoWorker.js');
const { default: logger } = await import('../src/lib/logger.js');

await connectDB();
logger.info('📝 Blog video one-shot sweep starting');
await runSweep();
logger.info('📝 Blog video one-shot sweep finished');
process.exit(0);
