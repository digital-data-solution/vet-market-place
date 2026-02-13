import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import Professional from '../models/Professional.js';
import Shop from '../models/Shop.js';
import logger from '../lib/logger.js';

/**
 * Middleware to enforce active subscription for ALL users
 * - Pet owners: check user.subscription
 * - Professionals/Shops: check Subscription model
 */
export const enforceSubscription = async (req, res, next) => {
  try {
    const userId = req.user._id || req.user.id;
    const user = await User.findById(userId).lean();

    if (!user) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found.' 
      });
    }

    // Pet owners: check embedded subscription
    if (user.role === 'pet_owner') {
      const subscription = user.subscription;
      
      if (!subscription) {
        return res.status(402).json({ 
          success: false,
          message: 'Active subscription required to access this feature.',
          action: 'subscribe',
          redirectTo: '/subscribe'
        });
      }

      const now = new Date();
      const endDate = new Date(subscription.endDate);
      const isActive = subscription.status === 'active' && now < endDate;

      if (!isActive) {
        // Auto-update expired status
        if (subscription.status === 'active' && now > endDate) {
          await User.findByIdAndUpdate(userId, {
            'subscription.status': 'expired'
          });
        }

        return res.status(402).json({ 
          success: false,
          message: subscription.status === 'expired' 
            ? 'Your subscription has expired. Please renew to continue.'
            : 'Active subscription required to access this feature.',
          action: 'subscribe',
          redirectTo: '/subscribe',
          data: {
            status: subscription.status,
            expiredAt: subscription.endDate
          }
        });
      }

      // Subscription is active, proceed
      logger.debug('Subscription check passed', { userId, plan: subscription.plan });
      return next();
    } 
    
    // Professionals/Shops: check Subscription model
    else {
      const subscription = await Subscription.findOne({
        user: userId,
        status: 'active',
        endDate: { $gte: new Date() }
      }).lean();

      if (!subscription) {
        // Check if there's an expired one
        const expired = await Subscription.findOne({
          user: userId,
          status: { $in: ['active', 'expired'] }
        }).sort({ endDate: -1 }).lean();

        return res.status(402).json({ 
          success: false,
          message: expired 
            ? 'Your subscription has expired. Please renew to continue.'
            : 'Active subscription required to access this feature.',
          action: 'subscribe',
          redirectTo: '/subscribe/professional',
          data: expired ? {
            lastPlan: expired.plan,
            expiredAt: expired.endDate
          } : null
        });
      }

      // Subscription is active, proceed
      logger.debug('Subscription check passed', { userId, plan: subscription.plan });
      return next();
    }

  } catch (error) {
    logger.error('Subscription enforcement error', { 
      error: error.message, 
      userId: req.user?.id 
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Server error. Please try again.' 
    });
  }
};

/**
 * Middleware to protect premium-only features
 * Only allows users with active PREMIUM plan
 */
export const premiumOnly = async (req, res, next) => {
  try {
    const userId = req.user._id || req.user.id;

    // FIXED: Correct query using userId field
    const professional = await Professional.findOne({ userId: userId }).lean();
    const isProfessional = professional && ['vet', 'kennel'].includes(professional.role);

    // Check if user is a shop owner
    const shop = await Shop.findOne({ owner: userId }).lean();
    const isShop = !!shop;

    // Only professionals and shops can access premium features
    if (!isProfessional && !isShop) {
      return res.status(403).json({ 
        success: false,
        message: 'This feature is only available to verified professionals and shops.',
        action: 'verify_account'
      });
    }

    // Check for active PREMIUM subscription
    const subscription = await Subscription.findOne({ 
      user: userId, 
      plan: 'premium', 
      status: 'active', 
      endDate: { $gte: new Date() } 
    }).lean();

    if (!subscription) {
      // Check current plan
      const currentSub = await Subscription.findOne({
        user: userId,
        status: 'active',
        endDate: { $gte: new Date() }
      }).lean();

      return res.status(402).json({ 
        success: false,
        message: currentSub
          ? `Premium subscription required. You currently have ${currentSub.plan} plan. Please upgrade to access this feature.`
          : 'Premium subscription required to access this feature.',
        action: 'upgrade',
        redirectTo: '/subscribe/professional',
        data: {
          currentPlan: currentSub?.plan || null,
          requiredPlan: 'premium'
        }
      });
    }

    // Premium subscription verified
    logger.debug('Premium access granted', { userId, plan: subscription.plan });
    next();

  } catch (error) {
    logger.error('Premium middleware error', { 
      error: error.message, 
      userId: req.user?.id 
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Server error. Please try again.' 
    });
  }
};

/**
 * Middleware to protect enterprise-only features
 * Only allows users with active ENTERPRISE plan
 */
export const enterpriseOnly = async (req, res, next) => {
  try {
    const userId = req.user._id || req.user.id;

    // Check if user is a professional or shop
    const professional = await Professional.findOne({ userId: userId }).lean();
    const shop = await Shop.findOne({ owner: userId }).lean();

    if (!professional && !shop) {
      return res.status(403).json({ 
        success: false,
        message: 'This feature is only available to verified professionals and shops.',
        action: 'verify_account'
      });
    }

    // Check for active ENTERPRISE subscription
    const subscription = await Subscription.findOne({ 
      user: userId, 
      plan: 'enterprise', 
      status: 'active', 
      endDate: { $gte: new Date() } 
    }).lean();

    if (!subscription) {
      const currentSub = await Subscription.findOne({
        user: userId,
        status: 'active',
        endDate: { $gte: new Date() }
      }).lean();

      return res.status(402).json({ 
        success: false,
        message: currentSub
          ? `Enterprise subscription required. You currently have ${currentSub.plan} plan. Please upgrade to access this feature.`
          : 'Enterprise subscription required to access this feature.',
        action: 'upgrade',
        redirectTo: '/subscribe/professional',
        data: {
          currentPlan: currentSub?.plan || null,
          requiredPlan: 'enterprise'
        }
      });
    }

    // Enterprise subscription verified
    logger.debug('Enterprise access granted', { userId, plan: subscription.plan });
    next();

  } catch (error) {
    logger.error('Enterprise middleware error', { 
      error: error.message, 
      userId: req.user?.id 
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Server error. Please try again.' 
    });
  }
};

/**
 * Middleware to check if user has ANY active subscription
 * Does not enforce, just adds subscription info to req
 */
export const attachSubscription = async (req, res, next) => {
  try {
    const userId = req.user._id || req.user.id;
    const user = await User.findById(userId).lean();

    if (!user) {
      return next();
    }

    let subscriptionInfo = null;

    // Check based on user role
    if (user.role === 'pet_owner') {
      const sub = user.subscription;
      if (sub) {
        const isActive = sub.status === 'active' && new Date() < new Date(sub.endDate);
        subscriptionInfo = {
          plan: sub.plan,
          status: sub.status,
          isActive,
          expiresAt: sub.endDate,
          type: 'user'
        };
      }
    } else {
      const sub = await Subscription.findOne({
        user: userId,
        status: 'active',
        endDate: { $gte: new Date() }
      }).lean();

      if (sub) {
        subscriptionInfo = {
          plan: sub.plan,
          status: sub.status,
          isActive: true,
          expiresAt: sub.endDate,
          type: 'professional'
        };
      }
    }

    // Attach to request object
    req.subscription = subscriptionInfo;
    next();

  } catch (error) {
    logger.error('Attach subscription error', { 
      error: error.message, 
      userId: req.user?.id 
    });
    // Don't block request, just continue without subscription info
    next();
  }
};

/**
 * Middleware to check if subscription is expiring soon (within 7 days)
 * Adds warning to response if applicable
 */
export const checkExpiryWarning = async (req, res, next) => {
  const originalJson = res.json.bind(res);
  
  res.json = async function(data) {
    try {
      const userId = req.user?._id || req.user?.id;
      
      if (userId && req.subscription?.isActive) {
        const expiryDate = new Date(req.subscription.expiresAt);
        const daysUntilExpiry = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));

        if (daysUntilExpiry <= 7 && daysUntilExpiry > 0) {
          data.subscriptionWarning = {
            message: `Your subscription expires in ${daysUntilExpiry} day${daysUntilExpiry > 1 ? 's' : ''}. Renew now to avoid interruption.`,
            daysRemaining: daysUntilExpiry,
            expiresAt: expiryDate,
            renewUrl: req.subscription.type === 'user' ? '/subscribe' : '/subscribe/professional'
          };
        }
      }
    } catch (error) {
      logger.error('Expiry warning error', { error: error.message });
      // Don't block the response
    }

    return originalJson(data);
  };

  next();
};

export default {
  enforceSubscription,
  premiumOnly,
  enterpriseOnly,
  attachSubscription,
  checkExpiryWarning
};