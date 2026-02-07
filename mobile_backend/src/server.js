import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables before importing modules that use them
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

// Dynamic import of runtime modules so they read process.env after dotenv.config
const { default: app } = await import('./app.js');
const { default: connectDB } = await import('./lib/db.js');
const { connectRedis } = await import('./lib/redis.js');
const { default: startLicenseCheckJob } = await import('./jobs/licenseCron.js');

// Start Services
connectDB();
connectRedis();
startLicenseCheckJob();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  process.exit(0);
});