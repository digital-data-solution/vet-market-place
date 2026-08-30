/**
 * admin.blog.controller.js — admin CRUD + publish + email-send for the blog.
 * Mirrors admin.emailCampaigns.controller.js's shape for the email-preview/
 * send endpoints so the dashboard's composer can reuse the same JS pattern.
 */
import BlogPost from '../models/BlogPost.js';
import User from '../models/User.js';
import { uploadToCloudinary, deleteFromCloudinary } from '../lib/cloudinaryUpload.js';
import { dispatchBlogPostEmail, resolveBlogTargetFilter } from '../services/blogEmail.service.js';
import logger from '../lib/logger.js';

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

async function uniqueSlug(base, excludeId) {
  let slug = slugify(base) || 'post';
  let n = 2;
  // Small collision space (admin-authored, low volume) — a loop is fine.
  while (await BlogPost.exists({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })) {
    slug = `${slugify(base)}-${n++}`;
  }
  return slug;
}

/**
 * GET /api/admin/blog?status=draft
 */
export const listAllPosts = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const posts = await BlogPost.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ success: true, data: posts });
  } catch (error) {
    logger.error('listAllPosts error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load posts.' });
  }
};

/**
 * GET /api/admin/blog/:id
 */
export const getPost = async (req, res) => {
  try {
    const post = await BlogPost.findById(req.params.id).lean();
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });
    return res.json({ success: true, data: post });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load post.' });
  }
};

/**
 * POST /api/admin/blog
 * Body: { title, excerpt, contentMarkdown, slug?, tags?, authorName?, coverImageUrl?, coverImagePublicId? }
 * Always created as a draft — publishing is a separate explicit action.
 */
export const createPost = async (req, res) => {
  try {
    const { title, excerpt, contentMarkdown, slug, tags, authorName, coverImageUrl, coverImagePublicId } = req.body;
    if (!title?.trim() || !excerpt?.trim() || !contentMarkdown?.trim()) {
      return res.status(400).json({ success: false, message: 'title, excerpt and contentMarkdown are required.' });
    }

    const finalSlug = await uniqueSlug(slug || title);

    const post = await BlogPost.create({
      title: title.trim(),
      slug: finalSlug,
      excerpt: excerpt.trim(),
      contentMarkdown,
      tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
      authorName: authorName?.trim() || 'Xpress Vet Team',
      coverImageUrl: coverImageUrl || null,
      coverImagePublicId: coverImagePublicId || null,
      createdByEmail: req.user?.email || null,
    });

    return res.status(201).json({ success: true, data: post });
  } catch (error) {
    logger.error('createPost error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to create post.' });
  }
};

/**
 * PUT /api/admin/blog/:id
 * Same fields as create, all optional — partial update. Changing the slug
 * re-checks uniqueness; changing status here is NOT supported (use the
 * dedicated publish/unpublish endpoints, which also stamp publishedAt).
 */
export const updatePost = async (req, res) => {
  try {
    const post = await BlogPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });

    const { title, excerpt, contentMarkdown, slug, tags, authorName, coverImageUrl, coverImagePublicId } = req.body;

    if (title !== undefined) post.title = title.trim();
    if (excerpt !== undefined) post.excerpt = excerpt.trim();
    if (contentMarkdown !== undefined) post.contentMarkdown = contentMarkdown;
    if (tags !== undefined) post.tags = Array.isArray(tags) ? tags.filter(Boolean) : [];
    if (authorName !== undefined) post.authorName = authorName.trim() || 'Xpress Vet Team';
    if (coverImageUrl !== undefined) post.coverImageUrl = coverImageUrl || null;
    if (coverImagePublicId !== undefined) post.coverImagePublicId = coverImagePublicId || null;

    if (slug !== undefined && slugify(slug) !== post.slug) {
      post.slug = await uniqueSlug(slug, post._id);
    }

    await post.save();
    return res.json({ success: true, data: post });
  } catch (error) {
    logger.error('updatePost error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to update post.' });
  }
};

/**
 * POST /api/admin/blog/:id/publish
 */
export const publishPost = async (req, res) => {
  try {
    const post = await BlogPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });
    post.status = 'published';
    if (!post.publishedAt) post.publishedAt = new Date();
    await post.save();
    return res.json({ success: true, data: post });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to publish post.' });
  }
};

/**
 * POST /api/admin/blog/:id/unpublish — pulls it back to draft (removed from
 * the public feed/detail route immediately since those only ever query
 * status:'published'). publishedAt is left as-is so re-publishing keeps the
 * original publish date rather than looking freshly posted.
 */
export const unpublishPost = async (req, res) => {
  try {
    const post = await BlogPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });
    post.status = 'draft';
    await post.save();
    return res.json({ success: true, data: post });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to unpublish post.' });
  }
};

/**
 * DELETE /api/admin/blog/:id
 */
export const deletePost = async (req, res) => {
  try {
    const post = await BlogPost.findById(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });
    if (post.coverImagePublicId) {
      deleteFromCloudinary(post.coverImageUrl).catch(() => {});
    }
    await post.deleteOne();
    return res.json({ success: true, message: 'Post deleted.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to delete post.' });
  }
};

/**
 * POST /api/admin/blog/upload-cover  (multipart, field "image")
 * Returns { url, publicId } — caller (dashboard JS) sets it on the post
 * form before create/update, same two-step flow as every other image
 * upload in this app.
 */
export const uploadCoverImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No image file provided.' });
    const uploadResult = await uploadToCloudinary(req.file.buffer, { folder: 'blog' });
    return res.json({ success: true, url: uploadResult.url, publicId: uploadResult.publicId });
  } catch (error) {
    logger.error('uploadCoverImage error', { error: error.message });
    return res.status(500).json({ success: false, message: error.message || 'Failed to upload image.' });
  }
};

/**
 * GET /api/admin/blog/:id/preview-count?targetType=segment&segmentKey=role_vet
 */
export const previewBlogEmailReach = async (req, res) => {
  try {
    const { targetType, targetUserId, segmentKey } = req.query;
    const filter = await resolveBlogTargetFilter({ targetType, targetUserId, segmentKey });
    const count = await User.countDocuments({
      ...filter,
      marketingOptOut: { $ne: true },
      email: { $nin: [null, ''] },
    });
    return res.json({ success: true, data: { count } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/admin/blog/:id/send-email
 * Body: { targetType: 'user'|'segment'|'all', targetUserId?, segmentKey? }
 * Requires the post to already be published — sending out a draft link
 * would email a 404.
 */
export const sendPostEmail = async (req, res) => {
  try {
    const { targetType, targetUserId, segmentKey } = req.body;
    if (!['user', 'segment', 'all'].includes(targetType)) {
      return res.status(400).json({ success: false, message: 'targetType must be one of: user, segment, all.' });
    }
    if (targetType === 'user' && !targetUserId) {
      return res.status(400).json({ success: false, message: 'targetUserId is required for targetType "user".' });
    }
    if (targetType === 'segment' && !segmentKey) {
      return res.status(400).json({ success: false, message: 'segmentKey is required for targetType "segment".' });
    }

    const post = await dispatchBlogPostEmail(req.params.id, { targetType, targetUserId, segmentKey });
    return res.json({ success: true, data: post });
  } catch (error) {
    logger.error('sendPostEmail error', { error: error.message });
    return res.status(400).json({ success: false, message: error.message || 'Failed to send email.' });
  }
};
