import Subscription from '../models/Subscription.js';
import Professional from '../models/Professional.js';
import Shop from '../models/Shop.js';
import User from '../models/User.js';
import axios from 'axios';
import crypto from 'crypto';
import logger from '../lib/logger.js';

const PAYSTACK_BASE = process.env.PAYSTACK_BASE || 'https://api.paystack.co';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET || '';

// Plan pricing in Naira
const PLAN_PRICING = {
  basic: 2500,
  premium: 7500,
  enterprise: 15000,
};

// Create a new subscription
export const createSubscription = async (req, res) => {
  const { plan } = req.body;
  const userId = req.user._id || req.user.id;

  if (!PAYSTACK_SECRET) {
    logger.error('Payment system not configured');
    return res.status(500).json({
      success: false,
      message: 'Payment system not configured. Please contact support.'
    });
  }

  if (!['basic', 'premium', 'enterprise'].includes(plan)) {
    logger.warn('Invalid subscription plan', { plan });
    return res.status(400).json({
      success: false,
      message: 'Invalid plan. Choose from: basic, premium, or enterprise.'
    });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found for subscription', { userId });
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if user is a professional or shop owner
    const [professional, shop] = await Promise.all([
      Professional.findOne({ userId }),
      Shop.findOne({ owner: userId })
    ]);

    if (!professional && !shop) {
      logger.warn('Subscription attempted by non-professional/shop', { userId });
      return res.status(403).json({
        success: false,
        message: 'Subscriptions are only available for verified professionals and shop owners. Please register as a professional or shop owner first.'
      });
    }

    // Check if user already has an active subscription
    const existing = await Subscription.findOne({
      user: userId,
      status: 'active',
      endDate: { $gte: new Date() }
    });

    if (existing) {
      logger.info('User already has active subscription', { userId, plan: existing.plan });
      return res.status(400).json({
        success: false,
        message: `You already have an active ${existing.plan} subscription. It expires on ${existing.endDate.toLocaleDateString()}.`
      });
    }

    const amount = PLAN_PRICING[plan];
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    // Create subscription record
    const subscription = new Subscription({
      user: userId,
      plan,
      amount,
      endDate,
      status: 'pending'
    });

    await subscription.save();
    logger.info('Subscription record created', { userId, plan, subscriptionId: subscription._id });

    // Initialize Paystack transaction
    const initializeBody = {
      email: user.email || `user_${userId}@example.com`,
      amount: amount * 100, // Convert to kobo
      metadata: {
        subscriptionId: subscription._id.toString(),
        userId: userId.toString(),
        plan
      },
      callback_url: process.env.PAYSTACK_CALLBACK_URL || ''
    };

    const initRes = await axios.post(`${PAYSTACK_BASE}/transaction/initialize`, initializeBody, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json'
      }
    });

    const { data } = initRes;
    if (!data || !data.status || !data.data) {
      logger.error('Failed to initialize payment with Paystack', { userId });
      return res.status(500).json({
        success: false,
        message: 'Failed to initialize payment. Please try again later.'
      });
    }

    // Save payment reference
    subscription.paymentReference = data.data.reference;
    await subscription.save();
    logger.info('Payment initialized with Paystack', { userId, reference: data.data.reference });

    res.status(201).json({
      success: true,
      message: 'Payment initialized successfully',
      data: {
        authorization_url: data.data.authorization_url,
        reference: data.data.reference,
        subscription
      }
    });
  } catch (error) {
    logger.error('Create subscription error', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      message: 'Failed to create subscription. Please try again.',
      error: error.message
    });
  }
};

// Get user's current subscription
export const getUserSubscription = async (req, res) => {
  const userId = req.user._id || req.user.id;

  try {
    const subscription = await Subscription.findOne({ user: userId })
      .sort({ createdAt: -1 })
      .lean();

    if (!subscription) {
      return res.status(404).json({
        success: false,
        message: 'No subscription found',
        data: null
      });
    }

    // Check if subscription is expired
    const isExpired = subscription.status === 'active' && new Date() > new Date(subscription.endDate);
    if (isExpired) {
      // Update status to expired
      await Subscription.findByIdAndUpdate(subscription._id, { status: 'expired' });
      subscription.status = 'expired';
    }

    res.json({
      success: true,
      data: {
        plan: subscription.plan,
        status: subscription.status,
        expiresAt: subscription.endDate,
        startDate: subscription.startDate,
        amount: subscription.amount,
        isActive: subscription.status === 'active' && !isExpired
      }
    });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch subscription',
      error: error.message
    });
  }
};

// Cancel subscription
export const cancelSubscription = async (req, res) => {
  const userId = req.user._id || req.user.id;

  try {
    const subscription = await Subscription.findOne({
      user: userId,
      status: 'active'
    });

    if (!subscription) {
      return res.status(404).json({
        success: false,
        message: 'No active subscription found'
      });
    }

    subscription.status = 'cancelled';
    await subscription.save();

    res.json({
      success: true,
      message: 'Subscription cancelled successfully. You will retain access until the end of your billing period.',
      data: subscription
    });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel subscription',
      error: error.message
    });
  }
};

// Paystack webhook handler
export const handlePaystackWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const raw = req.body; // express.raw provides a Buffer

    const computed = crypto.createHmac('sha512', PAYSTACK_SECRET)
      .update(raw)
      .digest('hex');

    if (signature !== computed) {
      console.error('Invalid Paystack signature');
      return res.status(400).send('Invalid signature');
    }

    const event = JSON.parse(raw.toString());

    // Handle successful charge
    if (event.event === 'charge.success' && event.data && event.data.status === 'success') {
      const reference = event.data.reference;
      const metadata = event.data.metadata || {};
      const subscriptionId = metadata.subscriptionId;

      if (!subscriptionId) {
        console.error('No subscription ID in webhook metadata');
        return res.status(400).send('No subscription ID');
      }

      const subscription = await Subscription.findById(subscriptionId);
      if (!subscription) {
        console.error(`Subscription not found: ${subscriptionId}`);
        return res.status(404).send('Subscription not found');
      }

      // Activate subscription
      subscription.status = 'active';
      subscription.paymentReference = reference;
      subscription.startDate = new Date();
      
      const endDate = new Date();
      endDate.setMonth(endDate.getMonth() + 1);
      subscription.endDate = endDate;

      await subscription.save();

      console.log(`Subscription activated: ${subscriptionId}`);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Server error');
  }
};

// Get subscription statistics (admin only)
export const getSubscriptionStats = async (req, res) => {
  try {
    const [
      totalActive,
      totalPending,
      totalExpired,
      basicCount,
      premiumCount,
      enterpriseCount,
      totalRevenue
    ] = await Promise.all([
      Subscription.countDocuments({ status: 'active', endDate: { $gte: new Date() } }),
      Subscription.countDocuments({ status: 'pending' }),
      Subscription.countDocuments({ status: 'expired' }),
      Subscription.countDocuments({ plan: 'basic', status: 'active' }),
      Subscription.countDocuments({ plan: 'premium', status: 'active' }),
      Subscription.countDocuments({ plan: 'enterprise', status: 'active' }),
      Subscription.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ])
    ]);

    res.json({
      success: true,
      data: {
        total: {
          active: totalActive,
          pending: totalPending,
          expired: totalExpired
        },
        byPlan: {
          basic: basicCount,
          premium: premiumCount,
          enterprise: enterpriseCount
        },
        revenue: {
          monthly: totalRevenue[0]?.total || 0,
          currency: 'NGN'
        }
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: error.message
    });
  }
};