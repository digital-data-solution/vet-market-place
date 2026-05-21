import User         from '../models/User.js';
import Subscription from '../models/Subscription.js';
import Professional from '../models/Professional.js';
import Shop         from '../models/Shop.js';
import logger       from '../lib/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the active subscription record for any user role.
 * Returns a normalised object or null.
 *
 * @param {string}  userId
 * @param {string}  role     – 'pet_owner' | anything else (professional)
 * @returns {{ isActive, status, plan, endDate, type } | null}
 */
async function resolveSubscription(userId, role) {
  if (role === 'pet_owner') {
    // Pet-owner subscription is embedded on the User document.
    // We only fetch the subscription sub-document to keep the projection tight.
    const user = await User.findById(userId)
      .select('subscription')
      .lean();

    if (!user?.subscription) return null;

    const sub     = user.subscription;
    const now     = new Date();
    const endDate = sub.endDate ? new Date(sub.endDate) : null;

    // Lazily expire in the background — never block the request on this write.
    if (sub.status === 'active' && endDate && now > endDate) {
      User.findByIdAndUpdate(
        userId,
        { 'subscription.status': 'expired' },
        { returnDocument: 'after' },   // replaces deprecated { new: true }
      ).catch(err =>
        logger.error('Lazy expiry update failed (pet_owner)', { err: err.message, userId }),
      );
      sub.status = 'expired';
    }

    return {
      isActive: sub.status === 'active' && endDate && now < endDate,
      status:   sub.status,
      plan:     sub.plan,
      endDate,
      type:     'user',
    };
  }

  // ── Professional / Shop path ───────────────────────────────────────────────
  // Query for an active sub first (hot path). Only hit the DB a second time
  // for the expired-message fallback.
  const now = new Date();

  const activeSub = await Subscription.findOne({
    user:    userId,
    status:  'active',
    endDate: { $gte: now },
  })
    .select('plan status endDate')
    .lean();

  if (activeSub) {
    return {
      isActive: true,
      status:   'active',
      plan:     activeSub.plan,
      endDate:  new Date(activeSub.endDate),
      type:     'professional',
    };
  }

  // No active sub — check if there is any record at all (for better error messages).
  const lastSub = await Subscription.findOne({ user: userId })
    .sort({ endDate: -1 })
    .select('plan status endDate')
    .lean();

  if (!lastSub) return null;

  // Lazily mark any stale active records as expired.
  if (lastSub.status === 'active') {
    Subscription.findByIdAndUpdate(
      lastSub._id,
      { status: 'expired' },
      { returnDocument: 'after' },     // replaces deprecated { new: true }
    ).catch(err =>
      logger.error('Lazy expiry update failed (professional)', { err: err.message, userId }),
    );
    lastSub.status = 'expired';
  }

  return {
    isActive: false,
    status:   lastSub.status,
    plan:     lastSub.plan,
    endDate:  lastSub.endDate ? new Date(lastSub.endDate) : null,
    type:     'professional',
  };
}

/**
 * Builds a 402 payload for missing / expired / pending subscriptions.
 */
function buildSubscribeError(sub, role) {
  const isProfessional = role !== 'pet_owner';
  const redirectTo     = isProfessional ? '/subscribe/professional' : '/subscribe';

  if (!sub) {
    return {
      success:    false,
      message:    'An active subscription is required to access this feature.',
      action:     'subscribe',
      redirectTo,
      data:       null,
    };
  }

  if (sub.status === 'pending') {
    return {
      success:    false,
      message:    'Your payment is being confirmed. Please check back in a moment.',
      action:     'check_payment',
      redirectTo,
      data:       { status: 'pending' },
    };
  }

  if (sub.status === 'expired' || (sub.status === 'active' && sub.endDate && new Date() > sub.endDate)) {
    return {
      success:    false,
      message:    'Your subscription has expired. Please renew to continue.',
      action:     'renew',
      redirectTo,
      data:       { status: 'expired', expiredAt: sub.endDate, lastPlan: sub.plan },
    };
  }

  if (sub.status === 'cancelled') {
    return {
      success:    false,
      message:    'Your subscription was cancelled. Subscribe again to regain access.',
      action:     'subscribe',
      redirectTo,
      data:       { status: 'cancelled', lastPlan: sub.plan },
    };
  }

  // Catch-all
  return {
    success:    false,
    message:    'An active subscription is required to access this feature.',
    action:     'subscribe',
    redirectTo,
    data:       null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// enforceSubscription
// Hard gate — blocks the request with 402 if no active subscription.
// Works for both pet owners (embedded User.subscription) and professionals
// (Subscription collection).
// ─────────────────────────────────────────────────────────────────────────────
export const enforceSubscription = async (req, res, next) => {
  const userId = req.user?._id?.toString() || req.user?.id;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  try {
    const role = req.user.role || 'pet_owner';
    const sub  = await resolveSubscription(userId, role);

    if (!sub?.isActive) {
      logger.warn('Subscription enforcement blocked request', {
        userId,
        role,
        status: sub?.status ?? 'none',
        path:   req.path,
      });
      return res.status(402).json(buildSubscribeError(sub, role));
    }

    // Attach for downstream use without an extra DB call
    req.subscription = sub;

    logger.debug('Subscription check passed', { userId, plan: sub.plan, role });
    return next();
  } catch (error) {
    logger.error('enforceSubscription error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// professionalOnly
// Gate for routes that require a verified professional/shop AND an active
// professional-tier subscription.
// ─────────────────────────────────────────────────────────────────────────────
export const professionalOnly = async (req, res, next) => {
  const userId = req.user?._id?.toString() || req.user?.id;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  try {
    // Run identity check and subscription check in parallel
    const [professional, shop, sub] = await Promise.all([
      Professional.findOne({ userId }).select('_id').lean(),
      Shop.findOne({ owner: userId }).select('_id').lean(),
      Subscription.findOne({
        user:    userId,
        status:  'active',
        endDate: { $gte: new Date() },
      })
        .select('plan status endDate')
        .lean(),
    ]);

    if (!professional && !shop) {
      return res.status(403).json({
        success: false,
        message: 'This feature is only available to verified professionals and shop owners.',
        action:  'verify_account',
      });
    }

    if (!sub) {
      const lastSub = await Subscription.findOne({ user: userId })
        .sort({ endDate: -1 })
        .select('plan status endDate')
        .lean();

      return res.status(402).json(
        buildSubscribeError(
          lastSub
            ? { isActive: false, status: lastSub.status, plan: lastSub.plan, endDate: lastSub.endDate, type: 'professional' }
            : null,
          'professional',
        ),
      );
    }

    req.subscription = {
      isActive: true,
      status:   'active',
      plan:     sub.plan,
      endDate:  new Date(sub.endDate),
      type:     'professional',
    };

    logger.debug('Professional access granted', { userId, plan: sub.plan });
    return next();
  } catch (error) {
    logger.error('professionalOnly error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// attachSubscription
// Non-blocking — resolves and attaches subscription info to req.subscription.
// Never rejects or blocks. Use on routes that personalise responses without
// hard-gating access.
// ─────────────────────────────────────────────────────────────────────────────
export const attachSubscription = async (req, res, next) => {
  const userId = req.user?._id?.toString() || req.user?.id;

  if (!userId) return next();

  try {
    const role       = req.user.role || 'pet_owner';
    req.subscription = await resolveSubscription(userId, role);
  } catch (error) {
    // Intentionally swallow — this middleware must never block
    logger.error('attachSubscription error', { error: error.message, userId });
  }

  return next();
};

// ─────────────────────────────────────────────────────────────────────────────
// checkExpiryWarning
// Appends a subscriptionWarning block to JSON responses when the subscription
// expires within 7 days. Must be used AFTER attachSubscription (or
// enforceSubscription, which also attaches req.subscription).
// ─────────────────────────────────────────────────────────────────────────────
export const checkExpiryWarning = (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = function (data) {
    try {
      const sub = req.subscription;

      if (sub?.isActive && sub.endDate) {
        const now             = new Date();
        const daysUntilExpiry = Math.ceil((sub.endDate - now) / (1000 * 60 * 60 * 24));

        if (daysUntilExpiry <= 7 && daysUntilExpiry > 0) {
          return originalJson({
            ...data,
            subscriptionWarning: {
              message:       `Your subscription expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}. Renew now to avoid interruption.`,
              daysRemaining: daysUntilExpiry,
              expiresAt:     sub.endDate,
              renewUrl:      sub.type === 'user' ? '/subscribe' : '/subscribe/professional',
            },
          });
        }
      }
    } catch (error) {
      // Never block the response
      logger.error('checkExpiryWarning error', { error: error.message });
    }

    return originalJson(data);
  };

  next();
};

export default {
  enforceSubscription,
  professionalOnly,
  attachSubscription,
  checkExpiryWarning,
};