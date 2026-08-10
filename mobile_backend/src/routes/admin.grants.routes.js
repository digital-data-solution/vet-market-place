import express from 'express';
import { grantBusinessAddon, lookupAccount, revokeBusinessAddon, largeAccounts, setEnterpriseHold, clearEnterpriseHold, setPlanTier, setEntitlements, clearEntitlements, setCustomPricing } from '../api/admin.grants.controller.js';
import { adminProtect } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();
router.use(adminProtect);

router.get('/lookup', lookupAccount);
router.post('/business', grantBusinessAddon);
router.post('/business/revoke', revokeBusinessAddon);

// Enterprise provisioning — module access (checkboxes) + negotiated price
router.post('/entitlements', setEntitlements);
router.post('/entitlements/clear', clearEntitlements);
router.post('/custom-price', setCustomPricing);

// Whale detection + stop
router.post('/plan', setPlanTier);
router.get('/large-accounts', largeAccounts);
router.post('/enterprise-hold', setEnterpriseHold);
router.post('/enterprise-hold/clear', clearEnterpriseHold);

export default router;
