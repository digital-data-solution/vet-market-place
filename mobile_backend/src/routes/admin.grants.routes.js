import express from 'express';
import { grantBusinessAddon, lookupAccount, revokeBusinessAddon, largeAccounts, setEnterpriseHold, clearEnterpriseHold, setPlanTier, setEntitlements, clearEntitlements, setCustomPricing } from '../api/admin.grants.controller.js';
import { adminProtect, requireModule, requireModuleRead } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();
router.use(adminProtect);
// Account-level grants/entitlements — same 'users' module as the Users tab.

router.get('/lookup', requireModuleRead('users'), lookupAccount);
router.post('/business', requireModule('users'), grantBusinessAddon);
router.post('/business/revoke', requireModule('users'), revokeBusinessAddon);

// Enterprise provisioning — module access (checkboxes) + negotiated price
router.post('/entitlements', requireModule('users'), setEntitlements);
router.post('/entitlements/clear', requireModule('users'), clearEntitlements);
router.post('/custom-price', requireModule('users'), setCustomPricing);

// Whale detection + stop
router.post('/plan', requireModule('users'), setPlanTier);
router.get('/large-accounts', requireModuleRead('users'), largeAccounts);
router.post('/enterprise-hold', requireModule('users'), setEnterpriseHold);
router.post('/enterprise-hold/clear', requireModule('users'), clearEnterpriseHold);

export default router;
