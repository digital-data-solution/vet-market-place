import express from 'express';
import {
  listDisputes,
  adminReleaseDispute,
  adminRefundDispute,
} from '../api/admin.wallet.controller.js';
import { adminProtect, requireModule, requireModuleRead } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

router.use(adminProtect);

router.get('/disputes',                  requireModuleRead('wallet'), listDisputes);
router.post('/disputes/:id/release',     requireModule('wallet'), adminReleaseDispute);
router.post('/disputes/:id/refund',      requireModule('wallet'), adminRefundDispute);

export default router;
