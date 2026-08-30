import express from 'express';
import { listPublishedPosts, getPostBySlug } from '../api/blog.controller.js';

const router = express.Router();

// Public — no adminProtect. Mounted at /api/v1/blog in app.js.
router.get('/', listPublishedPosts);
router.get('/:slug', getPostBySlug);

export default router;
