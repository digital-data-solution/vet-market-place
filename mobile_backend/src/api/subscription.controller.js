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

// IMPROVED PRICING for Nigerian Market (2025)
// Based on: minimum wage ₦70,000/month, average tech user income ₦150-300k/month
const PLAN_PRICING = {
  // Pet Owner Plans (Consumer tier - 0.7-2% of minimum wage)
  user_monthly: 500,    // ₦500/month (~$0.50) - Very affordable entry point
  user_yearly: 5000,    // ₦5,000/year (~$5) - 16% discount, 2 months free
  
  // Professional Plans (Business tier - ROI focused)
  basic: 3000,          // ₦3,000/month (~$3) - Solo practitioners
  premium: 8000,        // ₦8,000/month (~$8) - Growing practices
  enterprise: 20000,    // ₦20,000/month (~$20) - Established businesses
};

// Feature limits per plan (for reference)
const PLAN_FEATURES = {
  user_monthly: {
    pets: 5,
    appointments: 10,
    vetAccess: true,
    petRecords: true,
    reminders: true
  },
  user_yearly: {
    pets: 10,
    appointments: 'unlimited',
    vetAccess: true,
    petRecords: true,
    reminders: true,
    prioritySupport: true
  },
  basic: {
    clients: 50,
    appointments: 100,
    analytics: 'basic',
    listing: true
  },
  premium: {
    clients: 200,
    appointments: 'unlimited',
    analytics: 'advanced',
    listing: 'featured',
    multiLocation: true
  },
  enterprise: {
    clients: 'unlimited',
    appointments: 'unlimited',
    analytics: 'advanced',
    listing: 'premium',
    multiLocation: true,
    apiAccess: true,
    whiteLabel: true
  }
};

/**
 * Create subscription for pet owners (stores in User model)
 */
export const createUserSubscription = async (req, res) => {
  const { plan } = req.body;
  const userId = req.user._id || req.user.id;

  if (!PAYSTACK_SECRET) {
    logger.error('Payment system not configured');
    return res.status(500).json({
      success: false,
      message: 'Payment system not configured. Please contact support.'
    });
  }

  // Validate plan
  if (!['user_monthly', 'user_yearly'].includes(plan)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid plan. Choose from: user_monthly or user_yearly.'
    });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findById(userId).session(session);
    
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'User not found.'
      });
    }

    // Verify user is a pet owner
    if (user.role !== 'pet_owner') {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: 'Only pet owners can subscribe to user plans. Please contact support for business plans.'
      });
    }

    // Validate email exists
    if (!user.email || !user.email.includes('@')) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Valid email required for subscription. Please update your profile.'
      });
    }

    // Check for existing active subscription
    if (user.subscription?.status === 'active' && 
        new Date() < new Date(user.subscription.endDate)) {
      await session.abortTransaction();
      
      return res.status(400).json({
        success: false,
        message: `You already have an active ${user.subscription.plan} subscription expiring on ${new Date(user.subscription.endDate).toLocaleDateString('en-NG')}.`,
        data: {
          currentPlan: user.subscription.plan,
          expiresAt: user.subscription.endDate
        }
      });
    }

    const amount = PLAN_PRICING[plan];

    // Initialize Paystack transaction
    const initializeBody = {
      email: user.email,
      amount: amount * 100, // Convert to kobo
      currency: 'NGN',
      metadata: {
        userId: userId.toString(),
        userName: user.name,
        plan,
        subscriptionType: 'user', // Important flag for webhook
        features: JSON.stringify(PLAN_FEATURES[plan])
      },
      callback_url: process.env.PAYSTACK_CALLBACK_URL || `${process.env.FRONTEND_URL}/subscription/verify`,
      channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer']
    };

    logger.info('Initializing user subscription payment', { userId, plan, amount });

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`, 
      initializeBody,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const { data } = initRes;
    
    if (!data || !data.status || !data.data) {
      await session.abortTransaction();
      logger.error('Paystack initialization failed', { userId, response: data });
      
      return res.status(500).json({
        success: false,
        message: 'Failed to initialize payment. Please try again later.'
      });
    }

    // Update user with pending subscription info
    user.subscription = {
      plan,
      status: 'pending',
      paymentReference: data.data.reference,
      amount
    };
    
    await user.save({ session });
    await session.commitTransaction();

    logger.info('User subscription pending', { 
      userId, 
      plan, 
      reference: data.data.reference 
    });

    res.status(201).json({
      success: true,
      message: 'Payment initialized successfully. Redirecting to payment page...',
      data: {
        authorization_url: data.data.authorization_url,
        access_code: data.data.access_code,
        reference: data.data.reference,
        amount,
        plan,
        features: PLAN_FEATURES[plan]
      }
    });

  } catch (error) {
    await session.abortTransaction();
    logger.error('Create user subscription error', { 
      error: error.message, 
      stack: error.stack,
      userId 
    });

    // Handle Paystack specific errors
    if (error.response?.data) {
      return res.status(error.response.status || 500).json({
        success: false,
        message: error.response.data.message || 'Payment initialization failed.',
        details: error.response.data
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create subscription. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    session.endSession();
  }
};

/**
 * Create subscription for professionals/shops (stores in Subscription model)
 */
export const createProfessionalSubscription = async (req, res) => {
  const { plan } = req.body;
  const userId = req.user._id || req.user.id;

  if (!PAYSTACK_SECRET) {
    logger.error('Payment system not configured');
    return res.status(500).json({
      success: false,
      message: 'Payment system not configured. Please contact support.'
    });
  }

  // Validate plan
  const allowedPlans = ['basic', 'premium', 'enterprise'];
  if (!allowedPlans.includes(plan)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid plan. Choose from: basic, premium, or enterprise.'
    });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findById(userId).session(session);
    
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'User not found.'
      });
    }

    // Validate email
    if (!user.email || !user.email.includes('@')) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Valid email required. Please update your profile.'
      });
    }

    // Verify user is a professional or shop owner
    const isProfessional = await Professional.findOne({ userId }).session(session);
    const isShop = await Shop.findOne({ owner: userId }).session(session);

    if (!isProfessional && !isShop) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: 'Professional or shop account required. Pet owners should use user plans.',
        redirectTo: '/subscription/user'
      });
    }

    // Check for existing active subscription
    const existingSubscription = await Subscription.findOne({
      user: userId,
      status: 'active',
      endDate: { $gte: new Date() }
    }).session(session);

    if (existingSubscription) {
      await session.abortTransaction();
      
      return res.status(400).json({
        success: false,
        message: `You already have an active ${existingSubscription.plan} subscription expiring on ${existingSubscription.endDate.toLocaleDateString('en-NG')}.`,
        data: {
          currentPlan: existingSubscription.plan,
          expiresAt: existingSubscription.endDate
        }
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

    await subscription.save({ session });

    logger.info('Professional subscription record created', { 
      userId, 
      plan, 
      subscriptionId: subscription._id 
    });

    // Initialize Paystack transaction
    const initializeBody = {
      email: user.email,
      amount: amount * 100, // Convert to kobo
      currency: 'NGN',
      metadata: {
        subscriptionId: subscription._id.toString(),
        userId: userId.toString(),
        userName: user.name,
        plan,
        subscriptionType: 'professional', // Important flag for webhook
        accountType: isProfessional ? 'professional' : 'shop',
        features: JSON.stringify(PLAN_FEATURES[plan])
      },
      callback_url: process.env.PAYSTACK_CALLBACK_URL || `${process.env.FRONTEND_URL}/subscription/verify`,
      channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer']
    };

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      initializeBody,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const { data } = initRes;
    
    if (!data || !data.status || !data.data) {
      await session.abortTransaction();
      logger.error('Paystack initialization failed', { userId, response: data });
      
      return res.status(500).json({
        success: false,
        message: 'Failed to initialize payment. Please try again later.'
      });
    }

    // Save payment reference
    subscription.paymentReference = data.data.reference;
    await subscription.save({ session });

    await session.commitTransaction();

    logger.info('Professional payment initialized', { 
      userId, 
      reference: data.data.reference,
      subscriptionId: subscription._id
    });

    res.status(201).json({
      success: true,
      message: 'Payment initialized successfully. Redirecting to payment page...',
      data: {
        authorization_url: data.data.authorization_url,
        access_code: data.data.access_code,
        reference: data.data.reference,
        subscription: {
          id: subscription._id,
          plan,
          amount,
          features: PLAN_FEATURES[plan]
        }
      }
    });

  } catch (error) {
    await session.abortTransaction();
    logger.error('Create professional subscription error', { 
      error: error.message, 
      stack: error.stack,
      userId 
    });

    // Handle Paystack specific errors
    if (error.response?.data) {
      return res.status(error.response.status || 500).json({
        success: false,
        message: error.response.data.message || 'Payment initialization failed.',
        details: error.response.data
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create subscription. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    session.endSession();
  }
};

/**
 * Get current subscription for any user type
 */
export const getUserSubscription = async (req, res) => {
  const userId = req.user._id || req.user.id;

  try {
    const user = await User.findById(userId).lean();
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.'
      });
    }

    // Check if pet owner (uses embedded subscription)
    if (user.role === 'pet_owner') {
      const subscription = user.subscription;
      
      if (!subscription) {
        return res.status(404).json({
          success: false,
          message: 'No subscription found.',
          data: null
        });
      }

      // Check if expired
      const now = new Date();
      const endDate = new Date(subscription.endDate);
      const isExpired = subscription.status === 'active' && now > endDate;

      // Auto-update if expired
      if (isExpired) {
        await User.findByIdAndUpdate(userId, {
          'subscription.status': 'expired'
        });
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
          startDate: subscription.startDate,
          expiresAt: subscription.endDate,
          daysRemaining,
          isActive: subscription.status === 'active' && !isExpired,
          features: PLAN_FEATURES[subscription.plan],
          accountType: 'user'
        }
      });
    }

    // For professionals/shops (uses Subscription model)
    const subscription = await Subscription.findOne({ user: userId })
      .sort({ createdAt: -1 })
      .lean();

    if (!subscription) {
      return res.status(404).json({
        success: false,
        message: 'No subscription found.',
        data: null
      });
    }

    // Check if expired
    const now = new Date();
    const endDate = new Date(subscription.endDate);
    const isExpired = subscription.status === 'active' && now > endDate;

    if (isExpired) {
      await Subscription.findByIdAndUpdate(subscription._id, { 
        status: 'expired' 
      });
      subscription.status = 'expired';
    }

    const daysRemaining = subscription.status === 'active'
      ? Math.ceil((endDate - now) / (1000 * 60 * 60 * 24))
      : 0;

    res.json({
      success: true,
      data: {
        plan: subscription.plan,
        status: subscription.status,
        amount: subscription.amount,
        startDate: subscription.startDate,
        expiresAt: subscription.endDate,
        daysRemaining,
        isActive: subscription.status === 'active' && !isExpired,
        features: PLAN_FEATURES[subscription.plan],
        accountType: 'professional'
      }
    });

  } catch (error) {
    logger.error('Get subscription error', { error: error.message, userId });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch subscription.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
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
      return res.status(404).json({
        success: false,
        message: 'User not found.'
      });
    }

    // Handle pet owner cancellation
    if (user.role === 'pet_owner') {
      if (!user.subscription || user.subscription.status !== 'active') {
        return res.status(404).json({
          success: false,
          message: 'No active subscription found.'
        });
      }

      user.subscription.status = 'cancelled';
      await user.save();

      logger.info('User subscription cancelled', { userId });

      return res.json({
        success: true,
        message: 'Subscription cancelled successfully. You will retain access until your current billing period ends.',
        data: {
          plan: user.subscription.plan,
          accessUntil: user.subscription.endDate
        }
      });
    }

    // Handle professional/shop cancellation
    const subscription = await Subscription.findOne({
      user: userId,
      status: 'active'
    });

    if (!subscription) {
      return res.status(404).json({
        success: false,
        message: 'No active subscription found.'
      });
    }

    subscription.status = 'cancelled';
    await subscription.save();

    logger.info('Professional subscription cancelled', { userId, subscriptionId: subscription._id });

    res.json({
      success: true,
      message: 'Subscription cancelled successfully. You will retain access until your current billing period ends.',
      data: {
        plan: subscription.plan,
        accessUntil: subscription.endDate
      }
    });

  } catch (error) {
    logger.error('Cancel subscription error', { error: error.message, userId });
    res.status(500).json({
      success: false,
      message: 'Failed to cancel subscription.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Verify payment (called after redirect from Paystack)
 */
export const verifyPayment = async (req, res) => {
  const { reference } = req.query;

  if (!reference) {
    return res.status(400).json({
      success: false,
      message: 'Payment reference is required.'
    });
  }

  try {
    // Verify transaction with Paystack
    const verifyRes = await axios.get(
      `${PAYSTACK_BASE}/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`
        }
      }
    );

    const { data } = verifyRes;

    if (!data || !data.status || !data.data) {
      logger.error('Payment verification failed', { reference });
      return res.status(400).json({
        success: false,
        message: 'Unable to verify payment. Please contact support.'
      });
    }

    const transaction = data.data;

    if (transaction.status !== 'success') {
      return res.status(400).json({
        success: false,
        message: `Payment ${transaction.status}. Please try again.`,
        data: { status: transaction.status }
      });
    }

    const metadata = transaction.metadata || {};
    const subscriptionType = metadata.subscriptionType;

    // Route to appropriate activation handler
    let result;
    if (subscriptionType === 'user') {
      result = await activateUserSubscription(metadata.userId, metadata.plan, reference);
    } else if (subscriptionType === 'professional') {
      result = await activateProfessionalSubscription(metadata.subscriptionId, reference);
    } else {
      throw new Error('Unknown subscription type');
    }

    res.json({
      success: true,
      message: 'Payment verified and subscription activated successfully!',
      data: result
    });

  } catch (error) {
    logger.error('Verify payment error', { error: error.message, reference });
    res.status(500).json({
      success: false,
      message: 'Failed to verify payment.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Paystack webhook handler - handles automatic payment notifications
 */
export const handlePaystackWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    
    if (!signature) {
      logger.error('Missing Paystack signature');
      return res.status(400).send('Missing signature');
    }

    const raw = req.body;

    // Verify signature
    const computed = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(raw)
      .digest('hex');

    if (signature !== computed) {
      logger.error('Invalid Paystack signature', { signature, computed });
      return res.status(400).send('Invalid signature');
    }

    const event = JSON.parse(raw.toString());

    logger.info('Webhook received', { event: event.event, reference: event.data?.reference });

    // Handle successful charge
    if (event.event === 'charge.success' && event.data?.status === 'success') {
      const metadata = event.data.metadata || {};
      const reference = event.data.reference;
      const subscriptionType = metadata.subscriptionType;

      logger.info('Processing successful charge', { reference, subscriptionType });

      // Route to appropriate handler
      if (subscriptionType === 'user') {
        await activateUserSubscription(metadata.userId, metadata.plan, reference);
      } else if (subscriptionType === 'professional') {
        await activateProfessionalSubscription(metadata.subscriptionId, reference);
      } else {
        logger.error('Unknown subscription type in webhook', { metadata });
      }

      logger.info('Subscription activated via webhook', { reference, subscriptionType });
    }

    res.status(200).send('OK');

  } catch (error) {
    logger.error('Webhook error', { error: error.message, stack: error.stack });
    res.status(500).send('Server error');
  }
};

/**
 * Helper: Activate user subscription
 */
async function activateUserSubscription(userId, plan, reference) {
  const user = await User.findById(userId);
  
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  const startDate = new Date();
  const endDate = new Date(startDate);

  // Set expiry based on plan
  if (plan === 'user_yearly') {
    endDate.setFullYear(endDate.getFullYear() + 1);
  } else {
    endDate.setMonth(endDate.getMonth() + 1);
  }

  user.subscription = {
    plan,
    status: 'active',
    startDate,
    endDate,
    paymentReference: reference,
    amount: PLAN_PRICING[plan]
  };

  await user.save();

  logger.info('User subscription activated', { 
    userId, 
    plan, 
    startDate, 
    endDate 
  });

  return {
    plan,
    status: 'active',
    startDate,
    expiresAt: endDate,
    features: PLAN_FEATURES[plan]
  };
}

/**
 * Helper: Activate professional subscription
 */
async function activateProfessionalSubscription(subscriptionId, reference) {
  const subscription = await Subscription.findById(subscriptionId);
  
  if (!subscription) {
    throw new Error(`Subscription not found: ${subscriptionId}`);
  }

  const startDate = new Date();
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + 1);

  subscription.status = 'active';
  subscription.paymentReference = reference;
  subscription.startDate = startDate;
  subscription.endDate = endDate;

  await subscription.save();

  logger.info('Professional subscription activated', { 
    subscriptionId, 
    plan: subscription.plan,
    startDate,
    endDate 
  });

  return {
    plan: subscription.plan,
    status: 'active',
    startDate,
    expiresAt: endDate,
    features: PLAN_FEATURES[subscription.plan]
  };
}

/**
 * Get subscription statistics (admin only)
 */
export const getSubscriptionStats = async (req, res) => {
  try {
    const [
      // Professional subscriptions
      professionalActive,
      professionalPending,
      professionalExpired,
      basicCount,
      premiumCount,
      enterpriseCount,
      professionalRevenue,
      // User subscriptions
      userActiveMonthly,
      userActiveYearly,
      totalUsers
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
      ]),
      User.countDocuments({ 'subscription.status': 'active', 'subscription.plan': 'user_monthly' }),
      User.countDocuments({ 'subscription.status': 'active', 'subscription.plan': 'user_yearly' }),
      User.countDocuments({ role: 'pet_owner' })
    ]);

    const userRevenue = (userActiveMonthly * PLAN_PRICING.user_monthly) + 
                        (userActiveYearly * PLAN_PRICING.user_yearly / 12); // Monthly equivalent

    const totalRevenue = (professionalRevenue[0]?.total || 0) + userRevenue;

    res.json({
      success: true,
      data: {
        professional: {
          active: professionalActive,
          pending: professionalPending,
          expired: professionalExpired,
          byPlan: {
            basic: basicCount,
            premium: premiumCount,
            enterprise: enterpriseCount
          },
          revenue: professionalRevenue[0]?.total || 0
        },
        users: {
          total: totalUsers,
          activeMonthly: userActiveMonthly,
          activeYearly: userActiveYearly,
          revenue: Math.round(userRevenue)
        },
        summary: {
          totalActive: professionalActive + userActiveMonthly + userActiveYearly,
          totalRevenue: Math.round(totalRevenue),
          currency: 'NGN',
          conversionRate: totalUsers > 0 
            ? ((userActiveMonthly + userActiveYearly) / totalUsers * 100).toFixed(2) + '%'
            : '0%'
        }
      }
    });

  } catch (error) {
    logger.error('Get stats error', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Get pricing information (public)
 */
export const getPricing = async (req, res) => {
  res.json({
    success: true,
    data: {
      userPlans: {
        monthly: {
          price: PLAN_PRICING.user_monthly,
          features: PLAN_FEATURES.user_monthly,
          savings: null
        },
        yearly: {
          price: PLAN_PRICING.user_yearly,
          monthlyEquivalent: Math.round(PLAN_PRICING.user_yearly / 12),
          features: PLAN_FEATURES.user_yearly,
          savings: '16% (2 months free)'
        }
      },
      professionalPlans: {
        basic: {
          price: PLAN_PRICING.basic,
          features: PLAN_FEATURES.basic
        },
        premium: {
          price: PLAN_PRICING.premium,
          features: PLAN_FEATURES.premium,
          popular: true
        },
        enterprise: {
          price: PLAN_PRICING.enterprise,
          features: PLAN_FEATURES.enterprise
        }
      },
      currency: 'NGN',
      note: 'All prices in Nigerian Naira. Monthly billing.'
    }
  });
};