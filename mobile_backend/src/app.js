import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Routes
import authRoutes            from './routes/auth.routes.js';
import kennelRoutes          from './routes/kennel.routes.js';
import shopRoutes            from './routes/shop.routes.js';
import professionalRoutes    from './routes/professional.routes.js';
import vetVerificationRoutes from './routes/vetVerification.routes.js';
import subscriptionRoutes    from './routes/subscription.routes.js';
import uploadRoutes          from './routes/uploadRoutes.js';
import messagesRoutes        from './routes/messages.routes.js';
import adminProfessionalRoutes from './routes/admin.professional.js';
import reviewRoutes           from './routes/review.routes.js';
import supportRoutes          from './routes/support.routes.js';
import trackRoutes            from './routes/track.routes.js';
import upsellRoutes           from './routes/upsell.routes.js';

// Webhook handler — imported directly so it can receive raw body
import { handlePaystackWebhook } from './api/subscription.controller.js';
import { listPendingVets, reviewVet }                  from './api/vetVerification.controller.js';
import { adminProtect }                                from './middlewares/adminAuthMiddleware.js';
import {
  getRevenueStats,
  getGrowthStats,
  getVerificationStats,
  getReferralStats,
  getContentStats,
  getGeographicStats,
  getMessagingStats,
  getSystemHealth,
  getActivityStats,
  getUtmStats,
  exportUsers,
  exportSubscriptions,
  exportProfessionals,
} from './api/admin.stats.controller.js';

// Models used in admin routes
import Professional  from './models/Professional.js';
import User          from './models/User.js';
import Shop          from './models/Shop.js';
import Subscription  from './models/Subscription.js';
import SupportThread from './models/SupportThread.js';

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
      scriptSrcAttr: ["'unsafe-inline'"],
      connectSrc: [
        "'self'",
        "blob:",
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
// index.html must never be cached (content changes on each web build).
// Hashed JS/CSS bundles (/_expo/static/...) are safe to cache forever.
app.use(express.static('public', {
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// ─── Health / root ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ message: 'Vet Marketplace API is running', version: '2', timestamp: new Date().toISOString() });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'OK', version: '6-spa-fixed', uptime: process.uptime(), timestamp: new Date().toISOString() });
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

const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user?._id?.toString() ?? req.ip,
  message: { success: false, message: 'Too many messages sent. Please wait a moment before trying again.' },
});

// ─── Admin dashboard HTML (served outside public/ so it survives web builds) ─
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin-dashboard.html')));

// ─── Admin-only routes ────────────────────────────────────────────────────────

// Stats
app.get('/api/admin/stats/professionals', adminProtect, async (req, res) => {
  try {
    const [roleBreakdown, pendingVets, pendingInsurance] = await Promise.all([
      Professional.aggregate([
        { $group: { _id: '$role', total: { $sum: 1 }, verified: { $sum: { $cond: ['$isVerified', 1, 0] } } } },
        { $sort: { total: -1 } },
      ]),
      Professional.countDocuments({ role: 'vet',                verificationStatus: 'pending' }),
      Professional.countDocuments({ role: 'insurance_provider', verificationStatus: 'pending' }),
    ]);

    const byRole = {};
    for (const r of roleBreakdown) byRole[r._id] = r;

    return res.json({
      success: true,
      data: {
        roleBreakdown,
        vets:               { total: byRole.vet?.total || 0,    pending: pendingVets    },
        kennels:            { total: byRole.kennel?.total || 0  },
        insurance_providers:{ total: byRole.insurance_provider?.total || 0, pending: pendingInsurance },
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
  }
});

app.get('/api/admin/stats/subscriptions', adminProtect, async (req, res) => {
  try {
    const now = new Date();
    const [totalUsers, activeSubscriptions, shops] = await Promise.all([
      User.countDocuments(),
      Subscription.countDocuments({ status: 'active', endDate: { $gte: now } }),
      Shop.countDocuments(),
    ]);
    const revAgg = await Subscription.aggregate([
      { $match: { status: 'active', endDate: { $gte: now } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const monthlyRevenue = revAgg[0]?.total || 0;
    return res.json({ success: true, data: { totalUsers, activeSubscriptions, monthlyRevenue, totalShops: shops } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
  }
});

app.get('/api/admin/vets/pending',        adminProtect, listPendingVets);
app.post('/api/admin/vets/review/:id',    adminProtect, reviewVet);

// Users
app.get('/api/admin/users', adminProtect, async (req, res) => {
  try {
    const { page = 1, limit = 30, role, search } = req.query;
    const filter = {};
    if (role) filter.role = role;
    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [{ name: re }, { email: re }];
    }
    const [data, total] = await Promise.all([
      User.find(filter).select('-password').sort({ createdAt: -1 })
        .skip((+page - 1) * +limit).limit(+limit).lean(),
      User.countDocuments(filter),
    ]);
    return res.json({ success: true, data, total, page: +page, totalPages: Math.ceil(total / +limit) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch users.' });
  }
});

app.put('/api/admin/users/:id/role', adminProtect, async (req, res) => {
  try {
    const { role } = req.body;
    const allowed = ['pet_owner', 'vet', 'kennel_owner', 'shop_owner', 'admin'];
    if (!allowed.includes(role)) return res.status(400).json({ success: false, message: 'Invalid role.' });
    const user = await User.findByIdAndUpdate(req.params.id, { $set: { role } }, { returnDocument: 'after' }).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    return res.json({ success: true, data: user });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update role.' });
  }
});

app.delete('/api/admin/users/:id', adminProtect, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    return res.json({ success: true, message: 'User deleted.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to delete user.' });
  }
});

// Shops
app.get('/api/admin/shops', adminProtect, async (req, res) => {
  try {
    const data = await Shop.find().populate('owner', 'name email').sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch shops.' });
  }
});

app.delete('/api/admin/shops/:id', adminProtect, async (req, res) => {
  try {
    const shop = await Shop.findByIdAndDelete(req.params.id);
    if (shop?.owner) await User.findByIdAndUpdate(shop.owner, { $set: { role: 'pet_owner' } });
    return res.json({ success: true, message: 'Shop deleted.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to delete shop.' });
  }
});

// Subscriptions
app.get('/api/admin/subscriptions', adminProtect, async (req, res) => {
  try {
    const data = await Subscription.find().populate('user', 'name email role').sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch subscriptions.' });
  }
});

app.delete('/api/admin/subscriptions/:id', adminProtect, async (req, res) => {
  try {
    const sub = await Subscription.findByIdAndUpdate(req.params.id, { $set: { status: 'cancelled' } }, { returnDocument: 'after' });
    if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found.' });
    return res.json({ success: true, message: 'Subscription cancelled.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to cancel subscription.' });
  }
});

// ─── Admin support routes ─────────────────────────────────────────────────────

// List all support threads (sorted by latest message)
app.get('/api/admin/support', adminProtect, async (req, res) => {
  try {
    const { status, limit = 50, page = 1 } = req.query;
    const filter = {};
    if (status && ['open', 'resolved'].includes(status)) filter.status = status;
    const [data, total] = await Promise.all([
      SupportThread.find(filter).sort({ lastMessageAt: -1 })
        .skip((+page - 1) * +limit).limit(+limit).lean(),
      SupportThread.countDocuments(filter),
    ]);
    return res.json({ success: true, data, total });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch threads.' });
  }
});

// Admin replies to a thread
app.post('/api/admin/support/:threadId/reply', adminProtect, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ success: false, message: 'Reply text required.' });

    const thread = await SupportThread.findByIdAndUpdate(
      req.params.threadId,
      {
        $push: { messages: { text: text.trim(), senderRole: 'admin' } },
        $set:  { lastMessageAt: new Date(), status: 'open' },
      },
      { new: true },
    );
    if (!thread) return res.status(404).json({ success: false, message: 'Thread not found.' });

    return res.json({ success: true, data: thread });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to send reply.' });
  }
});

// Admin marks thread as resolved
app.patch('/api/admin/support/:threadId/resolve', adminProtect, async (req, res) => {
  try {
    const thread = await SupportThread.findByIdAndUpdate(
      req.params.threadId,
      { $set: { status: 'resolved' } },
      { new: true },
    );
    if (!thread) return res.status(404).json({ success: false, message: 'Thread not found.' });
    return res.json({ success: true, data: thread });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to resolve thread.' });
  }
});

// ─── Admin BI stats routes ────────────────────────────────────────────────────
app.get('/api/admin/stats/revenue',      adminProtect, getRevenueStats);
app.get('/api/admin/stats/growth',       adminProtect, getGrowthStats);
app.get('/api/admin/stats/verification', adminProtect, getVerificationStats);
app.get('/api/admin/stats/referrals',    adminProtect, getReferralStats);
app.get('/api/admin/stats/content',      adminProtect, getContentStats);
app.get('/api/admin/stats/geographic',   adminProtect, getGeographicStats);
app.get('/api/admin/stats/messaging',    adminProtect, getMessagingStats);
app.get('/api/admin/stats/system',       adminProtect, getSystemHealth);
app.get('/api/admin/stats/activity',     adminProtect, getActivityStats);
app.get('/api/admin/stats/utm',          adminProtect, getUtmStats);
app.get('/api/admin/export/users',          adminProtect, exportUsers);
app.get('/api/admin/export/subscriptions',  adminProtect, exportSubscriptions);
app.get('/api/admin/export/professionals',  adminProtect, exportProfessionals);

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/admin/professionals', adminProfessionalRoutes);
app.use('/api/auth',                authLimiter, authRoutes);
app.use('/api/v1/professionals',    professionalRoutes);   // ✅ single registration
app.use('/api/v1/kennels',          kennelRoutes);
app.use('/api/v1/shops',            shopLimiter, shopRoutes);
app.use('/api/v1/vet-verification', vetVerificationRoutes);
app.use('/api/subscriptions',       subscriptionRoutes);
app.use('/api/upload',              uploadRoutes);
app.use('/api/messages',            messageLimiter, messagesRoutes);
app.use('/api/v1/reviews',          reviewRoutes);
app.use('/api/support',             supportRoutes);
app.use('/api/v1/track',            trackRoutes);
app.use('/api/v1/upsell',           upsellRoutes);

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

// ─── SPA catch-all ────────────────────────────────────────────────────────────
// app.use() avoids path-to-regexp v8 wildcard syntax (Express 5 broke app.get('*')).
// Only serves index.html for GET requests not matched by any API or static route.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/') || req.path === '/admin' || req.path === '/health') {
    return next();
  }
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── 404 fallback (API routes only) ──────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', message: `Cannot ${req.method} ${req.url}` });
});

export default app;