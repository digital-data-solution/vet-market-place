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
// Emailing a post out is gated to 'blog_broadcast', deliberately separate
// from 'blog' (content) — a materially bigger trust ask (reaches real users,
// touches the person-search picker's PII) than editorial publishing. See
// config/adminModules.js. A 'blog'-only account (e.g. an external editor)
// can write/publish freely but never trigger a send.
router.get('/:id/preview-count',   requireModuleRead('blog_broadcast'), previewBlogEmailReach);
router.post('/:id/send-email',     requireModule('blog_broadcast'), sendPostEmail);

export default router;
