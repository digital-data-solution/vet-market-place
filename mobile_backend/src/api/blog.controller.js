/**
 * blog.controller.js — PUBLIC read side of the blog. No auth: articles are
 * shareable marketing content, meant to be linkable from outside the app
 * (email, social) as much as browsable inside it. Only ever returns
 * status:'published' posts — drafts stay invisible until an admin publishes.
 */
import BlogPost from '../models/BlogPost.js';

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
 * GET /api/v1/blog/:slug — full article. Increments viewCount best-effort
 * (never blocks the response on it).
 */
export const getPostBySlug = async (req, res) => {
  try {
    const post = await BlogPost.findOne({ slug: req.params.slug.toLowerCase(), status: 'published' }).lean();
    if (!post) return res.status(404).json({ success: false, message: 'Post not found.' });

    BlogPost.updateOne({ _id: post._id }, { $inc: { viewCount: 1 } }).catch(() => {});

    return res.json({ success: true, data: post });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load post.' });
  }
};
