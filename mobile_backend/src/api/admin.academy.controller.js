/**
 * admin.academy.controller.js
 *
 * Admin review surface for CoursePublishDraft records created by the Academy
 * course-publish webhook (api/academyWebhook.controller.js). Purely a review
 * queue — nothing here sends anything to a real vet/breeder. To actually
 * notify people about a course, the admin composes a real push notification
 * from the Notifications tab (optionally prefilled from a draft), same
 * reviewed flow as any other admin-composed notification.
 */
import CoursePublishDraft from '../models/CoursePublishDraft.js';
import logger from '../lib/logger.js';

/**
 * GET /api/admin/academy/course-drafts?status=draft
 */
export const listCourseDrafts = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const drafts = await CoursePublishDraft.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ success: true, data: drafts });
  } catch (error) {
    logger.error('listCourseDrafts error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load course drafts.' });
  }
};

/**
 * POST /api/admin/academy/course-drafts/:id/dismiss
 * Marks a draft reviewed-and-skipped — the admin decided not to notify
 * anyone about this course (or already did so manually elsewhere).
 */
export const dismissCourseDraft = async (req, res) => {
  try {
    const draft = await CoursePublishDraft.findByIdAndUpdate(
      req.params.id,
      { status: 'dismissed', reviewedAt: new Date(), reviewedByEmail: req.user?.email || null },
      { new: true },
    );
    if (!draft) return res.status(404).json({ success: false, message: 'Draft not found.' });
    return res.json({ success: true, data: draft });
  } catch (error) {
    logger.error('dismissCourseDraft error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to dismiss draft.' });
  }
};
