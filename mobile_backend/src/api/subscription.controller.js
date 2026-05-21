import Subscription from '../models/Subscription.js';
import Professional from '../models/Professional.js';
import Shop         from '../models/Shop.js';
import User         from '../models/User.js';
import axios        from 'axios';
import crypto       from 'crypto';
import logger       from '../lib/logger.js';
import mongoose     from 'mongoose';

const PAYSTACK_BASE   = process.env.PAYSTACK_BASE        || 'https://api.paystack.co';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY  || '';

const PLAN_PRICING = {
  user_monthly: 500,
  basic:        3000,
};

/**
 * Grace window must match the value in subscriptionMiddleware.js.
 * Pending subscriptions are treated as active for this many milliseconds
 * after paymentInitiatedAt, giving Paystack webhooks time to land.
 */
const PENDING_GRACE_MS = 30 * 60 * 1000; // 30 minutes

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if a pending subscription is still within the grace window.
 * Checks paymentInitiatedAt → createdAt → updatedAt in order.
 */
function isWithinPendingGrace(sub) {
  const anchor =
    sub.paymentInitiatedAt ||
    sub.createdAt          ||
    sub.updatedAt          ||
    null;

  if (!anchor) return false;
  return Date.now() - new Date(anchor).getTime() <= PENDING_GRACE_MS;
}

/**
 * Builds the grace window expiry date from a subscription document.
 * Returns null if no anchor timestamp is available.
 */
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

  // Idempotency — already activated by a previous webhook/verify call
  if (
    user.subscription?.paymentReference === reference &&
    user.subscription?.status === 'active'
  ) {
    logger.info('User subscription already active — skipping duplicate activation', {
      userId,
      reference,
    });
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
    status:              'active',
    startDate,
    endDate,
    paymentReference:    reference,
    paymentInitiatedAt:  user.subscription?.paymentInitiatedAt ?? startDate,
    amount:              PLAN_PRICING[plan],
  };

  await user.save();
  logger.info('User subscription activated', { userId, plan, reference });
  return { plan, status: 'active', expiresAt: endDate };
}

async function activateProfessionalSubscription(subscriptionId, reference) {
  const subscription = await Subscription.findById(subscriptionId);
  if (!subscription) throw new Error('Subscription not found');

  // Idempotency — already activated
  if (
    subscription.paymentReference === reference &&
    subscription.status === 'active'
  ) {
    logger.info('Professional subscription already active — skipping duplicate activation', {
      subscriptionId,
      reference,
    });
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
  return { plan: subscription.plan, status: 'active', expiresAt: endDate };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — Pricing
// ─────────────────────────────────────────────────────────────────────────────

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
// WEBHOOK
// ─────────────────────────────────────────────────────────────────────────────

export const handlePaystackWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) return res.status(400).send('Missing signature');

    const computed = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(req.body)
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

    res.status(200).send('OK');
  } catch (error) {
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

    if (!user.email) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Account email required to subscribe.' });
    }

    // Block if already active
    const sub = user.subscription;
    if (sub?.status === 'active' && new Date() < new Date(sub.endDate)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'You already have an active subscription.' });
    }

    // Block if pending and still within grace window — don't create a duplicate
    if (sub?.status === 'pending' && isWithinPendingGrace(sub)) {
      await session.abortTransaction();
      return res.status(400).json({
        success:    false,
        message:    'A payment is already being processed. Please wait for it to confirm.',
        data: {
          status:      'pending',
          graceEndsAt: graceEndsAt(sub),
        },
      });
    }

    const amount      = PLAN_PRICING[plan];
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

    // ── Set paymentInitiatedAt so the grace window has an anchor ─────────────
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

    // Block if already active
    const existing = await Subscription.findOne({
      user:    userId,
      status:  'active',
      endDate: { $gte: new Date() },
    }).session(session);

    if (existing) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'You already have an active subscription.' });
    }

    // Block if pending and still within grace window
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

    // Void all stale pending subs (outside grace window or no anchor)
    await Subscription.updateMany(
      { user: userId, status: 'pending' },
      { $set: { status: 'cancelled' } },
      { session },
    );

    const amount      = PLAN_PRICING[plan];
    const displayName = user.name || user.email.split('@')[0];
    const initiatedAt = new Date();

    // endDate is a placeholder — overwritten on activation
    const endDate = new Date(initiatedAt);
    endDate.setMonth(endDate.getMonth() + 1);

    // ── Set paymentInitiatedAt explicitly so the grace window has an anchor ──
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
// Role-aware: pet_owner reads User.subscription; all others read Subscription.
// Pending subs within the grace window are reported as active with grace info.
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

    // ── Professional path ──────────────────────────────────────────────────
    if (role !== 'pet_owner') {
      const professionalSub = await Subscription.findOne({ user: userId })
        .sort({ createdAt: -1 })
        .lean();

      if (!professionalSub) {
        return res.status(404).json({ success: false, message: 'No subscription found.', data: null });
      }

      // Pending within grace window → treat as active
      if (professionalSub.status === 'pending') {
        const inGrace    = isWithinPendingGrace(professionalSub);
        const graceExpiry = graceEndsAt(professionalSub);

        return res.json({
          success: true,
          data: {
            plan:         professionalSub.plan,
            status:       'pending',
            amount:       professionalSub.amount,
            expiresAt:    professionalSub.endDate,
            daysRemaining: 0,
            isActive:     inGrace,
            isPending:    true,
            graceEndsAt:  graceExpiry,
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
          plan:         professionalSub.plan,
          status:       professionalSub.status,
          amount:       professionalSub.amount,
          expiresAt:    professionalSub.endDate,
          daysRemaining,
          isActive,
          isPending:    false,
          graceEndsAt:  null,
        },
      });
    }

    // ── Pet owner path ─────────────────────────────────────────────────────
    if (!user.subscription) {
      return res.status(404).json({ success: false, message: 'No subscription found.', data: null });
    }

    const sub = user.subscription;

    // Pending within grace window
    if (sub.status === 'pending') {
      const inGrace     = isWithinPendingGrace(sub);
      const graceExpiry = graceEndsAt(sub);

      return res.json({
        success: true,
        data: {
          plan:         sub.plan,
          status:       'pending',
          amount:       sub.amount ?? PLAN_PRICING[sub.plan],
          expiresAt:    sub.endDate ?? null,
          daysRemaining: 0,
          isActive:     inGrace,
          isPending:    true,
          graceEndsAt:  graceExpiry,
          ...(inGrace && {
            notice: 'Your payment is being confirmed. You have full access while we wait.',
          }),
        },
      });
    }

    const endDate     = new Date(sub.endDate);
    const justExpired = sub.status === 'active' && now > endDate;

    if (justExpired) {
      await User.findByIdAndUpdate(userId, { 'subscription.status': 'expired' });
      sub.status = 'expired';
    }

    const isActive      = sub.status === 'active' && !justExpired;
    const daysRemaining = isActive
      ? Math.ceil((endDate - now) / (1000 * 60 * 60 * 24))
      : 0;

    return res.json({
      success: true,
      data: {
        plan:         sub.plan,
        status:       sub.status,
        amount:       sub.amount ?? PLAN_PRICING[sub.plan],
        expiresAt:    sub.endDate,
        daysRemaining,
        isActive,
        isPending:    false,
        graceEndsAt:  null,
      },
    });
  } catch (error) {
    logger.error('Get subscription error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to fetch subscription.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL PENDING
// Clears the stuck-pending loop when the user explicitly abandons payment.
// Refuses to cancel if a pending sub is still within the grace window —
// the webhook may still land. User must wait for grace to expire, or the
// webhook will activate it.
// ─────────────────────────────────────────────────────────────────────────────

export const cancelPendingSubscription = async (req, res) => {
  const userId = req.user._id || req.user.id;

  try {
    // ── Professional pending subs ──────────────────────────────────────────
    const pendingSubs = await Subscription.find({ user: userId, status: 'pending' }).lean();

    for (const s of pendingSubs) {
      if (isWithinPendingGrace(s)) {
        // Still within grace — don't cancel, webhook may be in-flight
        return res.status(400).json({
          success:    false,
          message:    'Your payment is still being confirmed. Please wait before cancelling.',
          data: {
            graceEndsAt: graceEndsAt(s),
          },
        });
      }
    }

    await Subscription.updateMany(
      { user: userId, status: 'pending' },
      { $set: { status: 'cancelled' } },
    );

    // ── Pet owner embedded sub ─────────────────────────────────────────────
    const user = await User.findById(userId);
    if (user?.subscription?.status === 'pending') {
      if (isWithinPendingGrace(user.subscription)) {
        return res.status(400).json({
          success:    false,
          message:    'Your payment is still being confirmed. Please wait before cancelling.',
          data: {
            graceEndsAt: graceEndsAt(user.subscription),
          },
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
// CANCEL (active subscription — soft cancel)
// Access retained until end of billing period.
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
// Idempotent: calling this twice with the same reference is safe.
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
          byPlan:         { basic: basicCount },
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