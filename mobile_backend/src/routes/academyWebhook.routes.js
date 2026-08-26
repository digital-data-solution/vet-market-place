import express from 'express';
import { handleVetCoursePublished } from '../api/academyWebhook.controller.js';

const router = express.Router();

// No adminProtect here on purpose — this is a server-to-server call from the
// Academy, authenticated by the X-Webhook-Secret header instead of a user
// session. Standard express.json() body parsing is fine (no HMAC-over-raw-body
// needed here, unlike the Paystack/Resend webhooks).
router.post('/vet-course-published', handleVetCoursePublished);

export default router;
