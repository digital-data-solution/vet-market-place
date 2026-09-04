import express from 'express';
import { adminProtect, requireModule, requireModuleRead } from '../middlewares/adminAuthMiddleware.js';
import {
  listAllVideos, getVideo, createVideo, updateVideo, deleteVideo,
  publishVideo, unpublishVideo,
} from '../api/admin.helpVideos.controller.js';

const router = express.Router();
router.use(adminProtect);

router.get('/',               requireModuleRead('help_videos'), listAllVideos);
router.get('/:id',            requireModuleRead('help_videos'), getVideo);
router.post('/',              requireModule('help_videos'), createVideo);
router.put('/:id',            requireModule('help_videos'), updateVideo);
router.delete('/:id',         requireModule('help_videos'), deleteVideo);
router.post('/:id/publish',   requireModule('help_videos'), publishVideo);
router.post('/:id/unpublish', requireModule('help_videos'), unpublishVideo);

export default router;
