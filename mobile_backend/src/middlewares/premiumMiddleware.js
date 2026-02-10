import Subscription from '../models/Subscription.js';
import Professional from '../models/Professional.js';
import Shop from '../models/Shop.js';
import User from '../models/User.js';

// Middleware to protect premium features
export const premiumOnly = async (req, res, next) => {
  try {
    // Only allow professionals, kennels, and shops
    const user = req.user;
    let allowed = false;
    let ownerId = user._id || user.id;

    // Check if user is a professional (vet or kennel)
    const professional = await Professional.findOne({ _id: ownerId });
    if (professional && ['vet', 'kennel'].includes(professional.role)) {
      allowed = true;
    }

    // Check if user is a shop owner
    const shop = await Shop.findOne({ owner: ownerId });
    if (shop) {
      allowed = true;
    }

    if (!allowed) {
      return res.status(403).json({ message: 'Only professionals, kennels, or shops can access premium features.' });
    }

    // Check for active premium subscription
    const subscription = await Subscription.findOne({ user: ownerId, plan: 'premium', status: 'active', endDate: { $gte: new Date() } });
    if (!subscription) {
      return res.status(402).json({ message: 'Premium subscription required.' });
    }

    next();
  } catch (error) {
    console.error('Premium middleware error:', error);
    res.status(500).json({ message: 'Server error in premium middleware.' });
  }
};
