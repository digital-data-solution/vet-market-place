// ─────────────────────────────────────────────────────────────────────────────
// FEATURED / BOOSTED LISTINGS
// One-off payments that push a professional or shop listing to the top of search
// results and give it a "Featured" badge for a fixed number of days.
//
// Reuses the exact Paystack pattern from subscription.controller.js:
//   1. createFeaturedPayment  → transaction/initialize with metadata.type='featured'
//   2. Paystack webhook       → charge.success → activateFeatured() stamps featuredUntil
//   3. verifyPayment fallback → also calls activateFeatured()
// ─────────────────────────────────────────────────────────────────────────────

import axios        from 'axios';
import Professional from '../models/Professional.js';
import Shop         from '../models/Shop.js';
import User         from '../models/User.js';
import cache        from '../lib/cache.js';
import logger       from '../lib/logger.js';
import { logActivity } from '../lib/activityLogger.js';

const PAYSTACK_BASE   = process.env.PAYSTACK_BASE       || 'https://api.paystack.co';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';

// Boost packages — price in NGN, keyed by duration in days.
// Balanced pricing: cheaper than a monthly subscription, an easy impulse buy.
const FEATURED_PACKAGES = {
  7:  { days: 7,  price: 1500, label: '7-Day Boost'  },
  14: { days: 14, price: 2500, label: '14-Day Boost' },
  30: { days: 30, price: 4000, label: '30-Day Boost' },
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL — resolve the caller's listing (professional first, then shop)
// ─────────────────────────────────────────────────────────────────────────────
async function resolveTarget(userId) {
  const professional = await Professional.findOne({ userId });
  if (professional) return { targetType: 'professional', target: professional };

  const shop = await Shop.findOne({ owner: userId });
  if (shop) return { targetType: 'shop', target: shop };

  return { targetType: null, target: null };
}

async function bustListCaches(targetType, target) {
  try {
    if (targetType === 'professional') {
      await cache.del(`professional:${target.userId}`);
      await cache.cacheDel(`professionals:list:${target.role}:1:50:`);
      await cache.cacheDel(`professionals:list:${target.role}:1:20:`);
      await cache.cacheDel(`professionals:list:all:1:50:`);
      await cache.cacheDel(`professionals:list:all:1:20:`);
    } else if (targetType === 'shop') {
      await cache.del(`shop:${target.owner}`);
      await cache.cacheDel('shops:list:1:50');
      await cache.cacheDel('shops:list:1:20');
    }
  } catch (err) {
    logger.warn('Featured cache bust failed', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVATION — called by the webhook and the verify fallback.
// Idempotent: repeated calls with the same reference extend from the later of
// (now, existing featuredUntil) but never stack the same reference twice.
// ─────────────────────────────────────────────────────────────────────────────
export async function activateFeatured(metadata, reference) {
  const { targetType, targetId, days } = metadata;
  const boostDays = FEATURED_PACKAGES[days]?.days ?? parseInt(days, 10);

  if (!targetType || !targetId || !boostDays) {
    throw new Error('Featured metadata incomplete');
  }

  const Model  = targetType === 'shop' ? Shop : Professional;
  const target = await Model.findById(targetId);
  if (!target) throw new Error('Featured target not found');

  // Idempotency guard — same reference already applied.
  if (target.lastFeaturedReference && target.lastFeaturedReference === reference) {
    logger.info('Featured already applied for reference — skipping', { targetId, reference });
    return { featuredUntil: target.featuredUntil, days: boostDays };
  }

  const now  = new Date();
  const base = target.featuredUntil && target.featuredUntil > now ? target.featuredUntil : now;
  const featuredUntil = new Date(base.getTime() + boostDays * 24 * 60 * 60 * 1000);

  target.featuredUntil        = featuredUntil;
  target.lastFeaturedReference = reference;
  await target.save();

  await bustListCaches(targetType, target);

  logger.info('Featured listing activated', { targetType, targetId, days: boostDays, featuredUntil, reference });
  logActivity(target.userId || target.owner, null, 'featured.activated', {
    targetType, days: boostDays, featuredUntil, reference,
  });

  return { featuredUntil, days: boostDays };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — pricing (safe unauthenticated)
// ─────────────────────────────────────────────────────────────────────────────
export const getFeaturedPricing = async (_req, res) => {
  res.json({
    success: true,
    data: {
      currency: 'NGN',
      packages: Object.values(FEATURED_PACKAGES),
      benefits: [
        'Ranked at the top of search results',
        'Highlighted "Featured" badge on your card',
        'More profile views and contact taps',
      ],
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATED — current boost status for the caller's listing
// ─────────────────────────────────────────────────────────────────────────────
export const getMyFeaturedStatus = async (req, res) => {
  const userId = req.user._id || req.user.id;
  try {
    const { targetType, target } = await resolveTarget(userId);
    if (!target) {
      return res.status(404).json({ success: false, message: 'No listing found for this account.' });
    }

    const now      = new Date();
    const isActive = target.featuredUntil && new Date(target.featuredUntil) > now;

    return res.json({
      success: true,
      data: {
        targetType,
        isFeatured:    !!isActive,
        featuredUntil: isActive ? target.featuredUntil : null,
        daysRemaining: isActive
          ? Math.ceil((new Date(target.featuredUntil) - now) / (1000 * 60 * 60 * 24))
          : 0,
      },
    });
  } catch (error) {
    logger.error('Get featured status error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to fetch featured status.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTICATED — initialize a featured-boost payment
// Body: { days: 7 | 14 | 30 }
// ─────────────────────────────────────────────────────────────────────────────
export const createFeaturedPayment = async (req, res) => {
  const userId = req.user._id || req.user.id;
  const days   = parseInt(req.body.days, 10);

  if (!PAYSTACK_SECRET) {
    return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  }

  const pkg = FEATURED_PACKAGES[days];
  if (!pkg) {
    return res.status(400).json({ success: false, message: 'Invalid boost package. Choose 7, 14 or 30 days.' });
  }

  try {
    const user = await User.findById(userId);
    if (!user)       return res.status(404).json({ success: false, message: 'User not found.' });
    if (!user.email) return res.status(400).json({ success: false, message: 'Account email required to pay.' });

    const { targetType, target } = await resolveTarget(userId);
    if (!target) {
      return res.status(403).json({
        success: false,
        message: 'Register your business or shop before boosting a listing.',
      });
    }

    const displayName = user.name || user.email.split('@')[0];

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email:    user.email,
        amount:   pkg.price * 100,
        currency: 'NGN',
        metadata: {
          type:       'featured',
          targetType,
          targetId:   target._id.toString(),
          days:       pkg.days,
          userId:     userId.toString(),
          userName:   displayName,
        },
        callback_url: process.env.PAYSTACK_CALLBACK_URL,
        channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer'],
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } },
    );

    const { data } = initRes;
    if (!data?.status || !data?.data) {
      return res.status(500).json({ success: false, message: 'Payment initialization failed.' });
    }

    logActivity(userId, user.role, 'featured.initiated', {
      targetType, days: pkg.days, amount: pkg.price,
    }, req);

    return res.status(201).json({
      success: true,
      message: 'Boost payment initialized.',
      data: {
        authorization_url: data.data.authorization_url,
        reference:         data.data.reference,
        amount:            pkg.price,
        days:              pkg.days,
      },
    });
  } catch (error) {
    logger.error('Create featured payment error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to start boost payment.' });
  }
};
