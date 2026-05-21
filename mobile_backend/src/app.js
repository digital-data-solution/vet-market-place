import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

// Routes
import authRoutes            from './routes/auth.routes.js';
import vetRoutes             from './routes/vet.routes.js';
import kennelRoutes          from './routes/kennel.routes.js';
import shopRoutes            from './routes/shop.routes.js';
import professionalRoutes    from './routes/professional.routes.js';
import vetVerificationRoutes from './routes/vetVerification.routes.js';
import subscriptionRoutes    from './routes/subscription.routes.js';
import uploadRoutes          from './routes/uploadRoutes.js';

// Webhook handler — imported directly so it can receive raw body
import { handlePaystackWebhook } from './api/subscription.controller.js';

const app = express();

// ─── Trust proxy (required for Render / rate limiting) ────────────────────────
app.set('trust proxy', 1);

// ─── Webhook route — MUST be registered BEFORE express.json() ────────────────
// Paystack sends a raw Buffer; parsing it as JSON breaks the HMAC signature check.
app.post(
  '/api/subscriptions/webhook',
  express.raw({ type: 'application/json' }),
  handlePaystackWebhook,
);

// ─── Global middleware ────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Health / root ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ message: 'Vet Marketplace API is running', timestamp: new Date().toISOString() });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'OK', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ─── Rate limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: 'Too many requests, please try again later.',
});

const shopLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 100,
  message: 'Shop endpoint rate limit exceeded.',
});

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',                    authLimiter, authRoutes);
app.use('/api/v1/professionals',        professionalRoutes);     // ✅ FIXED - was missing
app.use('/api/v1/professionals',        vetRoutes);              // Vet routes
app.use('/api/v1/kennels',              kennelRoutes);
app.use('/api/v1/shops',                shopLimiter, shopRoutes);
app.use('/api/v1/vet-verification',     vetVerificationRoutes);
app.use('/api/subscriptions',           subscriptionRoutes);
app.use('/api/upload',                  uploadRoutes);

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', message: `Cannot ${req.method} ${req.url}` });
});

export default app;