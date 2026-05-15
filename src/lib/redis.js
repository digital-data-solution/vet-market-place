import { createClient } from 'redis';

let redisConnected = false;

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

try {
  const masked = redisUrl.replace(/:(.+)@/, ':*****@');
  console.log('Using REDIS_URL:', masked);
} catch (e) {
  console.log('Using REDIS_URL: (unable to mask)');
}

const redisClient = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 3) return false; // Stop retrying after 3 attempts
      return 1000; // Wait 1 second between retries
    }
  }
});

redisClient.on('error', (err) => {
  if (!redisConnected) {
    console.error('❌ Redis Client Error:', err.message);
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
    console.error('Redis connect() failed:', error?.message);
  }
};

export { redisClient, connectRedis };