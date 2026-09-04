/**
 * admin.helpVideos.controller.js — admin CRUD + publish for Help Videos.
 * Simpler than admin.blog.controller.js: no cover-image upload, no email
 * send — just title/description/YouTube URL/category/order, draft-first.
 */
import HelpVideo from '../models/HelpVideo.js';
import logger from '../lib/logger.js';

/**
 * GET /api/admin/help-videos?status=draft
 */
export const listAllVideos = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const videos = await HelpVideo.find(filter).sort({ category: 1, order: 1, createdAt: 1 }).lean();
    return res.json({ success: true, data: videos });
  } catch (error) {
    logger.error('listAllVideos error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load videos.' });
  }
};

export const getVideo = async (req, res) => {
  try {
    const video = await HelpVideo.findById(req.params.id).lean();
    if (!video) return res.status(404).json({ success: false, message: 'Video not found.' });
    return res.json({ success: true, data: video });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to load video.' });
  }
};

/**
 * POST /api/admin/help-videos
 * Body: { title, description?, youtubeUrl, category?, order? }
 * Always created as a draft — publishing is a separate explicit action.
 */
export const createVideo = async (req, res) => {
  try {
    const { title, description, youtubeUrl, category, order } = req.body;
    if (!title?.trim() || !youtubeUrl?.trim()) {
      return res.status(400).json({ success: false, message: 'title and youtubeUrl are required.' });
    }

    const video = await HelpVideo.create({
      title: title.trim(),
      description: description?.trim() || '',
      youtubeUrl: youtubeUrl.trim(),
      category: category?.trim() || 'General',
      order: Number.isFinite(Number(order)) ? Number(order) : 0,
      createdByEmail: req.user?.email || null,
    });

    return res.status(201).json({ success: true, data: video });
  } catch (error) {
    logger.error('createVideo error', { error: error.message });
    return res.status(400).json({ success: false, message: error.message || 'Failed to create video.' });
  }
};

/**
 * PUT /api/admin/help-videos/:id
 */
export const updateVideo = async (req, res) => {
  try {
    const video = await HelpVideo.findById(req.params.id);
    if (!video) return res.status(404).json({ success: false, message: 'Video not found.' });

    const { title, description, youtubeUrl, category, order } = req.body;

    if (title !== undefined) video.title = title.trim();
    if (description !== undefined) video.description = description.trim();
    if (youtubeUrl !== undefined) video.youtubeUrl = youtubeUrl.trim();
    if (category !== undefined) video.category = category.trim() || 'General';
    if (order !== undefined) video.order = Number.isFinite(Number(order)) ? Number(order) : 0;

    await video.save();
    return res.json({ success: true, data: video });
  } catch (error) {
    logger.error('updateVideo error', { error: error.message });
    return res.status(400).json({ success: false, message: error.message || 'Failed to update video.' });
  }
};

export const publishVideo = async (req, res) => {
  try {
    const video = await HelpVideo.findById(req.params.id);
    if (!video) return res.status(404).json({ success: false, message: 'Video not found.' });
    video.status = 'published';
    if (!video.publishedAt) video.publishedAt = new Date();
    await video.save();
    return res.json({ success: true, data: video });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to publish video.' });
  }
};

export const unpublishVideo = async (req, res) => {
  try {
    const video = await HelpVideo.findById(req.params.id);
    if (!video) return res.status(404).json({ success: false, message: 'Video not found.' });
    video.status = 'draft';
    await video.save();
    return res.json({ success: true, data: video });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to unpublish video.' });
  }
};

export const deleteVideo = async (req, res) => {
  try {
    const video = await HelpVideo.findById(req.params.id);
    if (!video) return res.status(404).json({ success: false, message: 'Video not found.' });
    await video.deleteOne();
    return res.json({ success: true, message: 'Video deleted.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to delete video.' });
  }
};
