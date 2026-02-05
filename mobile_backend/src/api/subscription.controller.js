import Subscription from '../models/Subscription.js';
import User from '../models/User.js';

export const createSubscription = async (req, res) => {
  const { plan } = req.body;
  const userId = req.user.id;

  try {
    // Check if user already has active subscription
    const existing = await Subscription.findOne({ user: userId, status: 'active' });
    if (existing) return res.status(400).json({ message: 'Active subscription exists' });

    const amount = plan === 'premium' ? 10000 : 5000;
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    const subscription = new Subscription({ user: userId, plan, amount, endDate });
    await subscription.save();

    res.status(201).json({ message: 'Subscription created. Proceed to payment.', subscription });
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

// Placeholder for Paystack webhook to activate subscription
export const activateSubscription = async (req, res) => {
  const { userId, reference } = req.body;

  try {
    const subscription = await Subscription.findOneAndUpdate(
      { user: userId, status: 'active' },
      { status: 'active', paymentReference: reference }
    );
    res.json({ message: 'Subscription activated' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};