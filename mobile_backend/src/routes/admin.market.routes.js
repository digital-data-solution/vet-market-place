import express from 'express';
import {
  getMarketStats,
  listReports,
  adminListListings,
  adminRemoveListing,
  dismissReport,
  backfillTelegram,
} from '../api/admin.market.controller.js';
import { adminProtect } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

router.use(adminProtect);

router.get('/stats',                    getMarketStats);
router.get('/reports',                  listReports);
router.get('/listings',                 adminListListings);
router.post('/listings/:id/remove',     adminRemoveListing);
router.post('/reports/:id/dismiss',     dismissReport);
router.post('/backfill-telegram',       backfillTelegram);

export default router;
