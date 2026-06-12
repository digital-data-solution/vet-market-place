import User         from '../models/User.js';
import Subscription from '../models/Subscription.js';
import Professional from '../models/Professional.js';
import Shop         from '../models/Shop.js';
import logger       from '../lib/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long (ms) a pending subscription is treated as valid after payment was
 * initiated. Gives Flutterwave webhooks time to land before blocking the user.
 * 30 minutes is the window — adjust PENDING_GRACE_MS if needed.
 */
const PENDING_GRACE_MS = 30 * 60 * 1000; // 30 minutes

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if a pending subscription was created within the grace window.
 * Falls back to false if no timestamp is available.
 *
 * We check `paymentInitiatedAt` first (explicit field you can set when the
 * Flutterwave charge call is made), then `createdAt` (Mongoose default), then
 * `updatedAt` — whichever is earliest and present.
 *
 * @param {object} sub  – raw subscription document (lean)
 * @returns {boolean}
 */
function isWithinPendingGrace(sub) {
  const anchor =
    sub.paymentInitiatedAt ||
    sub.createdAt          ||
    sub.updatedAt          ||
    null;

  if (!anchor) return false;

  const elapsed = Date.now() - new Date(anchor).getTime();
  return elapsed <= PENDING_GRACE_MS;
}

/**
 * Resolves the active subscription record for any user role.
 * Returns a normalised object or null.
 *
 * Shape returned:
 * {
 *   isActive:    boolean   – true = full access, false = block
 *   isPending:   boolean   – true = within grace window (isActive will also be true)
 *   status:      string    – raw status from DB
 *   plan:        string
 *   endDate:     Date|null
 *   type:        'user' | 'professional'
 *   graceEndsAt: Date|null – only set when isPending is true
 * }
 *
 * @param {string} userId
 * @param {string} role   – 'pet_owner' | anything else (professional)
 */
async function resolveSubscription(userId, role) {
  if (role === 'pet_owner') {
    const user = await User.findById(userId)
      .select('subscription')
      .lean();

    if (!user?.subscription) return null;

    const sub     = user.subscription;
    const now     = new Date();
    const endDate = sub.endDate ? new Date(sub.endDate) : null;

    // ── Handle pending with grace window ────────────────────────────────────
    if (sub.status === 'pending') {
      const inGrace = isWithinPendingGrace(sub);
      const anchor  =
        sub.paymentInitiatedAt || sub.createdAt || sub.updatedAt || null;

      return {
        isActive:    inGrace,
        isPending:   true,
        status:      'pending',
        plan:        sub.plan,
        endDate,
        type:        'user',
        graceEndsAt: anchor
          ? new Date(new Date(anchor).getTime() + PENDING_GRACE_MS)
          : null,
      };
    }

    // ── Lazy expiry (fire-and-forget, never blocks request) ─────────────────
    if (sub.status === 'active' && endDate && now > endDate) {
      User.findByIdAndUpdate(
        userId,
        { 'subscription.status': 'expired' },
      ).catch(err =>
        logger.error('Lazy expiry update failed (pet_owner)', {
          err: err.message,
          userId,
        }),
      );
      sub.status = 'expired';
    }

    return {
      isActive:    sub.status === 'active' && !!endDate && now < endDate,
      isPending:   false,
      status:      sub.status,
      plan:        sub.plan,
      endDate,
      type:        'user',
      graceEndsAt: null,
    };
  }

  // ── Professional / Shop path ───────────────────────────────────────────────
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
      isActive:    true,
      isPending:   false,
      status:      'active',
      plan:        activeSub.plan,
      endDate:     new Date(activeSub.endDate),
      type:        'professional',
      graceEndsAt: null,
    };
  }

  // No active sub — fetch the most recent record for error messaging.
  const lastSub = await Subscription.findOne({ user: userId })
    .sort({ endDate: -1 })
    .select('plan status endDate paymentInitiatedAt createdAt updatedAt')
    .lean();

  if (!lastSub) return null;

  // ── Handle pending with grace window ──────────────────────────────────────
  if (lastSub.status === 'pending') {
    const inGrace = isWithinPendingGrace(lastSub);
    const anchor  =
      lastSub.paymentInitiatedAt || lastSub.createdAt || lastSub.updatedAt || null;

    return {
      isActive:    inGrace,
      isPending:   true,
      status:      'pending',
      plan:        lastSub.plan,
      endDate:     lastSub.endDate ? new Date(lastSub.endDate) : null,
      type:        'professional',
      graceEndsAt: anchor
        ? new Date(new Date(anchor).getTime() + PENDING_GRACE_MS)
        : null,
    };
  }

  // ── Lazy expiry ────────────────────────────────────────────────────────────
  if (lastSub.status === 'active') {
    Subscription.findByIdAndUpdate(
      lastSub._id,
      { status: 'expired' },
    ).catch(err =>
      logger.error('Lazy expiry update failed (professional)', {
        err: err.message,
        userId,
      }),
    );
    lastSub.status = 'expired';
  }

  return {
    isActive:    false,
    isPending:   false,
    status:      lastSub.status,
    plan:        lastSub.plan,
    endDate:     lastSub.endDate ? new Date(lastSub.endDate) : null,
    type:        'professional',
    graceEndsAt: null,
  };
}

/**
 * Builds a 402 payload for missing / expired / pending subscriptions.
 * Only called when the pending grace window has already elapsed.
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
    // Grace window has elapsed — payment never confirmed.
    return {
      success:    false,
      message:    'Your payment could not be confirmed. Please try subscribing again or contact support.',
      action:     'subscribe',
      redirectTo,
      data:       { status: 'pending' },
    };
  }

  if (
    sub.status === 'expired' ||
    (sub.status === 'active' && sub.endDate && new Date() > sub.endDate)
  ) {
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
// Hard gate — blocks with 402 if no active subscription AND not within the
// pending grace window.
//
// Pending users within the grace window are passed through with:
//   req.subscription.isPending  = true
//   req.subscription.graceEndsAt = Date
//
// Downstream routes can check req.subscription.isPending to restrict
// specific heavy actions if needed, but most routes will just work.
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
        status:    sub?.status ?? 'none',
        isPending: sub?.isPending ?? false,
        path:      req.path,
      });
      return res.status(402).json(buildSubscribeError(sub, role));
    }

    // Attach for downstream use without an extra DB call.
    req.subscription = sub;

    if (sub.isPending) {
      logger.info('Pending subscription allowed via grace window', {
        userId,
        role,
        graceEndsAt: sub.graceEndsAt,
        path:        req.path,
      });
    } else {
      logger.debug('Subscription check passed', { userId, plan: sub.plan, role });
    }

    return next();
  } catch (error) {
    logger.error('enforceSubscription error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// professionalOnly
// Gate for routes that require a verified professional/shop AND an active
// professional-tier subscription (or pending within grace window).
// ─────────────────────────────────────────────────────────────────────────────
export const professionalOnly = async (req, res, next) => {
  const userId = req.user?._id?.toString() || req.user?.id;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  try {
    const now = new Date();

    const [professional, shop, activeSub] = await Promise.all([
      Professional.findOne({ userId }).select('_id').lean(),
      Shop.findOne({ owner: userId }).select('_id').lean(),
      Subscription.findOne({
        user:    userId,
        status:  'active',
        endDate: { $gte: now },
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

    if (activeSub) {
      req.subscription = {
        isActive:    true,
        isPending:   false,
        status:      'active',
        plan:        activeSub.plan,
        endDate:     new Date(activeSub.endDate),
        type:        'professional',
        graceEndsAt: null,
      };
      logger.debug('Professional access granted', { userId, plan: activeSub.plan });
      return next();
    }

    // No active sub — check for pending within grace window.
    const lastSub = await Subscription.findOne({ user: userId })
      .sort({ endDate: -1 })
      .select('plan status endDate paymentInitiatedAt createdAt updatedAt')
      .lean();

    if (lastSub?.status === 'pending' && isWithinPendingGrace(lastSub)) {
      const anchor = lastSub.paymentInitiatedAt || lastSub.createdAt || lastSub.updatedAt;
      req.subscription = {
        isActive:    true,
        isPending:   true,
        status:      'pending',
        plan:        lastSub.plan,
        endDate:     lastSub.endDate ? new Date(lastSub.endDate) : null,
        type:        'professional',
        graceEndsAt: anchor
          ? new Date(new Date(anchor).getTime() + PENDING_GRACE_MS)
          : null,
      };
      logger.info('Professional pending subscription allowed via grace window', {
        userId,
        graceEndsAt: req.subscription.graceEndsAt,
      });
      return next();
    }

    return res.status(402).json(
      buildSubscribeError(
        lastSub
          ? {
              isActive:  false,
              isPending: lastSub.status === 'pending',
              status:    lastSub.status,
              plan:      lastSub.plan,
              endDate:   lastSub.endDate,
              type:      'professional',
            }
          : null,
        'professional',
      ),
    );
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
    logger.error('attachSubscription error', { error: error.message, userId });
  }

  return next();
};

// ─────────────────────────────────────────────────────────────────────────────
// checkExpiryWarning
// Appends a subscriptionWarning block to JSON responses when:
//   (a) the subscription expires within 7 days, OR
//   (b) the subscription is pending within the grace window
//
// Must be used AFTER attachSubscription or enforceSubscription.
// ─────────────────────────────────────────────────────────────────────────────
export const checkExpiryWarning = (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = function (data) {
    try {
      const sub = req.subscription;

      if (!sub) return originalJson(data);

      // ── Pending grace window warning ──────────────────────────────────────
      if (sub.isPending && sub.graceEndsAt) {
        const minsRemaining = Math.ceil(
          (sub.graceEndsAt - Date.now()) / (1000 * 60),
        );

        if (minsRemaining > 0) {
          return originalJson({
            ...data,
            subscriptionWarning: {
              message:       'Your payment is being confirmed. Full access is active while we wait.',
              type:          'pending_confirmation',
              minsRemaining,
              graceEndsAt:   sub.graceEndsAt,
              renewUrl:      sub.type === 'user' ? '/subscribe' : '/subscribe/professional',
            },
          });
        }
      }

      // ── Expiry within 7 days warning ──────────────────────────────────────
      if (sub.isActive && !sub.isPending && sub.endDate) {
        const now             = new Date();
        const daysUntilExpiry = Math.ceil(
          (sub.endDate - now) / (1000 * 60 * 60 * 24),
        );

        if (daysUntilExpiry <= 7 && daysUntilExpiry > 0) {
          return originalJson({
            ...data,
            subscriptionWarning: {
              message:       `Your subscription expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}. Renew now to avoid interruption.`,
              type:          'expiry_soon',
              daysRemaining: daysUntilExpiry,
              expiresAt:     sub.endDate,
              renewUrl:      sub.type === 'user' ? '/subscribe' : '/subscribe/professional',
            },
          });
        }
      }
    } catch (error) {
      logger.error('checkExpiryWarning error', { error: error.message });
    }

    return originalJson(data);
  };

  next();
};

// ─────────────────────────────────────────────────────────────────────────────
// enforceMessagingSubscription
// Hard gate — blocks with 402 if user has no active messaging subscription.
// Used on any route that sends or reads messages.
// ─────────────────────────────────────────────────────────────────────────────
export const enforceMessagingSubscription = async (req, res, next) => {
  const userId = req.user?._id?.toString() || req.user?.id;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  try {
    const now = new Date();

    // Check for active messaging subscription
    const activeSub = await Subscription.findOne({
      user:    userId,
      plan:    'messaging',
      status:  'active',
      endDate: { $gte: now },
    })
      .select('plan status endDate')
      .lean();

    if (activeSub) {
      req.messagingSubscription = {
        isActive: true,
        plan:     'messaging',
        endDate:  new Date(activeSub.endDate),
      };
      return next();
    }

    // Check for pending within grace window
    const pendingSub = await Subscription.findOne({
      user:   userId,
      plan:   'messaging',
      status: 'pending',
    })
      .sort({ createdAt: -1 })
      .lean();

    if (pendingSub && isWithinPendingGrace(pendingSub)) {
      req.messagingSubscription = {
        isActive:  true,
        isPending: true,
        plan:      'messaging',
        endDate:   pendingSub.endDate ? new Date(pendingSub.endDate) : null,
      };
      logger.info('Messaging pending subscription allowed via grace window', { userId });
      return next();
    }

    logger.warn('Messaging subscription required', { userId, path: req.path });
    return res.status(402).json({
      success:    false,
      message:    'A messaging subscription (₦500/month) is required to send and receive messages.',
      action:     'subscribe_messaging',
      redirectTo: '/subscribe/messaging',
      data:       { plan: 'messaging', amount: 500 },
    });
  } catch (error) {
    logger.error('enforceMessagingSubscription error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

export default {
  enforceSubscription,
  professionalOnly,
  attachSubscription,
  checkExpiryWarning,
  enforceMessagingSubscription,
};