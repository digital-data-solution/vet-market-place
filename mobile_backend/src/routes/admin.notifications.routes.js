import express from 'express';
import {
  listSegments,
  createNotification,
  previewRecipientCount,
  listNotifications,
  listNotificationOpens,
  cancelNotification,
} from '../api/admin.notifications.controller.js';
import { adminProtect, requireModule, requireModuleRead, requireAnyModule } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

router.use(adminProtect);

// Shared segment registry — also consumed by the Email Campaigns and Blog
// Broadcast composers (both call this same endpoint to populate their
// segment dropdown), so it accepts any of the three modules rather than
// just 'notifications'. Deliberately 'blog_broadcast', not plain 'blog' —
// see config/adminModules.js. See requireAnyModule's doc comment.
router.get('/segments',        requireAnyModule('notifications', 'emailcampaigns', 'blog_broadcast'), listSegments);
router.get('/preview-count',   requireModuleRead('notifications'), previewRecipientCount);
router.get('/',                requireModuleRead('notifications'), listNotifications);
router.get('/:id/opens',       requireModuleRead('notifications'), listNotificationOpens);
router.post('/',               requireModule('notifications'), createNotification);
router.patch('/:id/cancel',    requireModule('notifications'), cancelNotification);

export default router;
