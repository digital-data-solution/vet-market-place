import express from 'express';
import {
  listSegments,
  createNotification,
  previewRecipientCount,
  listNotifications,
  listNotificationOpens,
  cancelNotification,
} from '../api/admin.notifications.controller.js';
import { adminProtect } from '../middlewares/adminAuthMiddleware.js';

const router = express.Router();

router.use(adminProtect);

router.get('/segments',        listSegments);
router.get('/preview-count',   previewRecipientCount);
router.get('/',                listNotifications);
router.get('/:id/opens',       listNotificationOpens);
router.post('/',               createNotification);
router.patch('/:id/cancel',    cancelNotification);

export default router;
