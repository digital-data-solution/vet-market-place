import express from 'express';
import { requirePartnerSecret, listProfessionalsForCallAssignment } from '../api/partner.controller.js';

const router = express.Router();

// Server-to-server only, authenticated by X-Partner-Secret (not a user
// session) — same pattern as routes/academyWebhook.routes.js. Applied to
// every route in this file since everything under /api/partner is meant
// for trusted sibling platforms, not the mobile app or the public web.
router.use(requirePartnerSecret);

router.get('/professionals', listProfessionalsForCallAssignment);

export default router;
