import express from 'express';
import { grantBusinessAddon, lookupAccount, revokeBusinessAddon, largeAccounts, setEnterpriseHold, clearEnterpriseHold } from '../api/admin.grants.controller.js';
import { adminProtect } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();
router.use(adminProtect);

router.get('/lookup', lookupAccount);
router.post('/business', grantBusinessAddon);
router.post('/business/revoke', revokeBusinessAddon);

// Whale detection + stop
router.get('/large-accounts', largeAccounts);
router.post('/enterprise-hold', setEnterpriseHold);
router.post('/enterprise-hold/clear', clearEnterpriseHold);

export default router;
