import request from 'supertest';
import app from '../src/app.js';

describe('Basic integration', () => {
  test('GET /health should return status OK', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
  });

  test('GET unknown route returns 404', async () => {
    const res = await request(app).get('/no-such-route');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not Found');
  });
});
import request from 'supertest';
import app from '../src/app.js';
import connectDB from '../src/lib/db.js';
import dotenv from 'dotenv';

dotenv.config({ path: './.env' });

beforeAll(async () => {
  await connectDB();
});

describe('Integration tests - basic endpoints', () => {
  test('GET / responds', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toMatch(/Vet backend app/);
  });

  test('Health endpoint', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBeDefined();
  });
});
