import Subscription from '../models/Subscription.js';
import Professional from '../models/Professional.js';
import Shop from '../models/Shop.js';
import User from '../models/User.js';
import axios from 'axios';
import crypto from 'crypto';
import logger from '../lib/logger.js';
import mongoose from 'mongoose';

const PAYSTACK_BASE = process.env.PAYSTACK_BASE || 'https://api.paystack.co';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET || '';

// TWO-TIER PRICING (Nigerian market)
const PLAN_PRICING = {
  user_monthly: 500,  // Pet owners  — ₦500/month  (stored on User.subscription)
  basic: 3000,        // Professionals — ₦3,000/month (stored in Subscription model)
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — Pricing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/subscriptions/pricing
 * No auth required.
 */
export const getPricing = async (req, res) => {
  res.json({
    success: true,
    data: {
      petOwners:     { price: PLAN_PRICING.user_monthly, plan: 'user_monthly' },
      professionals: { price: PLAN_PRICING.basic,        plan: 'basic'        },
      currency: 'NGN',
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK — must be mounted with express.raw() BEFORE express.json()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/subscriptions/webhook
 * Paystack sends raw body — do NOT parse as JSON before this handler.
 */
export const handlePaystackWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) return res.status(400).send('Missing signature');

    const computed = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(req.body)          // req.body is a Buffer here (express.raw)
      .digest('hex');

    if (signature !== computed) return res.status(400).send('Invalid signature');

    const event = JSON.parse(req.body.toString());

    if (event.event === 'charge.success' && event.data?.status === 'success') {
      const metadata = event.data.metadata || {};

      if (metadata.subscriptionType === 'user') {
        await activateUserSubscription(
          metadata.userId,
          metadata.plan,
          event.data.reference,
        );
      } else if (metadata.subscriptionType === 'professional') {
        await activateProfessionalSubscription(
          metadata.subscriptionId,
          event.data.reference,
        );
      }
    }

    // Always return 200 so Paystack stops retrying
    res.status(200).send('OK');
  } catch (error) {
    logger.error('Webhook error', { error: error.message });
    res.status(500).send('Error');
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PET OWNER SUBSCRIPTION — ₦500/month (embedded on User document)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/subscriptions/user
 * Body: { plan: 'user_monthly' }
 */
export const createUserSubscription = async (req, res) => {
  const { plan } = req.body;
  const userId = req.user._id || req.user.id;

  if (!PAYSTACK_SECRET) {
    return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  }

  if (plan !== 'user_monthly') {
    return res.status(400).json({ success: false, message: 'Invalid plan. Use "user_monthly".' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findById(userId).session(session);

    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (!user.email || !user.email.includes('@')) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Valid email required.' });
    }

    // Block duplicate active subscription
    const sub = user.subscription;
    if (sub?.status === 'active' && new Date() < new Date(sub.endDate)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'You already have an active subscription.' });
    }

    const amount = PLAN_PRICING[plan];

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email: user.email,
        amount: amount * 100, // Paystack expects kobo
        currency: 'NGN',
        metadata: {
          userId: userId.toString(),
          userName: user.name || user.email.split('@')[0],
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

    // Mark as pending so we can match the reference on webhook / verify
    user.subscription = {
      plan,
      status: 'pending',
      paymentReference: data.data.reference,
      amount,
    };

    await user.save({ session });
    await session.commitTransaction();

    return res.status(201).json({
      success: true,
      message: 'Payment initialized.',
      data: {
        authorization_url: data.data.authorization_url,
        reference: data.data.reference,
        amount,
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
// PROFESSIONAL SUBSCRIPTION — ₦3,000/month (Subscription collection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/subscriptions/professional
 * Body: { plan: 'basic' }
 */
export const createProfessionalSubscription = async (req, res) => {
  const { plan } = req.body;
  const userId = req.user._id || req.user.id;

  if (!PAYSTACK_SECRET) {
    return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  }

  if (plan !== 'basic') {
    return res.status(400).json({ success: false, message: 'Invalid plan. Use "basic".' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findById(userId).session(session);

    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (!user.email || !user.email.includes('@')) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Valid email required.' });
    }

    // Verify professional/shop account exists
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

    // Block duplicate active subscription
    const existing = await Subscription.findOne({
      user: userId,
      status: 'active',
      endDate: { $gte: new Date() },
    }).session(session);

    if (existing) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'You already have an active subscription.' });
    }

    const amount = PLAN_PRICING[plan];

    // endDate will be overwritten on activation; set 1 month ahead as a safe default
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    const subscription = new Subscription({
      user: userId,
      plan,
      amount,
      endDate,
      status: 'pending',
    });

    await subscription.save({ session });

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email: user.email,
        amount: amount * 100,
        currency: 'NGN',
        metadata: {
          subscriptionId: subscription._id.toString(),
          userId: userId.toString(),
          userName: user.name || user.email.split('@')[0],
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

    return res.status(201).json({
      success: true,
      message: 'Payment initialized.',
      data: {
        authorization_url: data.data.authorization_url,
        reference: data.data.reference,
        amount,
        subscription: { id: subscription._id, plan, amount },
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

/**
 * GET /api/subscriptions/me
 */
export const getUserSubscription = async (req, res) => {
  const userId = req.user._id || req.user.id;

  try {
    const user = await User.findById(userId).lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const now = new Date();

    // ── Professional subscription (Subscription collection) ──────────────────
    const professionalSub = await Subscription.findOne({ user: userId })
      .sort({ createdAt: -1 })
      .lean();

    if (professionalSub) {
      const endDate = new Date(professionalSub.endDate);
      const justExpired = professionalSub.status === 'active' && now > endDate;

      if (justExpired) {
        await Subscription.findByIdAndUpdate(professionalSub._id, { status: 'expired' });
        professionalSub.status = 'expired';
      }

      const isActive = professionalSub.status === 'active' && !justExpired;
      const daysRemaining = isActive
        ? Math.ceil((endDate - now) / (1000 * 60 * 60 * 24))
        : 0;

      return res.json({
        success: true,
        data: {
          plan: professionalSub.plan,
          status: professionalSub.status,
          amount: professionalSub.amount,
          expiresAt: professionalSub.endDate,
          daysRemaining,
          isActive,
        },
      });
    }

    // ── Pet owner subscription (embedded on User) ────────────────────────────
    if (user.subscription) {
      const sub = user.subscription;
      const endDate = new Date(sub.endDate);
      const justExpired = sub.status === 'active' && now > endDate;

      if (justExpired) {
        await User.findByIdAndUpdate(userId, { 'subscription.status': 'expired' });
        sub.status = 'expired';
      }

      const isActive = sub.status === 'active' && !justExpired;
      const daysRemaining = isActive
        ? Math.ceil((endDate - now) / (1000 * 60 * 60 * 24))
        : 0;

      return res.json({
        success: true,
        data: {
          plan: sub.plan,
          status: sub.status,
          amount: sub.amount ?? PLAN_PRICING[sub.plan],
          expiresAt: sub.endDate,
          daysRemaining,
          isActive,
        },
      });
    }

    // No subscription at all
    return res.status(404).json({ success: false, message: 'No subscription found.', data: null });
  } catch (error) {
    logger.error('Get subscription error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to fetch subscription.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DELETE /api/subscriptions/cancel
 * Access retained until end of billing period.
 */
export const cancelSubscription = async (req, res) => {
  const userId = req.user._id || req.user.id;

  try {
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Professional
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

    // Pet owner
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
// VERIFY PAYMENT (manual redirect / polling fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/subscriptions/verify?reference=xxx
 */
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
// ADMIN — Stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/subscriptions/stats  (admin only)
 */
export const getSubscriptionStats = async (req, res) => {
  try {
    const now = new Date();

    const [
      professionalActive,
      professionalPending,
      professionalExpired,
      professionalCancelled,
      basicCount,
      professionalRevenueAgg,
      userActive,
      totalUsers,
    ] = await Promise.all([
      Subscription.countDocuments({ status: 'active', endDate: { $gte: now } }),
      Subscription.countDocuments({ status: 'pending' }),
      Subscription.countDocuments({ status: 'expired' }),
      Subscription.countDocuments({ status: 'cancelled' }),
      Subscription.countDocuments({ plan: 'basic', status: 'active', endDate: { $gte: now } }),
      Subscription.aggregate([
        { $match: { status: 'active', endDate: { $gte: now } } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      User.countDocuments({ 'subscription.status': 'active', 'subscription.plan': 'user_monthly' }),
      User.countDocuments({}),
    ]);

    const professionalRevenue = professionalRevenueAgg[0]?.total || 0;
    const userRevenue = userActive * PLAN_PRICING.user_monthly;
    const totalRevenue = professionalRevenue + userRevenue;

    return res.json({
      success: true,
      data: {
        professional: {
          active: professionalActive,
          pending: professionalPending,
          expired: professionalExpired,
          cancelled: professionalCancelled,
          byPlan: { basic: basicCount },
          monthlyRevenue: professionalRevenue,
        },
        users: {
          total: totalUsers,
          activeSubscribers: userActive,
          monthlyRevenue: userRevenue,
          conversionRate:
            totalUsers > 0
              ? ((userActive / totalUsers) * 100).toFixed(2) + '%'
              : '0%',
        },
        summary: {
          totalActiveSubscriptions: professionalActive + userActive,
          totalMonthlyRevenue: totalRevenue,
          currency: 'NGN',
        },
      },
    });
  } catch (error) {
    logger.error('Get stats error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch statistics.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function activateUserSubscription(userId, plan, reference) {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + 1);

  user.subscription = {
    plan,
    status: 'active',
    startDate,
    endDate,
    paymentReference: reference,
    amount: PLAN_PRICING[plan],
  };

  await user.save();
  logger.info('User subscription activated', { userId, plan });

  return { plan, status: 'active', expiresAt: endDate };
}

async function activateProfessionalSubscription(subscriptionId, reference) {
  const subscription = await Subscription.findById(subscriptionId);
  if (!subscription) throw new Error('Subscription not found');

  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + 1);

  subscription.status = 'active';
  subscription.paymentReference = reference;
  subscription.startDate = startDate;
  subscription.endDate = endDate;

  await subscription.save();
  logger.info('Professional subscription activated', { subscriptionId });

  return { plan: subscription.plan, status: 'active', expiresAt: endDate };
}