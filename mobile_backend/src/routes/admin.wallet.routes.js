import express from 'express';
import {
  listDisputes,
  adminReleaseDispute,
  adminRefundDispute,
} from '../api/admin.wallet.controller.js';
import { adminProtect } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

router.use(adminProtect);

router.get('/disputes',                  listDisputes);
router.post('/disputes/:id/release',     adminReleaseDispute);
router.post('/disputes/:id/refund',      adminRefundDispute);

export default router;
