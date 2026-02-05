import { createClient } from 'redis';

const redisClient = createClient({
  url: process.env.REDIS_URL // Render.com provides this
});

redisClient.on('error', (err) => console.log('❌ Redis Client Error', err));

const connectRedis = async () => {
  await redisClient.connect();
  console.log('✅ Redis Connected & Ready');
};

export { redisClient, connectRedis };