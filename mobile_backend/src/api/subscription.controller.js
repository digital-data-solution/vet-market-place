/**
 * Get subscription statistics (admin only)
 */
export const getSubscriptionStats = async (req, res) => {
  try {
    const [
      professionalActive,
      professionalPending,
      professionalExpired,
      basicCount,
      professionalRevenue,
      userActive,
      totalUsers
    ] = await Promise.all([
      Subscription.countDocuments({ status: 'active', endDate: { $gte: new Date() } }),
      Subscription.countDocuments({ status: 'pending' }),
      Subscription.countDocuments({ status: 'expired' }),
      Subscription.countDocuments({ plan: 'basic', status: 'active' }),
      Subscription.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      User.countDocuments({ 'subscription.status': 'active', 'subscription.plan': 'user_monthly' }),
      User.countDocuments({})
    ]);

    const userRevenue = userActive * (PLAN_PRICING.user_monthly || 0);
    const totalRevenue = (professionalRevenue[0]?.total || 0) + userRevenue;

    res.json({
      success: true,
      data: {
        professional: {
          active: professionalActive,
          pending: professionalPending,
          expired: professionalExpired,
          byPlan: {
            basic: basicCount
          },
          revenue: professionalRevenue[0]?.total || 0
        },
        users: {
          total: totalUsers,
          active: userActive,
          revenue: Math.round(userRevenue)
        },
        summary: {
          totalActive: professionalActive + userActive,
          totalRevenue: Math.round(totalRevenue),
          currency: 'NGN',
          conversionRate: totalUsers > 0 
            ? ((userActive) / totalUsers * 100).toFixed(2) + '%'
            : '0%'
        }
      }
    });
  } catch (error) {
    logger.error('Get stats error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch statistics.' });
  }
};
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

// SIMPLE TWO-TIER PRICING
const PLAN_PRICING = {
  user_monthly: 500,    // Pet owners pay ₦500/month to search & chat
  basic: 3000,          // Professionals pay ₦3,000/month to get listed
};

const PLAN_FEATURES = {
  user_monthly: {
    searchVets: true,
    searchKennels: true,
    searchShops: true,
    unlimitedChat: true,
    viewProfiles: true,
  },
  basic: {
    getListed: true,
    businessProfile: true,
    receiveMessages: true,
    contactVisible: true,
  }
};

/**
 * Create subscription for pet owners - ₦500/month
 */
export const createUserSubscription = async (req, res) => {
  const { plan } = req.body;
  const userId = req.user._id || req.user.id;

  if (!PAYSTACK_SECRET) {
    return res.status(500).json({
      success: false,
      message: 'Payment system not configured.'
    });
  }

  if (plan !== 'user_monthly') {
    return res.status(400).json({
      success: false,
      message: 'Invalid plan.'
    });
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
      return res.status(400).json({
        success: false,
        message: 'Valid email required.'
      });
    }

    // Check existing subscription
    if (user.subscription?.status === 'active' && new Date() < new Date(user.subscription.endDate)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `You already have an active subscription.`,
      });
    }

    const amount = PLAN_PRICING[plan];

    const initializeBody = {
      email: user.email,
      amount: amount * 100,
      currency: 'NGN',
      metadata: {
        userId: userId.toString(),
        userName: user.name || user.email.split('@')[0],
        plan,
        subscriptionType: 'user',
      },
      callback_url: process.env.PAYSTACK_CALLBACK_URL,
      channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer']
    };

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`, 
      initializeBody,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' }}
    );

    const { data } = initRes;
    
    if (!data?.status || !data?.data) {
      await session.abortTransaction();
      return res.status(500).json({ success: false, message: 'Payment initialization failed.' });
    }

    user.subscription = {
      plan,
      status: 'pending',
      paymentReference: data.data.reference,
      amount
    };
    
    await user.save({ session });
    await session.commitTransaction();

    res.status(201).json({
      success: true,
      message: 'Payment initialized.',
      data: {
        authorization_url: data.data.authorization_url,
        reference: data.data.reference,
        amount,
      }
    });

  } catch (error) {
    await session.abortTransaction();
    logger.error('Create user subscription error', { error: error.message, userId });
    res.status(500).json({ success: false, message: 'Failed to create subscription.' });
  } finally {
    session.endSession();
  }
};

/**
 * Create subscription for professionals - ₦3,000/month
 */
export const createProfessionalSubscription = async (req, res) => {
  const { plan } = req.body;
  const userId = req.user._id || req.user.id;

  if (!PAYSTACK_SECRET) {
    return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  }

  if (plan !== 'basic') {
    return res.status(400).json({ success: false, message: 'Invalid plan.' });
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

    // Verify is professional
    const isProfessional = await Professional.findOne({ userId }).session(session);
    const isShop = await Shop.findOne({ owner: userId }).session(session);

    if (!isProfessional && !isShop) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: 'Professional account required. Please register your business first.'
      });
    }

    // Check existing subscription
    const existingSubscription = await Subscription.findOne({
      user: userId,
      status: 'active',
      endDate: { $gte: new Date() }
    }).session(session);

    if (existingSubscription) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'You already have an active subscription.' });
    }

    const amount = PLAN_PRICING[plan];
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    const subscription = new Subscription({
      user: userId,
      plan,
      amount,
      endDate,
      status: 'pending'
    });

    await subscription.save({ session });

    const initializeBody = {
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
      channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer']
    };

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      initializeBody,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' }}
    );

    const { data } = initRes;
    
    if (!data?.status || !data?.data) {
      await session.abortTransaction();
      return res.status(500).json({ success: false, message: 'Payment initialization failed.' });
    }

    subscription.paymentReference = data.data.reference;
    await subscription.save({ session });
    await session.commitTransaction();

    res.status(201).json({
      success: true,
      message: 'Payment initialized.',
      data: {
        authorization_url: data.data.authorization_url,
        reference: data.data.reference,
        subscription: { id: subscription._id, plan, amount }
      }
    });

  } catch (error) {
    await session.abortTransaction();
    logger.error('Create professional subscription error', { error: error.message, userId });
    res.status(500).json({ success: false, message: 'Failed to create subscription.' });
  } finally {
    session.endSession();
  }
};

/**
 * Get current subscription
 */
export const getUserSubscription = async (req, res) => {
  const userId = req.user._id || req.user.id;

  try {
    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Check professional subscription
    const professionalSub = await Subscription.findOne({ user: userId }).sort({ createdAt: -1 }).lean();

    if (professionalSub) {
      const now = new Date();
      const endDate = new Date(professionalSub.endDate);
      const isExpired = professionalSub.status === 'active' && now > endDate;

      if (isExpired) {
        await Subscription.findByIdAndUpdate(professionalSub._id, { status: 'expired' });
        professionalSub.status = 'expired';
      }

      const daysRemaining = professionalSub.status === 'active'
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
          isActive: professionalSub.status === 'active' && !isExpired,
        }
      });
    }

    // Check pet owner subscription
    if (user.subscription) {
      const subscription = user.subscription;
      const now = new Date();
      const endDate = new Date(subscription.endDate);
      const isExpired = subscription.status === 'active' && now > endDate;

      if (isExpired) {
        await User.findByIdAndUpdate(userId, { 'subscription.status': 'expired' });
        subscription.status = 'expired';
      }

      const daysRemaining = subscription.status === 'active' 
        ? Math.ceil((endDate - now) / (1000 * 60 * 60 * 24))
        : 0;

      return res.json({
        success: true,
        data: {
          plan: subscription.plan,
          status: subscription.status,
          amount: subscription.amount || PLAN_PRICING[subscription.plan],
          expiresAt: subscription.endDate,
          daysRemaining,
          isActive: subscription.status === 'active' && !isExpired,
        }
      });
    }

    return res.status(404).json({ success: false, message: 'No subscription found.', data: null });

  } catch (error) {
    logger.error('Get subscription error', { error: error.message, userId });
    res.status(500).json({ success: false, message: 'Failed to fetch subscription.' });
  }
};

/**
 * Cancel subscription
 */
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
        data: { accessUntil: professionalSub.endDate }
      });
    }

    if (user.subscription?.status === 'active') {
      user.subscription.status = 'cancelled';
      await user.save();
      return res.json({
        success: true,
        message: 'Subscription cancelled. You will retain access until your billing period ends.',
        data: { accessUntil: user.subscription.endDate }
      });
    }

    return res.status(404).json({ success: false, message: 'No active subscription found.' });

  } catch (error) {
    logger.error('Cancel subscription error', { error: error.message, userId });
    res.status(500).json({ success: false, message: 'Failed to cancel subscription.' });
  }
};

/**
 * Verify payment
 */
export const verifyPayment = async (req, res) => {
  const { reference } = req.query;

  if (!reference) {
    return res.status(400).json({ success: false, message: 'Payment reference required.' });
  }

  try {
    const verifyRes = await axios.get(
      `${PAYSTACK_BASE}/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }}
    );

    const { data } = verifyRes;

    if (!data?.status || !data?.data || data.data.status !== 'success') {
      return res.status(400).json({ success: false, message: 'Payment verification failed.' });
    }

    const metadata = data.data.metadata || {};
    
    let result;
    if (metadata.subscriptionType === 'user') {
      result = await activateUserSubscription(metadata.userId, metadata.plan, reference);
    } else if (metadata.subscriptionType === 'professional') {
      result = await activateProfessionalSubscription(metadata.subscriptionId, reference);
    }

    res.json({ success: true, message: 'Payment verified and subscription activated!', data: result });

  } catch (error) {
    logger.error('Verify payment error', { error: error.message, reference });
    res.status(500).json({ success: false, message: 'Failed to verify payment.' });
  }
};

/**
 * Webhook handler
 */
export const handlePaystackWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) return res.status(400).send('Missing signature');

    const computed = crypto.createHmac('sha512', PAYSTACK_SECRET).update(req.body).digest('hex');
    if (signature !== computed) return res.status(400).send('Invalid signature');

    const event = JSON.parse(req.body.toString());

    if (event.event === 'charge.success' && event.data?.status === 'success') {
      const metadata = event.data.metadata || {};
      
      if (metadata.subscriptionType === 'user') {
        await activateUserSubscription(metadata.userId, metadata.plan, event.data.reference);
      } else if (metadata.subscriptionType === 'professional') {
        await activateProfessionalSubscription(metadata.subscriptionId, event.data.reference);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error('Webhook error', { error: error.message });
    res.status(500).send('Error');
  }
};

/**
 * Activate user subscription
 */
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
    amount: PLAN_PRICING[plan]
  };

  await user.save();
  logger.info('User subscription activated', { userId, plan });

  return { plan, status: 'active', expiresAt: endDate };
}

/**
 * Activate professional subscription
 */
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

/**
 * Get pricing
 */
export const getPricing = async (req, res) => {
  res.json({
    success: true,
    data: {
      petOwners: { price: PLAN_PRICING.user_monthly, plan: 'user_monthly' },
      professionals: { price: PLAN_PRICING.basic, plan: 'basic' },
      currency: 'NGN'
    }
  });
};