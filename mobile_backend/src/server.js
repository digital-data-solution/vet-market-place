import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Must run before any other imports that read process.env
dotenv.config({ path: path.join(__dirname, '../.env') });

// Dynamic imports so all modules read env vars after dotenv.config()
const { default: app }                       = await import('./app.js');
const { default: connectDB }                 = await import('./config/db.js');
const { connectRedis }                       = await import('./lib/redis.js');
const { default: startLicenseCheckJob }      = await import('./jobs/licenseCron.js');
const { default: startSubscriptionJobs }     = await import('./jobs/subscriptionReminders.js');

// Start services
await connectDB();
connectRedis();
startLicenseCheckJob();
startSubscriptionJobs();

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received — closing server');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received — closing server');
  process.exit(0);
});