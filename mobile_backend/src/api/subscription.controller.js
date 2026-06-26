import Subscription from '../models/Subscription.js';
import Professional from '../models/Professional.js';
import Shop         from '../models/Shop.js';
import User         from '../models/User.js';
import axios        from 'axios';
import crypto       from 'crypto';
import logger       from '../lib/logger.js';
import mongoose     from 'mongoose';
import {
  sendUserSubscriptionConfirmed,
  sendProfessionalSubscriptionConfirmed,
} from '../services/email.service.js';
import { applyReferralReward } from '../lib/referralHelper.js';
import { logActivity }         from '../lib/activityLogger.js';

const PAYSTACK_BASE        = process.env.PAYSTACK_BASE        || 'https://api.paystack.co';
const PAYSTACK_SECRET      = process.env.PAYSTACK_SECRET_KEY  || '';
const AJOAPP_WEBHOOK_URL   = process.env.AJOAPP_WEBHOOK_URL   || '';

const PLAN_PRICING = {
  user_premium: 1500,
  user_monthly: 1500,
  user_plus:    3500,
  basic:        1500,
  starter:      2500,
  pro:          5000,
};

const USER_PLAN_TIER = { user_premium: 1, user_monthly: 1, user_plus: 2 };

const VALID_USER_PLANS         = new Set(['user_premium', 'user_monthly', 'user_plus']);
const VALID_PROFESSIONAL_PLANS = new Set(['starter', 'pro', 'basic']);

const PENDING_GRACE_MS = 30 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function isWithinPendingGrace(sub) {
  const anchor =
    sub.paymentInitiatedAt ||
    sub.createdAt          ||
    sub.updatedAt          ||
    null;
  if (!anchor) return false;
  return Date.now() - new Date(anchor).getTime() <= PENDING_GRACE_MS;
}

function graceEndsAt(sub) {
  const anchor =
    sub.paymentInitiatedAt ||
    sub.createdAt          ||
    sub.updatedAt          ||
    null;
  return anchor
    ? new Date(new Date(anchor).getTime() + PENDING_GRACE_MS)
    : null;
}

async function activateUserSubscription(userId, plan, reference) {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  if (
    user.subscription?.paymentReference === reference &&
    user.subscription?.status === 'active'
  ) {
    logger.info('User subscription already active — skipping duplicate activation', { userId, reference });
    return { plan: user.subscription.plan, status: 'active', expiresAt: user.subscription.endDate };
  }

  const startDate = new Date();
  const endDate   = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + 1);

  user.subscription = {
    plan,
    status:             'active',
    startDate,
    endDate,
    paymentReference:   reference,
    paymentInitiatedAt: user.subscription?.paymentInitiatedAt ?? startDate,
    amount:             PLAN_PRICING[plan],
  };

  await user.save();
  logger.info('User subscription activated', { userId, plan, reference });
  sendUserSubscriptionConfirmed(user.name, user.email, plan, PLAN_PRICING[plan], endDate).catch(() => {});
  logActivity(userId, user.role, 'subscription.activated', { plan, amount: PLAN_PRICING[plan], reference, userType: 'user' });
  if (user.referredBy && !user.referralRewardApplied) {
    applyReferralReward(user, 30).catch(() => {});
  }
  return { plan, status: 'active', expiresAt: endDate };
}

async function activateProfessionalSubscription(subscriptionId, reference) {
  const subscription = await Subscription.findById(subscriptionId);
  if (!subscription) throw new Error('Subscription not found');

  if (
    subscription.paymentReference === reference &&
    subscription.status === 'active'
  ) {
    logger.info('Professional subscription already active — skipping duplicate activation', { subscriptionId, reference });
    return { plan: subscription.plan, status: 'active', expiresAt: subscription.endDate };
  }

  const startDate = new Date();
  const endDate   = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + 1);

  subscription.status           = 'active';
  subscription.paymentReference = reference;
  subscription.startDate        = startDate;
  subscription.endDate          = endDate;

  await subscription.save();
  logger.info('Professional subscription activated', { subscriptionId, reference });
  logActivity(subscription.user, null, 'subscription.activated', { plan: subscription.plan, amount: subscription.amount, reference, userType: 'professional' });

  User.findById(subscription.user).then(async (usr) => {
    if (usr?.email) {
      sendProfessionalSubscriptionConfirmed(
        usr.name, usr.email, subscription.plan,
        subscription.amount || 2500, endDate,
      ).catch(() => {});
    }
    if (usr?.referredBy && !usr?.referralRewardApplied) {
      const isVet       = usr.role === 'vet';
      const vetApproved = usr.vetVerification?.status === 'approved';
      if (!isVet || vetApproved) {
        const bonusDays = isVet ? 60 : 30;
        await applyReferralReward(usr, bonusDays);
      }
    }
  }).catch(() => {});

  return { plan: subscription.plan, status: 'active', expiresAt: endDate };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — Pricing
// ─────────────────────────────────────────────────────────────────────────────

export const getPricing = async (req, res) => {
  res.json({
    success: true,
    data: {
      currency: 'NGN',
      petOwner: {
        free: {
          plan: 'free', price: 0, label: 'Free',
          features: [
            'Browse vet and shop listings',
            'See names and specializations',
            'General location (city only)',
          ],
        },
        premium: {
          plan: 'user_premium', price: PLAN_PRICING.user_premium, label: 'Premium',
          features: [
            'Full contact details (phone & email)',
            'Exact address for every listing',
            'Unlimited search results',
            'GPS nearby search',
          ],
        },
        premiumPlus: {
          plan: 'user_plus', price: PLAN_PRICING.user_plus, label: 'Premium Plus',
          features: [
            'Everything in Premium',
            'Verified Pet Parent badge on profile',
            'Priority customer support',
            'Early access to new platform features',
          ],
        },
      },
      professional: {
        starter: {
          plan: 'starter', price: PLAN_PRICING.starter, label: 'Starter',
          features: [
            'Listed in search results',
            'Full profile visible to subscribers',
            'Phone & email shown to Premium users',
            'Appear in nearby searches',
          ],
        },
        pro: {
          plan: 'pro', price: PLAN_PRICING.pro, label: 'Pro',
          features: [
            'Everything in Starter',
            'Featured badge on your profile',
            'Sorted to top of search results',
            'Priority placement in nearby search',
          ],
        },
      },
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────────────────────────────────────

export const handlePaystackWebhook = async (req, res) => {
  console.log('🔔 WEBHOOK HIT');
  console.log('Body type:', typeof req.body, '| Is Buffer:', Buffer.isBuffer(req.body));
  console.log('Signature header:', req.headers['x-paystack-signature']);
  console.log('Content-Type:', req.headers['content-type']);

  try {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) {
      console.log('❌ Webhook rejected: missing signature');
      return res.status(400).send('Missing signature');
    }

    if (!PAYSTACK_SECRET) {
      console.log('❌ Webhook rejected: PAYSTACK_SECRET_KEY not set');
      return res.status(500).send('Server misconfigured');
    }

    const computed = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(req.body)
      .digest('hex');

    console.log('Signature match:', signature === computed);

    if (signature !== computed) {
      console.log('❌ Webhook rejected: signature mismatch');
      return res.status(400).send('Invalid signature');
    }

    const event = JSON.parse(req.body.toString());
    console.log('✅ Webhook event:', event.event, '| Payment status:', event.data?.status);
    console.log('Metadata:', JSON.stringify(event.data?.metadata));

    // Route AjoApp events to the AjoApp backend
    if (event.data?.metadata?.app === 'ajoapp') {
      if (!AJOAPP_WEBHOOK_URL) {
        console.log('⚠ AjoApp event received but AJOAPP_WEBHOOK_URL is not set — dropping event');
        return res.status(200).send('OK');
      }
      console.log(`📤 Forwarding AjoApp webhook event "${event.event}" to ${AJOAPP_WEBHOOK_URL}`);
      try {
        await axios.post(AJOAPP_WEBHOOK_URL, event, {
          headers: {
            'Content-Type': 'application/json',
            'x-paystack-signature': req.headers['x-paystack-signature'],
          },
          timeout: 10000,
        });
        console.log('✅ AjoApp webhook forwarded successfully');
      } catch (fwdErr) {
        console.log('⚠ AjoApp webhook forward failed:', fwdErr.message);
      }
      return res.status(200).send('OK');
    }

    if (event.event === 'charge.success' && event.data?.status === 'success') {
      const metadata = event.data.metadata || {};

      if (metadata.subscriptionType === 'user') {
        console.log('▶ Activating user subscription for userId:', metadata.userId);
        await activateUserSubscription(metadata.userId, metadata.plan, event.data.reference);
        console.log('✅ User subscription activated');
      } else if (metadata.subscriptionType === 'professional') {
        console.log('▶ Activating professional subscription for subscriptionId:', metadata.subscriptionId);
        await activateProfessionalSubscription(metadata.subscriptionId, event.data.reference);
        console.log('✅ Professional subscription activated');
      } else {
        console.log('⚠ Unknown subscriptionType in metadata:', metadata.subscriptionType);
      }
    } else {
      console.log('ℹ Event ignored (not charge.success):', event.event);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.log('❌ Webhook error:', error.message);
    logger.error('Webhook error', { error: error.message });
    res.status(500).send('Error');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PET OWNER SUBSCRIPTION
// ─────────────────────────────────────────────────────────────────────────────

export const createUserSubscription = async (req, res) => {
  const { plan } = req.body;
  const userId   = req.user._id || req.user.id;

  if (!PAYSTACK_SECRET) {
    return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  }

  if (!VALID_USER_PLANS.has(plan)) {
    return res.status(400).json({ success: false, message: 'Invalid plan. Use "user_premium".' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findById(userId).session(session);

    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (!user.email) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Account email required to subscribe.' });
    }

    const sub = user.subscription;

    if (sub?.status === 'active' && new Date() < new Date(sub.endDate)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'You already have an active subscription.' });
    }

    if (sub?.status === 'pending' && isWithinPendingGrace(sub)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'A payment is already being processed. Please wait for it to confirm.',
        data: { status: 'pending', graceEndsAt: graceEndsAt(sub) },
      });
    }

    const baseAmount = PLAN_PRICING[plan];

    // FIX: use referralRewardApplied + absence of a prior startDate as the
    // "first subscription" signal — more robust than checking paymentReference
    // alone, which can be set by a failed-then-abandoned first payment attempt.
    const isFirstSub  = !user.referralRewardApplied && !user.subscription?.startDate;
    const hasReferral = isFirstSub && !!user.referredBy;
    const amount      = hasReferral ? Math.round(baseAmount * 0.8 / 50) * 50 : baseAmount;
    const displayName = user.name || user.email.split('@')[0];
    const initiatedAt = new Date();

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email:    user.email,
        amount:   amount * 100,
        currency: 'NGN',
        metadata: {
          userId:           userId.toString(),
          userName:         displayName,
          plan,
          subscriptionType: 'user',
        },
        callback_url: process.env.PAYSTACK_CALLBACK_URL,
        channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer'],
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } },
    );

    const { data } = initRes;

    if (!data?.status || !data?.data) {
      await session.abortTransaction();
      return res.status(500).json({ success: false, message: 'Payment initialization failed.' });
    }

    user.subscription = {
      plan,
      status:             'pending',
      paymentReference:   data.data.reference,
      paymentInitiatedAt: initiatedAt,
      amount,
    };

    await user.save({ session });
    await session.commitTransaction();

    logActivity(userId, user.role, 'subscription.initiated', {
      plan,
      amount,
      hasReferralDiscount: hasReferral,
      userType: 'user',
    }, req);

    return res.status(201).json({
      success: true,
      message: 'Payment initialized.',
      data: {
        authorization_url: data.data.authorization_url,
        reference:         data.data.reference,
        amount,
        ...(hasReferral && { referralDiscount: true, originalAmount: baseAmount }),
      },
    });
  } catch (error) {
    await session.abortTransaction();
    logger.error('Create user subscription error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to create subscription.' });
  } finally {
    session.endSession();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PET OWNER PLAN UPGRADE (no cancel required — user keeps access until payment clears)
// ─────────────────────────────────────────────────────────────────────────────

export const upgradeUserSubscription = async (req, res) => {
  const { plan } = req.body;
  const userId   = req.user._id || req.user.id;

  if (!PAYSTACK_SECRET) {
    return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  }

  if (!VALID_USER_PLANS.has(plan)) {
    return res.status(400).json({ success: false, message: 'Invalid plan.' });
  }

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!user.email) return res.status(400).json({ success: false, message: 'Account email required.' });

    const sub      = user.subscription;
    const isActive = sub?.status === 'active' && new Date() < new Date(sub.endDate);

    if (!isActive) {
      return res.status(400).json({
        success: false,
        message: 'No active subscription to upgrade from. Please subscribe first.',
      });
    }

    const currentTier = USER_PLAN_TIER[sub.plan] ?? 0;
    const newTier     = USER_PLAN_TIER[plan]     ?? 0;

    if (newTier <= currentTier) {
      return res.status(400).json({
        success: false,
        message: 'You can only upgrade to a higher plan tier.',
      });
    }

    const amount      = PLAN_PRICING[plan];
    const displayName = user.name || user.email.split('@')[0];

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email:    user.email,
        amount:   amount * 100,
        currency: 'NGN',
        metadata: {
          userId:           userId.toString(),
          userName:         displayName,
          plan,
          subscriptionType: 'user',
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

    logActivity(userId, user.role, 'subscription.upgrade.initiated', {
      from: sub.plan, to: plan, amount,
    }, req);

    return res.status(201).json({
      success: true,
      message: 'Upgrade payment initialized. Your current plan stays active until the upgrade confirms.',
      data: {
        authorization_url: data.data.authorization_url,
        reference:         data.data.reference,
        amount,
      },
    });
  } catch (error) {
    logger.error('Upgrade user subscription error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to initialize upgrade.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PROFESSIONAL SUBSCRIPTION
// ─────────────────────────────────────────────────────────────────────────────

export const createProfessionalSubscription = async (req, res) => {
  const { plan } = req.body;
  const userId   = req.user._id || req.user.id;

  if (!PAYSTACK_SECRET) {
    return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  }

  if (!VALID_PROFESSIONAL_PLANS.has(plan)) {
    return res.status(400).json({ success: false, message: 'Invalid plan. Use "starter" or "pro".' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findById(userId).session(session);

    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (!user.email) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Account email required to subscribe.' });
    }

    const [isProfessional, isShop] = await Promise.all([
      Professional.findOne({ userId }).session(session),
      Shop.findOne({ owner: userId }).session(session),
    ]);

    if (!isProfessional && !isShop) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: 'Professional account required. Please register your business first.',
      });
    }

    const existing = await Subscription.findOne({
      user:    userId,
      plan:    { $ne: 'messaging' },
      status:  'active',
      endDate: { $gte: new Date() },
    }).session(session);

    if (existing) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'You already have an active subscription.' });
    }

    const pendingSub = await Subscription.findOne({
      user:   userId,
      plan:   { $ne: 'messaging' },
      status: 'pending',
    })
      .sort({ createdAt: -1 })
      .session(session);

    if (pendingSub && isWithinPendingGrace(pendingSub)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'A payment is already being processed. Please wait for it to confirm.',
        data: { status: 'pending', graceEndsAt: graceEndsAt(pendingSub) },
      });
    }

    const priorSubCount = await Subscription.countDocuments({
      user: userId,
      plan: { $ne: 'messaging' },
    }).session(session);

    await Subscription.updateMany(
      { user: userId, plan: { $ne: 'messaging' }, status: 'pending' },
      { $set: { status: 'cancelled' } },
      { session },
    );

    const baseAmount  = PLAN_PRICING[plan];
    const hasReferral = priorSubCount === 0 && !!user.referredBy;
    const amount      = hasReferral ? Math.round(baseAmount * 0.8 / 50) * 50 : baseAmount;
    const displayName = user.name || user.email.split('@')[0];
    const initiatedAt = new Date();

    const endDate = new Date(initiatedAt);
    endDate.setMonth(endDate.getMonth() + 1);

    const subscription = new Subscription({
      user:               userId,
      plan,
      amount,
      endDate,
      status:             'pending',
      paymentInitiatedAt: initiatedAt,
    });

    await subscription.save({ session });

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email:    user.email,
        amount:   amount * 100,
        currency: 'NGN',
        metadata: {
          subscriptionId:   subscription._id.toString(),
          userId:           userId.toString(),
          userName:         displayName,
          plan,
          subscriptionType: 'professional',
        },
        callback_url: process.env.PAYSTACK_CALLBACK_URL,
        channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer'],
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } },
    );

    const { data } = initRes;

    if (!data?.status || !data?.data) {
      await session.abortTransaction();
      return res.status(500).json({ success: false, message: 'Payment initialization failed.' });
    }

    subscription.paymentReference = data.data.reference;
    await subscription.save({ session });
    await session.commitTransaction();

    logActivity(userId, user.role, 'subscription.initiated', {
      plan,
      amount,
      subscriptionId:      subscription._id,
      hasReferralDiscount: hasReferral,
      userType:            'professional',
    }, req);

    return res.status(201).json({
      success: true,
      message: 'Payment initialized.',
      data: {
        authorization_url: data.data.authorization_url,
        reference:         data.data.reference,
        amount,
        subscription: { id: subscription._id, plan, amount },
        ...(hasReferral && { referralDiscount: true, originalAmount: baseAmount }),
      },
    });
  } catch (error) {
    await session.abortTransaction();
    logger.error('Create professional subscription error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to create subscription.' });
  } finally {
    session.endSession();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET CURRENT SUBSCRIPTION
// ─────────────────────────────────────────────────────────────────────────────

export const getUserSubscription = async (req, res) => {
  const userId = req.user._id || req.user.id;
  const role   = req.user.role || 'pet_owner';

  try {
    const user = await User.findById(userId).lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const now = new Date();

    if (role !== 'pet_owner') {
      const professionalSub = await Subscription.findOne({
        user: userId,
        plan: { $ne: 'messaging' },
      })
        .sort({ createdAt: -1 })
        .lean();

      if (!professionalSub) {
        return res.status(404).json({ success: false, message: 'No subscription found.', data: null });
      }

      if (professionalSub.status === 'pending') {
        const inGrace     = isWithinPendingGrace(professionalSub);
        const graceExpiry = graceEndsAt(professionalSub);
        return res.json({
          success: true,
          data: {
            plan: professionalSub.plan, status: 'pending', amount: professionalSub.amount,
            expiresAt: professionalSub.endDate, daysRemaining: 0, isActive: inGrace,
            isPending: true, graceEndsAt: graceExpiry,
            ...(inGrace && { notice: 'Your payment is being confirmed. You have full access while we wait.' }),
          },
        });
      }

      const endDate     = new Date(professionalSub.endDate);
      const justExpired = professionalSub.status === 'active' && now > endDate;

      if (justExpired) {
        await Subscription.findByIdAndUpdate(professionalSub._id, { status: 'expired' }, { returnDocument: 'after' });
        professionalSub.status = 'expired';
      }

      const isActive      = professionalSub.status === 'active' && !justExpired;
      const daysRemaining = isActive ? Math.ceil((endDate - now) / (1000 * 60 * 60 * 24)) : 0;

      return res.json({
        success: true,
        data: {
          plan: professionalSub.plan, status: professionalSub.status, amount: professionalSub.amount,
          expiresAt: professionalSub.endDate, daysRemaining, isActive, isPending: false, graceEndsAt: null,
        },
      });
    }

    if (!user.subscription) {
      return res.status(404).json({ success: false, message: 'No subscription found.', data: null });
    }

    const sub = user.subscription;

    if (sub.status === 'pending') {
      const inGrace     = isWithinPendingGrace(sub);
      const graceExpiry = graceEndsAt(sub);
      return res.json({
        success: true,
        data: {
          plan: sub.plan, status: 'pending', amount: sub.amount ?? PLAN_PRICING[sub.plan],
          expiresAt: sub.endDate ?? null, daysRemaining: 0, isActive: inGrace,
          isPending: true, graceEndsAt: graceExpiry,
          ...(inGrace && { notice: 'Your payment is being confirmed. You have full access while we wait.' }),
        },
      });
    }

    const endDate     = new Date(sub.endDate);
    const justExpired = sub.status === 'active' && now > endDate;

    if (justExpired) {
      await User.findByIdAndUpdate(userId, { 'subscription.status': 'expired' }, { returnDocument: 'after' });
      sub.status = 'expired';
    }

    const isActive      = sub.status === 'active' && !justExpired;
    const daysRemaining = isActive ? Math.ceil((endDate - now) / (1000 * 60 * 60 * 24)) : 0;

    return res.json({
      success: true,
      data: {
        plan: sub.plan, status: sub.status, amount: sub.amount ?? PLAN_PRICING[sub.plan],
        expiresAt: sub.endDate, daysRemaining, isActive, isPending: false, graceEndsAt: null,
      },
    });
  } catch (error) {
    logger.error('Get subscription error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to fetch subscription.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL PENDING
// FIX: accepts an optional `type` query param ("listing" | "messaging") so the
// client can target one plan group without touching the other.
// Default (no param) cancels listing-plan pending subs only — the safer choice.
// ─────────────────────────────────────────────────────────────────────────────

export const cancelPendingSubscription = async (req, res) => {
  const userId = req.user._id || req.user.id;

  // "listing" = professional/user plans, "messaging" = messaging plan.
  // Omitting the param defaults to "listing" so existing clients aren't broken.
  const type = req.query.type === 'messaging' ? 'messaging' : 'listing';

  const planFilter =
    type === 'messaging'
      ? { plan: 'messaging' }
      : { plan: { $ne: 'messaging' } };

  try {
    // ── Grace-period check — only for the targeted plan group ───────────────
    const pendingSubs = await Subscription.find({
      user:   userId,
      status: 'pending',
      ...planFilter,
    }).lean();

    for (const s of pendingSubs) {
      if (isWithinPendingGrace(s)) {
        return res.status(400).json({
          success: false,
          message: 'Your payment is still being confirmed. Please wait before cancelling.',
          data: { graceEndsAt: graceEndsAt(s) },
        });
      }
    }

    // ── Cancel stale Subscription documents (targeted group only) ───────────
    await Subscription.updateMany(
      { user: userId, status: 'pending', ...planFilter },
      { $set: { status: 'cancelled' } },
    );

    // ── For listing-type cancellations also clear user.subscription ──────────
    if (type === 'listing') {
      const user = await User.findById(userId);
      if (user?.subscription?.status === 'pending') {
        if (isWithinPendingGrace(user.subscription)) {
          return res.status(400).json({
            success: false,
            message: 'Your payment is still being confirmed. Please wait before cancelling.',
            data: { graceEndsAt: graceEndsAt(user.subscription) },
          });
        }
        user.subscription.status = 'cancelled';
        await user.save();
      }
    }

    return res.json({ success: true, message: 'Pending subscription cleared.' });
  } catch (error) {
    logger.error('Cancel pending error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to clear pending subscription.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL ACTIVE (soft cancel)
// ─────────────────────────────────────────────────────────────────────────────

export const cancelSubscription = async (req, res) => {
  const userId = req.user._id || req.user.id;

  try {
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const professionalSub = await Subscription.findOne({
      user:   userId,
      plan:   { $ne: 'messaging' },
      status: 'active',
    });

    if (professionalSub) {
      professionalSub.status = 'cancelled';
      await professionalSub.save();
      logActivity(userId, user.role, 'subscription.cancelled', {
        plan:       professionalSub.plan,
        accessUntil: professionalSub.endDate,
        userType:   'professional',
      }, req);
      return res.json({
        success: true,
        message: 'Subscription cancelled. You will retain access until your billing period ends.',
        data: { accessUntil: professionalSub.endDate },
      });
    }

    if (user.subscription?.status === 'active') {
      user.subscription.status = 'cancelled';
      await user.save();
      logActivity(userId, user.role, 'subscription.cancelled', {
        plan:        user.subscription.plan,
        accessUntil: user.subscription.endDate,
        userType:    'user',
      }, req);
      return res.json({
        success: true,
        message: 'Subscription cancelled. You will retain access until your billing period ends.',
        data: { accessUntil: user.subscription.endDate },
      });
    }

    return res.status(404).json({ success: false, message: 'No active subscription found.' });
  } catch (error) {
    logger.error('Cancel subscription error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to cancel subscription.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY PAYMENT (manual fallback — webhook is primary)
// ─────────────────────────────────────────────────────────────────────────────

export const verifyPayment = async (req, res) => {
  const { reference } = req.query;

  if (!reference) {
    return res.status(400).json({ success: false, message: 'Payment reference required.' });
  }

  try {
    const verifyRes = await axios.get(
      `${PAYSTACK_BASE}/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } },
    );

    const { data } = verifyRes;

    if (!data?.status || !data?.data || data.data.status !== 'success') {
      return res.status(400).json({ success: false, message: 'Payment not confirmed by Paystack.' });
    }

    const metadata = data.data.metadata || {};
    let result;

    if (metadata.subscriptionType === 'user') {
      result = await activateUserSubscription(metadata.userId, metadata.plan, reference);
    } else if (metadata.subscriptionType === 'professional') {
      result = await activateProfessionalSubscription(metadata.subscriptionId, reference);
    } else {
      return res.status(400).json({ success: false, message: 'Unknown subscription type in metadata.' });
    }

    return res.json({ success: true, message: 'Payment verified and subscription activated!', data: result });
  } catch (error) {
    logger.error('Verify payment error', { error: error.message, reference });
    return res.status(500).json({ success: false, message: 'Failed to verify payment.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN STATS
// FIX: plan filter applied consistently across all four professional status counts
// ─────────────────────────────────────────────────────────────────────────────

export const getSubscriptionStats = async (req, res) => {
  try {
    const now = new Date();

    const [
      professionalActive,
      professionalPending,
      professionalExpired,
      professionalCancelled,
      starterCount,
      proCount,
      professionalRevenueAgg,
      messagingActive,
      messagingRevenueAgg,
      userActive,
      totalUsers,
    ] = await Promise.all([
      Subscription.countDocuments({ plan: { $ne: 'messaging' }, status: 'active',    endDate: { $gte: now } }),
      Subscription.countDocuments({ plan: { $ne: 'messaging' }, status: 'pending'   }),
      Subscription.countDocuments({ plan: { $ne: 'messaging' }, status: 'expired'   }),
      Subscription.countDocuments({ plan: { $ne: 'messaging' }, status: 'cancelled' }),
      Subscription.countDocuments({ plan: { $in: ['starter', 'basic'] }, status: 'active', endDate: { $gte: now } }),
      Subscription.countDocuments({ plan: 'pro',                         status: 'active', endDate: { $gte: now } }),
      Subscription.aggregate([
        { $match: { plan: { $ne: 'messaging' }, status: 'active', endDate: { $gte: now } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Subscription.countDocuments({ plan: 'messaging', status: 'active', endDate: { $gte: now } }),
      Subscription.aggregate([
        { $match: { plan: 'messaging', status: 'active', endDate: { $gte: now } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      User.countDocuments({ 'subscription.status': 'active', 'subscription.plan': { $in: ['user_premium', 'user_monthly', 'user_plus'] } }),
      User.countDocuments({}),
    ]);

    const professionalRevenue = professionalRevenueAgg[0]?.total || 0;
    const messagingRevenue    = messagingRevenueAgg[0]?.total    || 0;
    const userRevenue         = userActive * PLAN_PRICING.user_monthly;
    const totalRevenue        = professionalRevenue + messagingRevenue + userRevenue;

    return res.json({
      success: true,
      data: {
        professional: {
          active:         professionalActive,
          pending:        professionalPending,
          expired:        professionalExpired,
          cancelled:      professionalCancelled,
          byPlan:         { starter: starterCount, pro: proCount },
          monthlyRevenue: professionalRevenue,
        },
        messaging: {
          active:         messagingActive,
          monthlyRevenue: messagingRevenue,
        },
        users: {
          total:             totalUsers,
          activeSubscribers: userActive,
          monthlyRevenue:    userRevenue,
          conversionRate:
            totalUsers > 0
              ? ((userActive / totalUsers) * 100).toFixed(2) + '%'
              : '0%',
        },
        summary: {
          totalActiveSubscriptions: professionalActive + messagingActive + userActive,
          totalMonthlyRevenue:      totalRevenue,
          currency:                 'NGN',
        },
      },
    });
  } catch (error) {
    logger.error('Get stats error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch statistics.' });
  }
};