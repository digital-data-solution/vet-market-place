import express from 'express';

// Supabase-based auth (regular users: pet owners, vets, kennel owners)
import { register, login, syncUser, getMe, updateProfile, getReferralInfo, getPublicProfile, savePushToken } from '../api/auth.controller.js';

// JWT-based auth (admin dashboard only)
import {
  login          as adminLogin,
  logout         as adminLogout,
  register       as adminRegister,
  refreshToken   as adminRefreshToken,
  getCurrentUser as adminGetCurrentUser,
  changePassword as adminChangePassword,
  verifyTokenEndpoint as adminVerifyToken,
} from '../api/admin.auth.controller.js';

import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

// ─── Regular user routes (Supabase) ──────────────────────────────────────────
router.post('/register', register);
router.post('/login',    login);       // returns 410 — safe to remove later
router.post('/sync',     syncUser);    // called once after first Supabase login
router.get('/me',            protect, getMe);
router.get('/referral-info',           protect, getReferralInfo);
router.get('/public-profile/:supabaseId', protect, getPublicProfile);
router.put('/update-profile',          protect, updateProfile);
router.post('/push-token',             protect, savePushToken);

// ─── Admin JWT routes ─────────────────────────────────────────────────────────
router.post('/admin/register',        adminRegister);
router.post('/admin/login',           adminLogin);
router.post('/admin/logout',          adminLogout);
router.post('/admin/refresh',         adminRefreshToken);
router.post('/admin/verify',          adminVerifyToken);
router.get('/admin/me',               adminGetCurrentUser);
router.post('/admin/change-password', adminChangePassword);

export default router;