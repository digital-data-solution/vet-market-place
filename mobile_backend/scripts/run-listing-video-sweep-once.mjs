/**
 * Runs exactly ONE listing-video sweep (a few pending listings, whatever
 * BATCH_SIZE allows in jobs/listingVideoWorker.js) and exits — built for
 * GitHub Actions' scheduled workflows, not a long-lived process. This is
 * the free alternative to a paid Render Background Worker: GitHub gives
 * every repo free Actions minutes, and hosted runners come with ffmpeg
 * pre-installed, so no server needs to be paid for or kept always-on.
 *
 * Not run directly in normal use — see
 * .github/workflows/listing-video-worker.yml, which calls this on a
 * schedule with MONGODB_URI/CLOUDINARY_* supplied as GitHub Actions
 * secrets (never committed, never in Render's env — this process runs on
 * GitHub's infrastructure, not Sam's Render account at all).
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In CI, env vars come from GitHub Actions secrets (already in process.env)
// — dotenv.config() here is a no-op if no .env file exists, harmless locally too.
dotenv.config({ path: path.join(__dirname, '../.env') });

const { default: connectDB } = await import('../src/config/db.js');
const { runSweep } = await import('../src/jobs/listingVideoWorker.js');
const { default: logger } = await import('../src/lib/logger.js');

await connectDB();
logger.info('🎬 Listing video one-shot sweep starting');
await runSweep();
logger.info('🎬 Listing video one-shot sweep finished');
process.exit(0);
