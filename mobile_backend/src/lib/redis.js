import { createClient } from 'redis';

let redisConnected = false;

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  retry_strategy: () => null
});

redisClient.on('error', (err) => {
  if (!redisConnected) {
    console.log('❌ Redis Client Error (Redis not available, continuing without caching):', err.message);
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
    // Redis not available, continue without it
  }
};

export { redisClient, connectRedis };