import express from 'express';
import { grantBusinessAddon, lookupAccount, revokeBusinessAddon } from '../api/admin.grants.controller.js';
import { adminProtect } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();
router.use(adminProtect);

router.get('/lookup', lookupAccount);
router.post('/business', grantBusinessAddon);
router.post('/business/revoke', revokeBusinessAddon);

export default router;
