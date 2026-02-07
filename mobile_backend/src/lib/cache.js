import { createClient } from 'redis';

let redisClient = null;
const inMemory = new Map();
const pending = new Map();

export async function initCache() {
  if (redisClient) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) {
    // no redis configured
    return null;
  }
  redisClient = createClient({ url });
  redisClient.on('error', (err) => console.error('Redis Client Error', err));
  await redisClient.connect();
  return redisClient;
}

export async function cacheGet(key) {
  if (redisClient) {
    try {
      const v = await redisClient.get(key);
      return v ? JSON.parse(v) : null;
    } catch (e) {
      console.error('cacheGet error', e.message);
      return null;
    }
  }
  const raw = inMemory.get(key);
  if (!raw) return null;
  if (raw.expires && raw.expires <= Date.now()) {
    inMemory.delete(key);
    return null;
  }
  return raw.value;
}

export async function cacheSet(key, value, ttlSeconds = 60) {
  if (redisClient) {
    try {
      await redisClient.set(key, JSON.stringify(value), { EX: ttlSeconds });
      return;
    } catch (e) {
      console.error('cacheSet error', e.message);
    }
  }
  inMemory.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

// single-flight wrapper: avoid duplicate concurrent backend fetches
export async function cacheWrap(key, ttlSeconds, fn) {
  // check cache
  const cached = await cacheGet(key);
  if (cached) return cached;

  // if another call is pending, wait for it
  if (pending.has(key)) return pending.get(key);

  const p = (async () => {
    try {
      const result = await fn();
      await cacheSet(key, result, ttlSeconds);
      return result;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, p);
  return p;
}

export async function cacheDel(key) {
  if (redisClient) {
    try { await redisClient.del(key); } catch (e) { console.error('cacheDel', e.message); }
    return;
  }
  inMemory.delete(key);
}

export default { initCache, cacheGet, cacheSet, cacheWrap, cacheDel };
