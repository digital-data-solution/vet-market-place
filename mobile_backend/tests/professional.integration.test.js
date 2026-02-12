import request from 'supertest';
import app from '../src/app.js';
import connectDB from '../src/lib/db.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config({ path: './.env' });

beforeAll(async () => {
  await connectDB();
});
afterAll(async () => {
  await mongoose.connection.close();
});

describe('Professional Onboarding', () => {
  let token;
  // You may want to mock or create a test user and get a valid JWT token here
  // For now, this test expects a valid token in process.env.TEST_USER_TOKEN
  beforeAll(() => {
    token = process.env.TEST_USER_TOKEN;
  });

  test('Should fail without authentication', async () => {
    const res = await request(app)
      .post('/api/v1/professional/onboard')
      .send({ name: 'Test Vet', role: 'vet', vcnNumber: 'VCN12345' });
    expect(res.statusCode).toBe(401);
  });

  test('Should fail with missing fields', async () => {
    const res = await request(app)
      .post('/api/v1/professional/onboard')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'vet' });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Name and role are required/);
  });

  test('Should onboard a vet with valid data', async () => {
    const res = await request(app)
      .post('/api/v1/professional/onboard')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test Vet', role: 'vet', vcnNumber: 'VCN12345', address: 'Lagos', specialization: 'Surgery' });
    expect([200, 201]).toContain(res.statusCode);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body.data).toHaveProperty('name', 'Test Vet');
    expect(res.body.data).toHaveProperty('role', 'vet');
  });

  test('Should onboard a kennel with valid data', async () => {
    const res = await request(app)
      .post('/api/v1/professional/onboard')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test Kennel', role: 'kennel', address: 'Abuja' });
    expect([200, 201]).toContain(res.statusCode);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body.data).toHaveProperty('name', 'Test Kennel');
    expect(res.body.data).toHaveProperty('role', 'kennel');
  });
});
