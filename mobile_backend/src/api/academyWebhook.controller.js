import crypto from 'crypto';
import CoursePublishDraft from '../models/CoursePublishDraft.js';
import logger from '../lib/logger.js';

const WEBHOOK_SECRET = process.env.VET_COURSE_PUBLISH_WEBHOOK_SECRET;

/**
 * Constant-time shared-secret check. Same try/catch-on-length-mismatch idiom
 * as verifyUnsubscribeSig in services/email.service.js — timingSafeEqual
 * throws instead of returning false when the two buffers differ in length.
 */
function secretMatches(provided) {
  if (!WEBHOOK_SECRET || !provided || typeof provided !== 'string') return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(WEBHOOK_SECRET);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * POST /api/webhooks/academy/vet-course-published
 *
 * Receiver for Xpress Digital Academy's course-publish webhook. Fails
 * closed: any request with a missing or mismatching X-Webhook-Secret header
 * is rejected 401 before the body is even parsed for meaning.
 *
 * On a valid request this NEVER notifies anyone directly — it only files a
 * CoursePublishDraft for an admin to review on the dashboard and, if they
 * choose to, manually turn into a real push notification via the existing
 * admin-notification composer (services/adminNotification.service.js).
 * Same "draft inbox, human decides" rule as the WhatsApp-drafts pipeline.
 */
export const handleVetCoursePublished = async (req, res) => {
  const provided = req.headers['x-webhook-secret'];
  if (!secretMatches(provided)) {
    logger.warn('Academy webhook rejected: missing/invalid X-Webhook-Secret', { ip: req.ip });
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const body = req.body || {};
  const {
    event,
    line,
    course_name: courseName,
    slug,
    price_ngn: priceNgn,
    pricing_model: pricingModel,
    short_description: shortDescription,
    category,
    course_url: courseUrl,
    published_at: publishedAt,
  } = body;

  if (event !== 'course.published' || !courseName || !courseUrl) {
    logger.warn('Academy webhook rejected: malformed payload', { body });
    return res.status(400).json({
      success: false,
      message: 'Malformed payload — expected event: "course.published" with course_name and course_url set.',
    });
  }

  try {
    const draft = await CoursePublishDraft.create({
      event,
      line: line || null,
      courseName: courseName.trim(),
      slug: slug || null,
      priceNgn: typeof priceNgn === 'number' ? priceNgn : null,
      pricingModel: pricingModel || null,
      shortDescription: shortDescription || null,
      category: category || null,
      courseUrl,
      publishedAt: publishedAt ? new Date(publishedAt) : new Date(),
      rawPayload: body,
    });

    logger.info('Academy course-publish draft recorded', { draftId: draft._id, courseName, line });

    return res.status(201).json({
      success: true,
      message: 'Draft recorded. No notification was sent — an admin will review it before anything goes out.',
      data: { draftId: draft._id },
    });
  } catch (error) {
    logger.error('Academy webhook: failed to save draft', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to record draft.' });
  }
};
