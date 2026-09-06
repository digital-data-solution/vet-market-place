/**
 * Standalone entry point for the listing-video worker — run this as its own
 * process (a separate Render Background Worker service, or any other
 * always-on machine), NOT inside the main API process. See the docstring
 * in jobs/listingVideoWorker.js for why this needs to be separate: CPU cost
 * (rendering competes with API request handling) and Cloudinary video
 * billing (far more expensive than images at listing volume).
 *
 * Run: npm run worker:listing-video
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const { default: connectDB } = await import('../config/db.js');
const { runSweep } = await import('../jobs/listingVideoWorker.js');
const { default: logger } = await import('../lib/logger.js');

await connectDB();

logger.info('🎬 Listing video standalone worker starting (every 5 minutes)');

cron.schedule('*/5 * * * *', async () => {
  try {
    await runSweep();
  } catch (err) {
    logger.error('Listing video sweep error', { error: err.message });
  }
}, { timezone: 'UTC' });

// Run once immediately on boot too, rather than waiting up to 5 minutes
// for the first sweep.
runSweep().catch((err) => logger.error('Initial listing video sweep error', { error: err.message }));

process.on('SIGTERM', () => { logger.info('SIGTERM received — listing video worker shutting down'); process.exit(0); });
process.on('SIGINT', () => { logger.info('SIGINT received — listing video worker shutting down'); process.exit(0); });
