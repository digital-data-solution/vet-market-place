import express from 'express';
import { register, login, syncUser } from '../api/auth.controller.js';

const router = express.Router();

router.post('/register', register);
router.post('/login', login);         // returns 410 — safe to remove later
router.post('/sync', syncUser);       // called once after first Supabase login

export default router;