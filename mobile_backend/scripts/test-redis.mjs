import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from 'redis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const url = process.env.REDIS_URL || process.env.REDI_URL;
console.log('Using REDIS_URL:', url ? url.replace(/:(.+)@/, ':*****@') : 'MISSING');

if (!url) {
  console.error('No REDIS_URL found in .env');
  process.exit(2);
}

const client = createClient({ url });
client.on('error', (err) => console.error('Redis error event:', err && err.message));

(async () => {
  try {
    await client.connect();
    const pong = await client.ping();
    console.log('PING response:', pong);
    await client.quit();
    process.exit(0);
  } catch (err) {
    console.error('Connection failed:', err && err.message);
    process.exit(1);
  }
})();
