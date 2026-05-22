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
import { handlePaystackWebhook, getSubscriptionStats } from './api/subscription.controller.js';
import { listPendingVets, reviewVet }                  from './api/vetVerification.controller.js';
import { adminProtect }                                from './middlewares/adminAuthMiddleware.js';

// Models used in inline admin stats handler
import Professional from './models/Professional.js';
import User         from './models/User.js';

const app = express();

// ─── Trust proxy (required for Render / rate limiting) ────────────────────────
app.set('trust proxy', 1);

// ─── Webhook route — MUST be registered BEFORE express.json() ────────────────
app.post(
  '/api/subscriptions/webhook',
  express.raw({ type: 'application/json' }),
  handlePaystackWebhook,
);

// ─── Global middleware ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:"],
      connectSrc: ["'self'", "https://vet-market-place-jsj5.onrender.com"],
    },
  },
}));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Serve static files (admin dashboard, etc.) ──────────────────────────────
app.use(express.static('public'));

// ─── Health / root ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ message: 'Vet Marketplace API is running', timestamp: new Date().toISOString() });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'OK', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ─── Rate limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many requests, please try again later.',
});

const shopLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  message: 'Shop endpoint rate limit exceeded.',
});

// ─── Admin-only routes (JWT protected) ───────────────────────────────────────

// Professional / vet stats for dashboard
app.get('/api/admin/stats/professionals', adminProtect, async (req, res) => {
  try {
    const [totalVets, pendingVets, totalKennels] = await Promise.all([
      Professional.countDocuments({ role: 'vet' }),
      User.countDocuments({ role: 'vet', 'vetVerification.status': 'pending' }),
      Professional.countDocuments({ role: 'kennel' }),
    ]);

    return res.json({
      success: true,
      data: {
        vets:    { total: totalVets,    pending: pendingVets },
        kennels: { total: totalKennels },
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
  }
});

// Subscription stats for dashboard
app.get('/api/admin/stats/subscriptions', adminProtect, getSubscriptionStats);

// Pending vet verifications list
app.get('/api/admin/vets/pending', adminProtect, listPendingVets);

// Review (approve / reject) a vet
app.post('/api/admin/vets/review/:id', adminProtect, reviewVet);

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',                authLimiter, authRoutes);
app.use('/api/v1/professionals',    professionalRoutes);
app.use('/api/v1/professionals',    vetRoutes);
app.use('/api/v1/kennels',          kennelRoutes);
app.use('/api/v1/shops',            shopLimiter, shopRoutes);
app.use('/api/v1/vet-verification', vetVerificationRoutes);
app.use('/api/subscriptions',       subscriptionRoutes);
app.use('/api/upload',              uploadRoutes);

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', message: `Cannot ${req.method} ${req.url}` });
});

export default app;