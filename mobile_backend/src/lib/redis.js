import { createClient } from 'redis';

let redisConnected = false;

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Configure Redis client with TLS support for production
const clientOptions = {
  url: redisUrl,
  retry_strategy: () => null,
  // Enable TLS for rediss:// URLs
  ...(redisUrl.startsWith('rediss://') && {
    socket: {
      tls: true,
      rejectUnauthorized: false // For self-signed certificates
    }
  })
};

try {
  const masked = redisUrl.replace(/:(.+)@/, ':*****@');
  console.log('Using REDIS_URL:', masked);
} catch (e) {
  console.log('Using REDIS_URL: (unable to mask)');
}

const redisClient = createClient(clientOptions);

redisClient.on('error', (err) => {
  if (!redisConnected) {
    console.error('❌ Redis Client Error (Redis not available, continuing without caching):', err);
    if (err && err.stack) console.error(err.stack);
    redisConnected = true; // Prevent repeated logs
  }
});

redisClient.on('connect', () => {
  console.log('✅ Redis Connected & Ready');
  redisConnected = true;
});

const connectRedis = async () => {
  try {
    await redisClient.connect();
  } catch (error) {
    console.error('Redis connect() failed:', error && error.message);
    if (error && error.stack) console.error(error.stack);
  }
};

export { redisClient, connectRedis };