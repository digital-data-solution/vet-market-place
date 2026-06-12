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

const PAYSTACK_BASE   = process.env.PAYSTACK_BASE        || 'https://api.paystack.co';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY  || '';

const PLAN_PRICING = {
  // Pet owner plans
  user_premium: 1500,
  user_monthly: 1500, // legacy alias

  // Professional plans
  basic:   1500, // entry-level listing tier
  starter: 2500,
  pro:     5000,
};

// Plans the subscription endpoints accept (guards against arbitrary strings)
const VALID_USER_PLANS         = new Set(['user_premium', 'user_monthly']);
const VALID_PROFESSIONAL_PLANS = new Set(['starter', 'pro', 'basic']);

const PENDING_GRACE_MS = 30 * 60 * 1000; // 30 minutes

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
    return {
      plan:      user.subscription.plan,
      status:    'active',
      expiresAt: user.subscription.endDate,
    };
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
    return {
      plan:      subscription.plan,
      status:    'active',
      expiresAt: subscription.endDate,
    };
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

  // Email + referral reward — fire-and-forget to avoid blocking the webhook response
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
      // Vet not yet approved: referral reward deferred to verification-approval time
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
          plan:     'free',
          price:    0,
          label:    'Free',
          features: [
            'Browse vet and shop listings',
            'See names and specializations',
            'General location (city only)',
          ],
        },
        premium: {
          plan:     'user_premium',
          price:    PLAN_PRICING.user_premium,
          label:    'Premium',
          features: [
            'Full contact details (phone & email)',
            'Exact address for every listing',
            'Unlimited search results',
            'GPS nearby search',
          ],
        },
      },
      professional: {
        starter: {
          plan:     'starter',
          price:    PLAN_PRICING.starter,
          label:    'Starter',
          features: [
            'Listed in search results',
            'Full profile visible to subscribers',
            'Phone & email shown to Premium users',
            'Appear in nearby searches',
          ],
        },
        pro: {
          plan:     'pro',
          price:    PLAN_PRICING.pro,
          label:    'Pro',
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
  // ── DEBUG LOGS — remove after confirming webhook works ───────────────────
  console.log('🔔 WEBHOOK HIT');
  console.log('Body type:', typeof req.body, '| Is Buffer:', Buffer.isBuffer(req.body));
  console.log('Signature header:', req.headers['x-paystack-signature']);
  console.log('Content-Type:', req.headers['content-type']);
  // ─────────────────────────────────────────────────────────────────────────

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

    if (event.event === 'charge.success' && event.data?.status === 'success') {
      const metadata = event.data.metadata || {};

      if (metadata.subscriptionType === 'user') {
        console.log('▶ Activating user subscription for userId:', metadata.userId);
        await activateUserSubscription(
          metadata.userId,
          metadata.plan,
          event.data.reference,
        );
        console.log('✅ User subscription activated');
      } else if (metadata.subscriptionType === 'professional') {
        console.log('▶ Activating professional subscription for subscriptionId:', metadata.subscriptionId);
        await activateProfessionalSubscription(
          metadata.subscriptionId,
          event.data.reference,
        );
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
        data: {
          status:      'pending',
          graceEndsAt: graceEndsAt(sub),
        },
      });
    }

    const baseAmount  = PLAN_PRICING[plan];
    const isFirstSub  = !user.subscription?.paymentReference;
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
      {
        headers: {
          Authorization:  `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json',
        },
      },
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
      status:  'active',
      endDate: { $gte: new Date() },
    }).session(session);

    if (existing) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'You already have an active subscription.' });
    }

    const pendingSub = await Subscription.findOne({
      user:   userId,
      status: 'pending',
    })
      .sort({ createdAt: -1 })
      .session(session);

    if (pendingSub && isWithinPendingGrace(pendingSub)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'A payment is already being processed. Please wait for it to confirm.',
        data: {
          status:      'pending',
          graceEndsAt: graceEndsAt(pendingSub),
        },
      });
    }

    const priorSubCount = await Subscription.countDocuments({ user: userId }).session(session);

    await Subscription.updateMany(
      { user: userId, status: 'pending' },
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
      {
        headers: {
          Authorization:  `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json',
        },
      },
    );

    const { data } = initRes;

    if (!data?.status || !data?.data) {
      await session.abortTransaction();
      return res.status(500).json({ success: false, message: 'Payment initialization failed.' });
    }

    subscription.paymentReference = data.data.reference;
    await subscription.save({ session });
    await session.commitTransaction();

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
      const professionalSub = await Subscription.findOne({ user: userId })
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
            plan:          professionalSub.plan,
            status:        'pending',
            amount:        professionalSub.amount,
            expiresAt:     professionalSub.endDate,
            daysRemaining: 0,
            isActive:      inGrace,
            isPending:     true,
            graceEndsAt:   graceExpiry,
            ...(inGrace && {
              notice: 'Your payment is being confirmed. You have full access while we wait.',
            }),
          },
        });
      }

      const endDate     = new Date(professionalSub.endDate);
      const justExpired = professionalSub.status === 'active' && now > endDate;

      if (justExpired) {
        await Subscription.findByIdAndUpdate(
          professionalSub._id,
          { status: 'expired' },
          { returnDocument: 'after' },
        );
        professionalSub.status = 'expired';
      }

      const isActive      = professionalSub.status === 'active' && !justExpired;
      const daysRemaining = isActive
        ? Math.ceil((endDate - now) / (1000 * 60 * 60 * 24))
        : 0;

      return res.json({
        success: true,
        data: {
          plan:          professionalSub.plan,
          status:        professionalSub.status,
          amount:        professionalSub.amount,
          expiresAt:     professionalSub.endDate,
          daysRemaining,
          isActive,
          isPending:     false,
          graceEndsAt:   null,
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
          plan:          sub.plan,
          status:        'pending',
          amount:        sub.amount ?? PLAN_PRICING[sub.plan],
          expiresAt:     sub.endDate ?? null,
          daysRemaining: 0,
          isActive:      inGrace,
          isPending:     true,
          graceEndsAt:   graceExpiry,
          ...(inGrace && {
            notice: 'Your payment is being confirmed. You have full access while we wait.',
          }),
        },
      });
    }

    const endDate     = new Date(sub.endDate);
    const justExpired = sub.status === 'active' && now > endDate;

    if (justExpired) {
      await User.findByIdAndUpdate(
        userId,
        { 'subscription.status': 'expired' },
        { returnDocument: 'after' },
      );
      sub.status = 'expired';
    }

    const isActive      = sub.status === 'active' && !justExpired;
    const daysRemaining = isActive
      ? Math.ceil((endDate - now) / (1000 * 60 * 60 * 24))
      : 0;

    return res.json({
      success: true,
      data: {
        plan:          sub.plan,
        status:        sub.status,
        amount:        sub.amount ?? PLAN_PRICING[sub.plan],
        expiresAt:     sub.endDate,
        daysRemaining,
        isActive,
        isPending:     false,
        graceEndsAt:   null,
      },
    });
  } catch (error) {
    logger.error('Get subscription error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to fetch subscription.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL PENDING
// ─────────────────────────────────────────────────────────────────────────────

export const cancelPendingSubscription = async (req, res) => {
  const userId = req.user._id || req.user.id;

  try {
    const pendingSubs = await Subscription.find({ user: userId, status: 'pending' }).lean();

    for (const s of pendingSubs) {
      if (isWithinPendingGrace(s)) {
        return res.status(400).json({
          success: false,
          message: 'Your payment is still being confirmed. Please wait before cancelling.',
          data: { graceEndsAt: graceEndsAt(s) },
        });
      }
    }

    await Subscription.updateMany(
      { user: userId, status: 'pending' },
      { $set: { status: 'cancelled' } },
    );

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

    const professionalSub = await Subscription.findOne({ user: userId, status: 'active' });

    if (professionalSub) {
      professionalSub.status = 'cancelled';
      await professionalSub.save();
      return res.json({
        success: true,
        message: 'Subscription cancelled. You will retain access until your billing period ends.',
        data: { accessUntil: professionalSub.endDate },
      });
    }

    if (user.subscription?.status === 'active') {
      user.subscription.status = 'cancelled';
      await user.save();
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
      result = await activateUserSubscription(
        metadata.userId,
        metadata.plan,
        reference,
      );
    } else if (metadata.subscriptionType === 'professional') {
      result = await activateProfessionalSubscription(
        metadata.subscriptionId,
        reference,
      );
    } else {
      return res.status(400).json({
        success: false,
        message: 'Unknown subscription type in metadata.',
      });
    }

    return res.json({
      success: true,
      message: 'Payment verified and subscription activated!',
      data:    result,
    });
  } catch (error) {
    logger.error('Verify payment error', { error: error.message, reference });
    return res.status(500).json({ success: false, message: 'Failed to verify payment.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN STATS
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
      userActive,
      totalUsers,
    ] = await Promise.all([
      Subscription.countDocuments({ status: 'active', endDate: { $gte: now } }),
      Subscription.countDocuments({ status: 'pending' }),
      Subscription.countDocuments({ status: 'expired' }),
      Subscription.countDocuments({ status: 'cancelled' }),
      Subscription.countDocuments({ plan: { $in: ['starter', 'basic'] }, status: 'active', endDate: { $gte: now } }),
      Subscription.countDocuments({ plan: 'pro',                        status: 'active', endDate: { $gte: now } }),
      Subscription.aggregate([
        { $match: { status: 'active', endDate: { $gte: now } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      User.countDocuments({ 'subscription.status': 'active', 'subscription.plan': { $in: ['user_premium', 'user_monthly'] } }),
      User.countDocuments({}),
    ]);

    const professionalRevenue = professionalRevenueAgg[0]?.total || 0;
    const userRevenue         = userActive * PLAN_PRICING.user_monthly;
    const totalRevenue        = professionalRevenue + userRevenue;

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
          totalActiveSubscriptions: professionalActive + userActive,
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