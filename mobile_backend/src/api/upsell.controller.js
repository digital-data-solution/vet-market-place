import ActivityLog  from '../models/ActivityLog.js';
import Subscription from '../models/Subscription.js';
import { cacheGet, cacheSet } from '../lib/cache.js';

const FREE_SEARCH_LIMIT = 3;    // show upsell after 3rd search this week
const FREE_IMAGE_LIMIT  = 2;    // show upsell when user has uploaded 2+ media images
const DISMISS_TTL_S     = 86400; // 24-hour dismiss cooldown

async function hasActiveSub(user) {
  // Pet owners carry their sub on the User doc itself
  if (user.subscription?.status === 'active') return true;
  // Professionals have a row in the Subscription collection
  const sub = await Subscription.findOne({
    user:    user._id || user.id,
    status:  'active',
    endDate: { $gte: new Date() },
  }).select('_id').lean();
  return !!sub;
}

/**
 * GET /api/v1/upsell/check?trigger=search|image_limit
 *
 * Mobile calls this before deciding whether to show a subscription upsell modal.
 * Returns { show: boolean, trigger, reason, count, limit }.
 * Never throws — a failed eligibility check silently returns show:false.
 */
export async function checkUpsell(req, res) {
  try {
    const user    = req.user;
    const userId  = user._id || user.id;
    const { trigger } = req.query;

    if (!trigger) {
      return res.status(400).json({
        success: false,
        message: 'trigger query param required: search | image_limit',
      });
    }

    // Never show upsell to users who already have an active plan
    if (await hasActiveSub(user)) {
      return res.json({ show: false, reason: 'already_subscribed' });
    }

    // Respect 24-hour dismiss cooldown set by dismissUpsell()
    const dismissed = await cacheGet(`upsell:dismiss:${userId}`);
    if (dismissed) {
      return res.json({ show: false, reason: 'dismissed' });
    }

    // ── trigger: search ────────────────────────────────────────────────────────
    if (trigger === 'search') {
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - 7);
      weekStart.setHours(0, 0, 0, 0);

      const count = await ActivityLog.countDocuments({
        user:      userId,
        action:    { $in: ['search.list', 'search.nearby'] },
        timestamp: { $gte: weekStart },
      });

      return res.json({
        show:    count >= FREE_SEARCH_LIMIT,
        trigger,
        reason:  count >= FREE_SEARCH_LIMIT ? 'search_limit_reached' : 'under_limit',
        count,
        limit:   FREE_SEARCH_LIMIT,
      });
    }

    // ── trigger: image_limit ───────────────────────────────────────────────────
    if (trigger === 'image_limit') {
      const count = user.mediaImages?.length ?? 0;
      return res.json({
        show:    count >= FREE_IMAGE_LIMIT,
        trigger,
        reason:  count >= FREE_IMAGE_LIMIT ? 'image_limit_reached' : 'under_limit',
        count,
        limit:   FREE_IMAGE_LIMIT,
      });
    }

    return res.status(400).json({
      success: false,
      message: 'Unknown trigger. Valid values: search | image_limit',
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to check upsell eligibility.' });
  }
}

/**
 * POST /api/v1/upsell/dismiss
 *
 * Records a 24-hour dismiss cooldown so the modal won't reappear too soon.
 * Mobile should call this when the user taps "Not now" or closes the modal.
 */
export async function dismissUpsell(req, res) {
  try {
    const userId = req.user._id || req.user.id;
    await cacheSet(`upsell:dismiss:${userId}`, 1, DISMISS_TTL_S);
    return res.json({ success: true, cooldownHours: 24 });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to record dismissal.' });
  }
}
