import express from 'express';
import { register, login, syncUser, getMe } from '../api/auth.controller.js';
import { protect } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.post('/register', register);
router.post('/login',    login);       // returns 410 — safe to remove later
router.post('/sync',     syncUser);    // called once after first Supabase login
router.get('/me',        protect, getMe); // ← ADDED: fixes 404

export default router;