import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';

// Routes
import vetRoutes from './routes/vet.routes.js';
import authRoutes from './routes/auth.routes.js';
import subscriptionRoutes from './routes/subscription.routes.js';
// Add this import alongside your other route imports in app.js or server.js:
import kennelRoutes from './routes/kennel.routes.js';
import vetVerificationRoutes from './routes/vetVerification.routes.js';
import shopRoutes from './routes/shop.routes.js';
import professionalRoutes from './routes/professional.routes.js';
import cache from './lib/cache.js';
import { uploadToCloudinary } from './lib/cloudinaryUpload.js';
import { protect } from './middlewares/authMiddleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();
// Fix: Trust proxy for rate limiting and X-Forwarded-For headers (Render, Vercel, etc)
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic routes
app.get('/', (req, res) => {
  res.json({ message: 'Express Backend API is running', timestamp: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Rate limiters
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many requests, try later.' });
const shopLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 100, message: 'Shop endpoint rate limit exceeded.' });

// Mount API routes with appropriate throttling
app.use('/api/v1/professionals', vetRoutes);
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/v1/vet-verification', vetVerificationRoutes);
app.use('/api/v1/shops', shopLimiter, shopRoutes);
app.use('/api/v1/professional', professionalRoutes);
// Then mount it alongside your other routes:
app.use('/api/v1/kennels', kennelRoutes);

// initialize optional redis cache
cache.initCache().catch(() => {});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', message: `Cannot ${req.method} ${req.url}` });
});

export default app;




