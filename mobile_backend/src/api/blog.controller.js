/**
 * blog.controller.js — PUBLIC read side of the blog. No auth: articles are
 * shareable marketing content, meant to be linkable from outside the app
 * (email, social) as much as browsable inside it. Only ever returns
 * status:'published' posts — drafts stay invisible until an admin publishes.
 */
import crypto from 'crypto';
import BlogPost from '../models/BlogPost.js';
import BlogPostView from '../models/BlogPostView.js';

const LIST_FIELDS = 'title slug excerpt coverImageUrl tags authorName publishedAt viewCount';

/**
 * GET /api/v1/blog?page=1&limit=12&tag=nutrition
 */
export const listPublishedPosts = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));
    const filter = { status: 'published' };
    if (req.query.tag) filter.tags = req.query.tag.trim();

    const [posts, total] = await Promise.all([
      BlogPost.find(filter, LIST_FIELDS)
        .sort({ publishedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      BlogPost.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: posts,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load blog posts.' });
  }
};

/**
 * GET /api/v1/blog/:slug — full article. Increments viewCount best-effort,
 * deduped so a refresh or the admin re-checking their own post doesn't
 * inflate it — see BlogPostView.js. IP is only ever stored hashed, never
 * raw, and only long enough to answer "seen this visitor today already?".
 */
export const getPostBySlug = async (req, res) => {
  try {
    const post = await BlogPost.findOne({ slug: req.params.slug.toLowerCase(), status: 'published' }).lean();
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });

    recordUniqueView(post._id, req).catch(() => {});

    return res.json({ success: true, data: post });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load post.' });
  }
};

async function recordUniqueView(postId, req) {
  const ipHash = crypto.createHash('sha256').update(req.ip || 'unknown').digest('hex');
  const day = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  try {
    await BlogPostView.create({ post: postId, ipHash, day });
  } catch (err) {
    if (err?.code === 11000) return; // already counted this visitor today — not a new view
    throw err;
  }
  await BlogPost.updateOne({ _id: postId }, { $inc: { viewCount: 1 } });
}
