import express from 'express';
import rateLimit from 'express-rate-limit';

// Supabase-based auth (regular users: pet owners, vets, kennel owners)
import { register, login, syncUser, getMe, updateProfile, getReferralInfo, getPublicProfile, savePushToken, saveWebPushSubscription } from '../api/auth.controller.js';

// JWT-based auth (admin dashboard only)
import {
  login          as adminLogin,
  loginTwoFactor as adminLoginTwoFactor,
  logout         as adminLogout,
  register       as adminRegister,
  refreshToken   as adminRefreshToken,
  getCurrentUser as adminGetCurrentUser,
  changePassword as adminChangePassword,
  verifyTokenEndpoint as adminVerifyToken,
  setupTwoFactor   as adminSetupTwoFactor,
  confirmTwoFactor as adminConfirmTwoFactor,
  disableTwoFactor as adminDisableTwoFactor,
} from '../api/admin.auth.controller.js';

import { protect } from '../middlewares/authMiddleware.js';
import { adminProtect, requireOwner } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

// Only for endpoints that do real credential work (account creation,
// password-based login) — genuinely brute-forceable / spam-able. Deliberately
// NOT applied to the rest of this router (sync, me, referral-info,
// push-token, web-push-subscription, etc.) — those are called on every
// single login/app-open and previously shared this same tight bucket,
// which produced real 429s in production under completely normal use.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

// ─── Regular user routes (Supabase) ──────────────────────────────────────────
router.post('/register', credentialLimiter, register);
router.post('/login',    login);       // returns 410 — safe to remove later
router.post('/sync',     syncUser);    // called once after first Supabase login
router.get('/me',            protect, getMe);
router.get('/referral-info',           protect, getReferralInfo);
router.get('/public-profile/:supabaseId', protect, getPublicProfile);
router.put('/update-profile',          protect, updateProfile);
router.post('/push-token',             protect, savePushToken);
router.post('/web-push-subscription',  protect, saveWebPushSubscription);

// ─── Admin JWT routes ─────────────────────────────────────────────────────────
// Owner only — grants full (unscoped) owner-tier admin access to an
// account, a different and much bigger thing than granting a staff account
// specific modules (see admin.staff.routes.js for that).
router.post('/admin/register',        adminProtect, requireOwner, adminRegister);
router.post('/admin/login',           credentialLimiter, adminLogin); // previously had no rate limit at all
router.post('/admin/login/2fa',       credentialLimiter, adminLoginTwoFactor); // brute-forceable 6-digit code — same bucket as login
router.post('/admin/logout',          adminLogout);
router.post('/admin/refresh',         adminRefreshToken);
router.post('/admin/verify',          adminVerifyToken);
router.get('/admin/me',               adminGetCurrentUser);
router.post('/admin/change-password', adminChangePassword);

// Self-service 2FA management — any authenticated admin (owner or staff)
// manages their OWN 2FA regardless of granted modules, so adminProtect
// alone is the right gate here (no requireModule).
router.post('/admin/2fa/setup',   adminProtect, adminSetupTwoFactor);
router.post('/admin/2fa/confirm', adminProtect, adminConfirmTwoFactor);
router.post('/admin/2fa/disable', adminProtect, adminDisableTwoFactor);

export default router;