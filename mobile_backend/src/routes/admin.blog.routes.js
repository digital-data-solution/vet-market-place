import express from 'express';
import multer from 'multer';
import { adminProtect } from '../middlewares/adminAuthMiddleware.js';
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

router.get('/',                    listAllPosts);
router.post('/upload-cover',       upload.single('image'), uploadCoverImage);
router.get('/:id',                 getPost);
router.post('/',                   createPost);
router.put('/:id',                 updatePost);
router.delete('/:id',              deletePost);
router.post('/:id/publish',        publishPost);
router.post('/:id/unpublish',      unpublishPost);
router.get('/:id/preview-count',   previewBlogEmailReach);
router.post('/:id/send-email',     sendPostEmail);

export default router;
