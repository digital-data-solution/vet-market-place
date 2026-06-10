import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

// Routes
import authRoutes            from './routes/auth.routes.js';
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
      imgSrc:     ["'self'", "data:", "https://res.cloudinary.com", "https://vmzbvaybnohfxfkrungj.supabase.co"],
      connectSrc: [
        "'self'",
        "https://xpressvetmarketplace.com",
        "https://vet-market-place-jsj5.onrender.com",
        "https://vmzbvaybnohfxfkrungj.supabase.co",
        "wss://vmzbvaybnohfxfkrungj.supabase.co",
        "https://api.resend.com",
      ],
    },
  },
}));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Serve static files ───────────────────────────────────────────────────────
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

// ─── Admin-only routes ────────────────────────────────────────────────────────
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
        vets:    { total: totalVets, pending: pendingVets },
        kennels: { total: totalKennels },
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
  }
});

app.get('/api/admin/stats/subscriptions', adminProtect, getSubscriptionStats);
app.get('/api/admin/vets/pending', adminProtect, listPendingVets);
app.post('/api/admin/vets/review/:id', adminProtect, reviewVet);

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',                authLimiter, authRoutes);
app.use('/api/v1/professionals',    professionalRoutes);   // ✅ single registration
app.use('/api/v1/kennels',          kennelRoutes);
app.use('/api/v1/shops',            shopLimiter, shopRoutes);
app.use('/api/v1/vet-verification', vetVerificationRoutes);
app.use('/api/subscriptions',       subscriptionRoutes);
app.use('/api/upload',              uploadRoutes);

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Global error:', err);

  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map(e => e.message);
    return res.status(400).json({
      success: false,
      error: 'Validation Error',
      message: messages.join(', '),
      details: messages,
    });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      error: 'Invalid ID',
      message: `Invalid ${err.kind}: ${err.value}`,
    });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    return res.status(400).json({
      success: false,
      error: 'Duplicate Entry',
      message: `A record with this ${field} already exists.`,
    });
  }

  if (err.name === 'MulterError') {
    const messages = {
      'LIMIT_FILE_SIZE': 'File is too large. Maximum size is 5MB.',
      'FILE_TOO_LARGE':  'File is too large. Maximum size is 5MB.',
      'LIMIT_FILE_COUNT': 'Too many files uploaded.',
    };
    return res.status(400).json({
      success: false,
      error: 'File Upload Error',
      message: messages[err.code] || err.message,
    });
  }

  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      error: 'Invalid Token',
      message: 'Your session is invalid or expired. Please log in again.',
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      error: 'Session Expired',
      message: 'Your session has expired. Please log in again.',
    });
  }

  if (err.statusCode) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.error || 'Error',
      message: err.message,
    });
  }

  res.status(500).json({
    success: false,
    error: 'Server Error',
    message: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred. Please try again later.'
      : err.message,
  });
});

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', message: `Cannot ${req.method} ${req.url}` });
});

export default app;