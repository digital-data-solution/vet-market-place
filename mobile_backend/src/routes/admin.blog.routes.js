import express from 'express';
import multer from 'multer';
import { adminProtect, requireModule, requireModuleRead } from '../middlewares/adminAuthMiddleware.js';
import {
  listAllPosts, getPost, createPost, updatePost, deletePost,
  publishPost, unpublishPost, uploadCoverImage,
  previewBlogEmailReach, sendPostEmail,
} from '../api/admin.blog.controller.js';

const router = express.Router();
router.use(adminProtect);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed.'));
  },
});

router.get('/',                    requireModuleRead('blog'), listAllPosts);
router.post('/upload-cover',       requireModule('blog'), upload.single('image'), uploadCoverImage);
router.get('/:id',                 requireModuleRead('blog'), getPost);
router.post('/',                   requireModule('blog'), createPost);
router.put('/:id',                 requireModule('blog'), updatePost);
router.delete('/:id',              requireModule('blog'), deletePost);
router.post('/:id/publish',        requireModule('blog'), publishPost);
router.post('/:id/unpublish',      requireModule('blog'), unpublishPost);
router.get('/:id/preview-count',   requireModuleRead('blog'), previewBlogEmailReach);
router.post('/:id/send-email',     requireModule('blog'), sendPostEmail);

export default router;
