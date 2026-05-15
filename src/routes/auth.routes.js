import express from 'express';
import { register, verifyOTP, login, loginWithPhone, verifyLoginOTP, syncUser } from '../api/auth.controller.js';

const router = express.Router();
// POST /api/auth/sync
router.post('/sync', syncUser);

// POST /api/auth/register
router.post('/register', register);

// POST /api/auth/verify-otp
router.post('/verify-otp', verifyOTP);

// POST /api/auth/login (email/password)
router.post('/login', login);

// POST /api/auth/login-phone (sends OTP)
router.post('/login-phone', loginWithPhone);

// POST /api/auth/verify-login-otp
router.post('/verify-login-otp', verifyLoginOTP);

export default router;