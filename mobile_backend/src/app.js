import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Routes
import authRoutes            from './routes/auth.routes.js';
import kennelRoutes          from './routes/kennel.routes.js';
import shopRoutes            from './routes/shop.routes.js';
import professionalRoutes    from './routes/professional.routes.js';
import vetVerificationRoutes from './routes/vetVerification.routes.js';
import subscriptionRoutes    from './routes/subscription.routes.js';
import featuredRoutes         from './routes/featured.routes.js';
import walletRoutes           from './routes/wallet.routes.js';
import uploadRoutes          from './routes/uploadRoutes.js';
import messagesRoutes        from './routes/messages.routes.js';
import adminProfessionalRoutes from './routes/admin.professional.js';
import adminWalletRoutes       from './routes/admin.wallet.routes.js';
import adminGrantsRoutes       from './routes/admin.grants.routes.js';
import emailRoutes             from './routes/email.routes.js';
import practiceRoutes          from './routes/practice.routes.js';
import businessRoutes          from './routes/business.routes.js';
import businessReportsRoutes   from './routes/business.reports.routes.js';
import reviewRoutes           from './routes/review.routes.js';
import supportRoutes          from './routes/support.routes.js';
import trackRoutes            from './routes/track.routes.js';
import upsellRoutes           from './routes/upsell.routes.js';
import marketRoutes           from './routes/market.routes.js';
import searchRoutes           from './routes/search.routes.js';
import jobBoardRoutes         from './routes/jobBoard.routes.js';
import adminMarketRoutes      from './routes/admin.market.routes.js';
import adminJobBoardRoutes    from './routes/admin.jobBoard.routes.js';
import adminNotificationsRoutes from './routes/admin.notifications.routes.js';
import notificationsRoutes    from './routes/notifications.routes.js';
import academyWebhookRoutes   from './routes/academyWebhook.routes.js';
import adminAcademyRoutes     from './routes/admin.academy.routes.js';

// Webhook handler — imported directly so it can receive raw body
import { handlePaystackWebhook } from './api/subscription.controller.js';
import { handleResendWebhook }  from './api/resendWebhook.controller.js';
import { regeocodeAll }          from './api/professional.controller.js';
import { adminProtect }          from './middlewares/adminAuthMiddleware.js';
import { supabaseAdmin }         from './lib/supabase.js';
import {
  getRevenueStats,
  getGrowthStats,
  getVerificationStats,
  getReferralStats,
  getPracticeStats,
  getBusinessStats,
  getContentStats,
  getGeographicStats,
  getMessagingStats,
  getEmailStats,
  listEmailLogs,
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
import Listing       from './models/Listing.js';

const app = express();

// ─── Trust proxy (required for Render / rate limiting) ────────────────────────
app.set('trust proxy', 1);

// ─── Webhook routes — MUST be registered BEFORE express.json() ───────────────
app.post(
  '/api/subscriptions/webhook',
  express.raw({ type: 'application/json' }),
  handlePaystackWebhook,
);
app.post(
  '/api/webhooks/resend',
  express.raw({ type: 'application/json' }),
  handleResendWebhook,
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
// Use absolute path so this works regardless of CWD (Render may start from repo root).
// index.html must never be cached; hashed JS/CSS bundles are safe to cache forever.
const PUBLIC_DIR = path.join(__dirname, '../public');

// Read index.html once at startup — avoids async sendFile edge cases and is faster.
let INDEX_HTML;
try {
  INDEX_HTML = readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
} catch {
  INDEX_HTML = null;
  console.error('[SPA] WARNING: public/index.html not found — page refreshes will 404');
}

app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// ─── SPA catch-all ────────────────────────────────────────────────────────────
// Must come RIGHT AFTER express.static and BEFORE any route or error handler so
// that every non-asset GET request (page refresh, deep link) receives index.html.
// Using res.send(INDEX_HTML) avoids the sendFile async-callback issues in Express 5.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (
    req.path.startsWith('/api/') ||
    req.path.startsWith('/l/') ||
    req.path === '/admin' ||
    req.path === '/health'
  ) return next();
  if (!INDEX_HTML) return next(new Error('index.html not found'));
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Content-Type', 'text/html; charset=utf-8');
  return res.send(INDEX_HTML);
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'OK', version: '8-spa-presend', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ─── Marketplace share preview (/l/:id) ───────────────────────────────────────
// A shareable short link that returns Open Graph tags so WhatsApp/Facebook/etc.
// show the listing's photo, title and price when the link is pasted. Human
// visitors are redirected into the web app. Crawlers read the meta and stop.
const WEB_APP_ORIGIN = process.env.WEB_APP_ORIGIN || 'https://xpressvetmarketplace.com';
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
app.get('/l/:id', async (req, res) => {
  const appUrl = `${WEB_APP_ORIGIN}/ListingDetail?id=${encodeURIComponent(req.params.id)}`;
  try {
    const listing = await Listing.findById(req.params.id).lean();
    if (!listing || listing.status === 'removed') {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.status(404).send(`<!doctype html><meta http-equiv="refresh" content="0;url=${esc(WEB_APP_ORIGIN)}">`);
    }
    const title = `${listing.title} — ₦${Number(listing.price).toLocaleString()}`;
    const desc  = (listing.description || 'For sale on Xpress Vet Marketplace.').slice(0, 180);
    const img   = listing.images?.[0]?.url || `${WEB_APP_ORIGIN}/favicon.png`;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="product">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:url" content="${esc(`${req.protocol}://${req.get('host')}/l/${listing._id}`)}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${esc(appUrl)}">
</head><body style="font-family:system-ui;text-align:center;padding:40px">
<p>Opening this listing on Xpress Vet…</p>
<p><a href="${esc(appUrl)}">Tap here if it doesn't open automatically</a></p>
</body></html>`);
  } catch {
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!doctype html><meta http-equiv="refresh" content="0;url=${esc(appUrl)}">`);
  }
});

// ─── Rate limiters ────────────────────────────────────────────────────────────
// authLimiter used to live here and wrap the ENTIRE /api/auth router — that
// meant every frequently-called, non-brute-forceable endpoint under it
// (sync, me, referral-info, push-token, web-push-subscription — all called
// on every single login) shared one 20-req/15min bucket per IP with actual
// login/register. Confirmed in production: routine use exhausted it and
// produced real 429s on /me and /web-push-subscription. Moved into
// routes/auth.routes.js, scoped to just the routes that do real credential
// work (register, admin/login).

const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user?._id?.toString() ?? req.ip,
  message: { success: false, message: 'Too many messages sent. Please wait a moment before trying again.' },
});

const listingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  message: { success: false, message: 'Too many listing requests. Please try again later.' },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user?._id?.toString() ?? req.ip,
  message: { success: false, message: 'Upload limit reached. Please wait before uploading more files.' },
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

// Reconcile the email-verified flag against Supabase (source of truth). Mongo's
// isVerified can be a stale "false" for users who actually confirmed their email
// (confirmation + first login happen in the same instant, so the token that
// syncUser saw didn't carry the confirmation, and they never logged in again).
// This ONLY ever flips false -> true where Supabase confirms it — never the
// reverse — so nobody is un-verified by running it.
app.post('/api/admin/users/resync-verification', adminProtect, async (req, res) => {
  try {
    const users = await User.find({ isVerified: { $ne: true }, supabaseId: { $ne: null } })
      .select('_id supabaseId email').limit(1000).lean();
    let checked = 0, fixed = 0;
    for (const u of users) {
      if (!u.supabaseId) continue;
      checked++;
      try {
        const { data, error } = await supabaseAdmin.auth.admin.getUserById(u.supabaseId);
        if (error) continue;
        if (data?.user?.email_confirmed_at) {
          await User.updateOne({ _id: u._id }, { $set: { isVerified: true } });
          fixed++;
        }
      } catch { /* skip this one, keep going */ }
    }
    return res.json({ success: true, message: `Checked ${checked} unverified account(s); corrected ${fixed} that were already confirmed in Supabase.`, data: { checked, fixed } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Re-sync failed.' });
  }
});

// Grant / extend subscription manually
app.post('/api/admin/users/:id/grant-subscription', adminProtect, async (req, res) => {
  try {
    const { days = 30, plan = 'user_premium' } = req.body;
    const d = Math.max(1, Math.min(365, parseInt(days, 10)));
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    const now = new Date();
    const base = user.subscription?.endDate && user.subscription?.status === 'active' && user.subscription.endDate > now
      ? new Date(user.subscription.endDate)
      : now;
    const newEnd = new Date(base.getTime() + d * 86400000);
    await User.findByIdAndUpdate(req.params.id, {
      $set: {
        'subscription.plan': plan,
        'subscription.status': 'active',
        'subscription.startDate': now,
        'subscription.endDate': newEnd,
        'subscription.isActive': true,
      },
    });
    return res.json({ success: true, message: `Subscription granted: ${d} days (expires ${newEnd.toLocaleDateString('en-NG')}).` });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Export users to CSV
app.get('/api/admin/export/users', adminProtect, async (req, res) => {
  try {
    const { role } = req.query;
    const filter = role ? { role } : {};
    const users = await User.find(filter).select('name email phone role isVerified createdAt').sort({ createdAt: -1 }).lean();
    const rows = [
      'Name,Email,Phone,Role,Verified,Joined',
      ...users.map(u => [
        (u.name || '').replace(/,/g, ' '),
        u.email || '',
        u.phone || '',
        u.role || '',
        u.isVerified ? 'Yes' : 'No',
        u.createdAt ? new Date(u.createdAt).toISOString().slice(0, 10) : '',
      ].join(',')),
    ];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="xpressvet-users.csv"');
    return res.send(rows.join('\n'));
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
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
app.get('/api/admin/stats/practice',     adminProtect, getPracticeStats);
app.get('/api/admin/stats/business',     adminProtect, getBusinessStats);
app.get('/api/admin/stats/content',      adminProtect, getContentStats);
app.get('/api/admin/stats/geographic',   adminProtect, getGeographicStats);
app.get('/api/admin/stats/messaging',    adminProtect, getMessagingStats);
app.get('/api/admin/stats/email',        adminProtect, getEmailStats);
app.get('/api/admin/email-logs',         adminProtect, listEmailLogs);
app.get('/api/admin/stats/system',       adminProtect, getSystemHealth);
app.get('/api/admin/stats/activity',     adminProtect, getActivityStats);
app.get('/api/admin/stats/utm',          adminProtect, getUtmStats);
app.post('/api/admin/regeocode',         adminProtect, regeocodeAll);
app.get('/api/admin/export/users',          adminProtect, exportUsers);
app.get('/api/admin/export/subscriptions',  adminProtect, exportSubscriptions);
app.get('/api/admin/export/professionals',  adminProtect, exportProfessionals);

// ─── API routes ───────────────────────────────────────────────────────────────
app.use('/api/admin/professionals', adminProfessionalRoutes);
app.use('/api/admin/wallet',        adminWalletRoutes);
app.use('/api/admin/grants',        adminGrantsRoutes);
app.use('/api/email',               emailRoutes);
app.use('/api/v1/practice',         practiceRoutes);
app.use('/api/v1/business/reports', businessReportsRoutes);
app.use('/api/v1/business',         businessRoutes);
app.use('/api/auth',                authRoutes);
app.use('/api/v1/professionals',    listingLimiter, professionalRoutes);
app.use('/api/v1/kennels',          listingLimiter, kennelRoutes);
app.use('/api/v1/shops',            listingLimiter, shopRoutes);
app.use('/api/v1/vet-verification', vetVerificationRoutes);
app.use('/api/subscriptions',       subscriptionRoutes);
app.use('/api/v1/featured',         featuredRoutes);
app.use('/api/v1/wallet',           walletRoutes);
app.use('/api/upload',              uploadLimiter, uploadRoutes);
app.use('/api/messages',            messageLimiter, messagesRoutes);
app.use('/api/v1/reviews',          reviewRoutes);
app.use('/api/support',             supportRoutes);
app.use('/api/v1/track',            trackRoutes);
app.use('/api/v1/upsell',           upsellRoutes);
app.use('/api/v1/market',           listingLimiter, marketRoutes);
app.use('/api/v1/search',           listingLimiter, searchRoutes);
app.use('/api/v1/jobs',             listingLimiter, jobBoardRoutes);
app.use('/api/admin/market',        adminMarketRoutes);
app.use('/api/admin/jobs',          adminJobBoardRoutes);
app.use('/api/admin/notifications', adminNotificationsRoutes);
app.use('/api/notifications',       notificationsRoutes);
app.use('/api/webhooks/academy',    academyWebhookRoutes);
app.use('/api/admin/academy',       adminAcademyRoutes);

// ─── Client-side error reporting ─────────────────────────────────────────────
// No auth required — errors may fire before the user is authenticated.
// Rate-limited to 5 reports per IP per 15 min to prevent abuse.
const errorReportLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
app.post('/api/v1/report-error', errorReportLimiter, async (req, res) => {
  try {
    const { error, stack, platform, url, userId } = req.body ?? {};
    if (!error) return res.status(400).json({ success: false });
    const { sendEmail } = await import('./services/email.service.js');
    const ADMIN_EMAIL   = process.env.ADMIN_EMAIL || 'contact@xpressdigitalanddatasolutions.online';
    await sendEmail(
      ADMIN_EMAIL,
      `[Xpress Vet] App crash reported — ${platform || 'unknown platform'}`,
      `<h2>Client-side error</h2>
       <p><strong>Error:</strong> ${String(error).replace(/</g, '&lt;')}</p>
       <p><strong>Platform:</strong> ${platform || 'unknown'}</p>
       ${url ? `<p><strong>URL:</strong> ${String(url).replace(/</g, '&lt;')}</p>` : ''}
       ${userId ? `<p><strong>User ID:</strong> ${String(userId).replace(/</g, '&lt;')}</p>` : ''}
       ${stack ? `<pre style="background:#f3f4f6;padding:12px;border-radius:8px;font-size:12px;overflow:auto">${String(stack).replace(/</g, '&lt;')}</pre>` : ''}
       <p style="color:#94A3B8;font-size:12px">Sent automatically from NavigationErrorBoundary</p>`,
    ).catch(() => {});
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false });
  }
});

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

// ─── 404 fallback ────────────────────────────────────────────────────────────
// Only reached for non-GET requests or /api/ paths not handled by any route.
// GET requests are already handled by the SPA catch-all above.
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', message: `Cannot ${req.method} ${req.url}` });
});

export default app;