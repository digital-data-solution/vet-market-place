import express from 'express';
import { listPublishedVideos, getVideoById, recordView } from '../api/helpVideos.controller.js';

const router = express.Router();

// Public — no adminProtect. Mounted at /api/v1/help-videos in app.js.
router.get('/', listPublishedVideos);
router.get('/:id', getVideoById);
router.post('/:id/view', recordView);

export default router;
