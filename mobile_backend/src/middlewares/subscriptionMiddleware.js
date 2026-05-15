import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import Professional from '../models/Professional.js';
import Shop from '../models/Shop.js';
import logger from '../lib/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// enforceSubscription
// Blocks access unless the user has an active subscription.
// Pet owners  → checks User.subscription (embedded)
// Professionals/Shops → checks Subscription collection
// ─────────────────────────────────────────────────────────────────────────────
export const enforceSubscription = async (req, res, next) => {
  try {
    const userId = req.user._id || req.user.id;
    const user = await User.findById(userId).lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (user.role === 'pet_owner') {
      // ── Pet owner path ───────────────────────────────────────────────────
      const sub = user.subscription;

      if (!sub) {
        return res.status(402).json({
          success: false,
          message: 'Active subscription required to access this feature.',
          action: 'subscribe',
          redirectTo: '/subscribe',
        });
      }

      const now = new Date();
      const endDate = new Date(sub.endDate);
      const isActive = sub.status === 'active' && now < endDate;

      if (!isActive) {
        // Auto-correct stale 'active' status in DB
        if (sub.status === 'active' && now > endDate) {
          await User.findByIdAndUpdate(userId, { 'subscription.status': 'expired' });
        }

        return res.status(402).json({
          success: false,
          message:
            sub.status === 'expired' || (sub.status === 'active' && now > endDate)
              ? 'Your subscription has expired. Please renew to continue.'
              : 'Active subscription required to access this feature.',
          action: 'subscribe',
          redirectTo: '/subscribe',
          data: { status: sub.status, expiredAt: sub.endDate },
        });
      }

      logger.debug('Subscription check passed (pet_owner)', { userId, plan: sub.plan });
      return next();
    } else {
      // ── Professional / Shop path ─────────────────────────────────────────
      const sub = await Subscription.findOne({
        user: userId,
        status: 'active',
        endDate: { $gte: new Date() },
      }).lean();

      if (!sub) {
        // Give a better error message if they had one before
        const lastSub = await Subscription.findOne({ user: userId })
          .sort({ endDate: -1 })
          .lean();

        return res.status(402).json({
          success: false,
          message: lastSub
            ? 'Your subscription has expired. Please renew to continue.'
            : 'Active subscription required to access this feature.',
          action: 'subscribe',
          redirectTo: '/subscribe/professional',
          data: lastSub
            ? { lastPlan: lastSub.plan, expiredAt: lastSub.endDate }
            : null,
        });
      }

      logger.debug('Subscription check passed (professional)', { userId, plan: sub.plan });
      return next();
    }
  } catch (error) {
    logger.error('Subscription enforcement error', { error: error.message, userId: req.user?.id });
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// professionalOnly
// Ensures the user is a verified professional or shop owner AND has an
// active subscription. Replaces the old premiumOnly (which referenced a
// 'premium' plan that doesn't exist in this system).
// ─────────────────────────────────────────────────────────────────────────────
export const professionalOnly = async (req, res, next) => {
  try {
    const userId = req.user._id || req.user.id;

    const [professional, shop] = await Promise.all([
      Professional.findOne({ userId }).lean(),
      Shop.findOne({ owner: userId }).lean(),
    ]);

    if (!professional && !shop) {
      return res.status(403).json({
        success: false,
        message: 'This feature is only available to verified professionals and shops.',
        action: 'verify_account',
      });
    }

    // Must also have an active subscription
    const sub = await Subscription.findOne({
      user: userId,
      status: 'active',
      endDate: { $gte: new Date() },
    }).lean();

    if (!sub) {
      return res.status(402).json({
        success: false,
        message: 'Active business subscription required to access this feature.',
        action: 'subscribe',
        redirectTo: '/subscribe/professional',
      });
    }

    logger.debug('Professional access granted', { userId, plan: sub.plan });
    return next();
  } catch (error) {
    logger.error('professionalOnly middleware error', { error: error.message, userId: req.user?.id });
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// attachSubscription
// Non-blocking — attaches subscription info to req.subscription.
// Use on routes that want to personalise responses without hard-gating.
// ─────────────────────────────────────────────────────────────────────────────
export const attachSubscription = async (req, res, next) => {
  try {
    const userId = req.user?._id || req.user?.id;
    if (!userId) return next();

    const user = await User.findById(userId).lean();
    if (!user) return next();

    let subscriptionInfo = null;

    if (user.role === 'pet_owner') {
      const sub = user.subscription;
      if (sub) {
        const isActive = sub.status === 'active' && new Date() < new Date(sub.endDate);
        subscriptionInfo = {
          plan: sub.plan,
          status: sub.status,
          isActive,
          expiresAt: sub.endDate,
          type: 'user',
        };
      }
    } else {
      const sub = await Subscription.findOne({
        user: userId,
        status: 'active',
        endDate: { $gte: new Date() },
      }).lean();

      if (sub) {
        subscriptionInfo = {
          plan: sub.plan,
          status: sub.status,
          isActive: true,
          expiresAt: sub.endDate,
          type: 'professional',
        };
      }
    }

    req.subscription = subscriptionInfo;
    return next();
  } catch (error) {
    logger.error('attachSubscription error', { error: error.message, userId: req.user?.id });
    return next(); // Never block the request
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// checkExpiryWarning
// Appends a subscriptionWarning to JSON responses when the subscription
// is expiring within 7 days. Must be used AFTER attachSubscription.
// ─────────────────────────────────────────────────────────────────────────────
export const checkExpiryWarning = (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = function (data) {
    try {
      if (req.subscription?.isActive) {
        const expiryDate = new Date(req.subscription.expiresAt);
        const daysUntilExpiry = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));

        if (daysUntilExpiry <= 7 && daysUntilExpiry > 0) {
          data.subscriptionWarning = {
            message: `Your subscription expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}. Renew now to avoid interruption.`,
            daysRemaining: daysUntilExpiry,
            expiresAt: expiryDate,
            renewUrl:
              req.subscription.type === 'user'
                ? '/subscribe'
                : '/subscribe/professional',
          };
        }
      }
    } catch (error) {
      logger.error('checkExpiryWarning error', { error: error.message });
      // Never block the response
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