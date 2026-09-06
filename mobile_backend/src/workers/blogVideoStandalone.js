/**
 * Standalone entry point for the blog-video worker — same shape as
 * workers/listingVideoStandalone.js. Not the deployed path (GitHub Actions
 * is — see .github/workflows/blog-video-worker.yml) but kept as a
 * documented alternative for running on a paid always-on worker instead.
 *
 * Run: npm run worker:blog-video
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const { default: connectDB } = await import('../config/db.js');
const { runSweep } = await import('../jobs/blogVideoWorker.js');
const { default: logger } = await import('../lib/logger.js');

await connectDB();

logger.info('📝 Blog video standalone worker starting (every 5 minutes)');

cron.schedule('*/5 * * * *', async () => {
  try {
    await runSweep();
  } catch (err) {
    logger.error('Blog video sweep error', { error: err.message });
  }
}, { timezone: 'UTC' });

runSweep().catch((err) => logger.error('Initial blog video sweep error', { error: err.message }));

process.on('SIGTERM', () => { logger.info('SIGTERM received — blog video worker shutting down'); process.exit(0); });
process.on('SIGINT', () => { logger.info('SIGINT received — blog video worker shutting down'); process.exit(0); });
