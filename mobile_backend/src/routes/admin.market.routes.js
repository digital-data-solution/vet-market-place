import express from 'express';
import {
  getMarketStats,
  listReports,
  adminListListings,
  adminRemoveListing,
  dismissReport,
  backfillTelegram,
  backfillWhatsAppDrafts,
} from '../api/admin.market.controller.js';
import { adminProtect, requireModule, requireModuleRead } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

router.use(adminProtect);

router.get('/stats',                    requireModuleRead('marketplace'), getMarketStats);
router.get('/reports',                  requireModuleRead('marketplace'), listReports);
router.get('/listings',                 requireModuleRead('marketplace'), adminListListings);
router.post('/listings/:id/remove',     requireModule('marketplace'), adminRemoveListing);
router.post('/reports/:id/dismiss',     requireModule('marketplace'), dismissReport);
router.post('/backfill-telegram',       requireModule('marketplace'), backfillTelegram);
router.post('/backfill-whatsapp-drafts', requireModule('marketplace'), backfillWhatsAppDrafts);

export default router;
