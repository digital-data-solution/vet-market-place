import Subscription from '../models/Subscription.js';
import User from '../models/User.js';
import axios from 'axios';
import crypto from 'crypto';

const PAYSTACK_BASE = process.env.PAYSTACK_BASE || 'https://api.paystack.co';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET || '';

export const createSubscription = async (req, res) => {
  const { plan } = req.body;
  const userId = req.user.id;

  if (!PAYSTACK_SECRET) return res.status(500).json({ message: 'PAYSTACK_SECRET not configured' });

  try {
    // Check if user already has active subscription
    const existing = await Subscription.findOne({ user: userId, status: 'active' });
    if (existing) return res.status(400).json({ message: 'Active subscription exists' });

    const amount = plan === 'premium' ? 10000 : 5000;
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    const subscription = new Subscription({ user: userId, plan, amount, endDate, status: 'inactive' });
    await subscription.save();

    // Initialize Paystack transaction
    const user = await User.findById(userId);
    const initializeBody = {
      email: user.email,
      amount: amount * 100, // amount in kobo
      metadata: { subscriptionId: subscription._id.toString(), userId },
      callback_url: process.env.PAYSTACK_CALLBACK_URL || ''
    };

    const initRes = await axios.post(`${PAYSTACK_BASE}/transaction/initialize`, initializeBody, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json'
      }
    });

    const { data } = initRes;
    if (!data || !data.status) {
      return res.status(500).json({ message: 'Failed to initialize payment' });
    }

    // Save reference
    subscription.paymentReference = data.data.reference;
    await subscription.save();

    res.status(201).json({ message: 'Payment initialized', authorization_url: data.data.authorization_url, reference: data.data.reference, subscription });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getUserSubscription = async (req, res) => {
  const userId = req.user.id;

  try {
    const subscription = await Subscription.findOne({ user: userId }).sort({ createdAt: -1 });
    res.json({ subscription });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Paystack webhook handler: expects raw body and X-Paystack-Signature header
export const activateSubscription = async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const raw = req.body; // express.raw provides a Buffer
    const computed = crypto.createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex');

    if (signature !== computed) {
      return res.status(400).send('Invalid signature');
    }

    const event = JSON.parse(raw.toString());
    // Handle charge success
    if (event.event === 'charge.success' && event.data && event.data.status === 'success') {
      const reference = event.data.reference;
      const metadata = event.data.metadata || {};
      const subscriptionId = metadata.subscriptionId || null;
      const userId = metadata.userId || null;

      if (subscriptionId) {
        const subscription = await Subscription.findById(subscriptionId);
        if (subscription) {
          subscription.status = 'active';
          subscription.paymentReference = reference;
          subscription.startDate = new Date();
          const end = new Date();
          end.setMonth(end.getMonth() + 1);
          subscription.endDate = end;
          await subscription.save();
        }
      }

      // Optionally update user role/flags
      if (userId) {
        await User.findByIdAndUpdate(userId, { });
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error', error);
    res.status(500).send('Server error');
  }
};