/**
 * helpVideos.controller.js — public read access to published Help Videos.
 * No auth required, same as blog.controller.js — this is app-onboarding
 * content, not user-specific data.
 */
import HelpVideo from '../models/HelpVideo.js';
import logger from '../lib/logger.js';

/**
 * GET /api/v1/help-videos
 * Returns every published video, sorted by category then order — the app
 * groups them into sections client-side by `category`.
 */
export const listPublishedVideos = async (req, res) => {
  try {
    const videos = await HelpVideo.find({ status: 'published' })
      .sort({ category: 1, order: 1, createdAt: 1 })
      .select('title description youtubeUrl youtubeVideoId category order publishedAt viewCount')
      .lean();
    return res.json({ success: true, data: videos });
  } catch (error) {
    logger.error('listPublishedVideos error', { error: error.message });
    return res.status(500).json({ success: false, data: [] });
  }
};

/**
 * GET /api/v1/help-videos/:id — single video, for the player screen (also
 * reached via a bare /HelpVideos/:id deep link, which only carries the id —
 * same "fetch full detail by the one thing in the URL" pattern as
 * blog.controller.js's getPostBySlug).
 */
export const getVideoById = async (req, res) => {
  try {
    const video = await HelpVideo.findOne({ _id: req.params.id, status: 'published' })
      .select('title description youtubeUrl youtubeVideoId category order publishedAt viewCount')
      .lean();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found.' });
    return res.json({ success: true, data: video });
  } catch (error) {
    return res.status(404).json({ success: false, message: 'Video not found.' });
  }
};

/**
 * POST /api/v1/help-videos/:id/view — best-effort view-count increment,
 * fired when the app actually opens the embedded player (not just when the
 * list renders). Never blocks playback on failure.
 */
export const recordView = async (req, res) => {
  try {
    await HelpVideo.updateOne(
      { _id: req.params.id, status: 'published' },
      { $inc: { viewCount: 1 } },
    );
    return res.json({ success: true });
  } catch (error) {
    return res.json({ success: true }); // fire-and-forget, never surface an error to the viewer
  }
};
