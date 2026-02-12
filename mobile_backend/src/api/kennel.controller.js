import User from '../models/User.js';
import Professional from '../models/Professional.js';
import cache from '../lib/cache.js';
import logger from '../lib/logger.js';

// ============================================================================
// KENNEL ONBOARDING
// POST /api/v1/kennels/onboard
// Body: { businessName, address, specialization, phone, email }
// ============================================================================
export const onboardKennel = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { businessName, address, specialization, phone, email } = req.body;

    if (!businessName?.trim()) {
      return res.status(400).json({ success: false, message: 'Kennel name is required' });
    }
    if (!address?.trim()) {
      return res.status(400).json({ success: false, message: 'Address is required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check for duplicate
    const existing = await Professional.findOne({ userId });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'You already have a professional profile. Use the update endpoint instead.',
      });
    }

    const kennel = await Professional.create({
      userId,
      role: 'kennel',
      name: user.name,
      businessName: businessName.trim(),
      address: address.trim(),
      specialization: specialization?.trim() || undefined,
      phone: phone?.trim() || user.phone || undefined,
      email: email?.trim() || user.email || undefined,
      // Kennels go live immediately — no VCN verification required
      isVerified: true,
      verifiedAt: new Date(),
    });

    // Tag user as kennel_owner
    user.role = 'kennel_owner';
    await user.save();

    logger.info('Kennel onboarded', { userId, kennelId: kennel._id, businessName: kennel.businessName });

    res.status(201).json({
      success: true,
      message: 'Kennel registered successfully. You are now live in the directory.',
      data: kennel,
    });
  } catch (error) {
    logger.error('Kennel onboard error', { error: error.message, stack: error.stack });
    res.status(500).json({ success: false, message: 'Failed to register kennel', error: error.message });
  }
};

// ============================================================================
// LIST ALL KENNELS
// GET /api/v1/kennels?limit=50&page=1&search=
// ============================================================================
export const listKennels = async (req, res) => {
  try {
    const { limit = 50, page = 1, search } = req.query;

    const query = { role: 'kennel', isVerified: true };

    if (search?.trim()) {
      const term = new RegExp(search.trim(), 'i');
      query.$or = [
        { businessName: term },
        { name: term },
        { address: term },
        { specialization: term },
      ];
    }

    const [kennels, total] = await Promise.all([
      Professional.find(query)
        .select('name businessName address specialization phone email distance isVerified createdAt')
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .skip((parseInt(page) - 1) * parseInt(limit))
        .lean(),
      Professional.countDocuments(query),
    ]);

    res.json({
      success: true,
      count: kennels.length,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      data: kennels,
    });
  } catch (error) {
    logger.error('List kennels error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch kennels', error: error.message });
  }
};

// ============================================================================
// NEARBY KENNELS (geospatial)
// GET /api/v1/kennels/nearby?lng=3.3792&lat=6.5244&distance=15&search=
// ============================================================================
export const getNearbyKennels = async (req, res) => {
  try {
    const { lng, lat, distance = 15, search } = req.query;

    if (!lng || !lat) {
      return res.status(400).json({ success: false, message: 'lng and lat are required' });
    }

    const maxDistanceMeters = parseFloat(distance) * 1000;

    const geoQuery = {
      role: 'kennel',
      isVerified: true,
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
          $maxDistance: maxDistanceMeters,
        },
      },
    };

    if (search?.trim()) {
      const term = new RegExp(search.trim(), 'i');
      geoQuery.$or = [
        { businessName: term },
        { name: term },
        { specialization: term },
      ];
    }

    const kennels = await Professional.find(geoQuery)
      .select('name businessName address specialization phone email location isVerified')
      .limit(50)
      .lean();

    // Attach distance in km
    const userPoint = [parseFloat(lng), parseFloat(lat)];
    const withDistance = kennels.map((k) => {
      let distKm = null;
      if (k.location?.coordinates) {
        const [kLng, kLat] = k.location.coordinates;
        const R = 6371;
        const dLat = ((kLat - userPoint[1]) * Math.PI) / 180;
        const dLng = ((kLng - userPoint[0]) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos((userPoint[1] * Math.PI) / 180) *
            Math.cos((kLat * Math.PI) / 180) *
            Math.sin(dLng / 2) ** 2;
        distKm = parseFloat((R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(2));
      }
      return { ...k, distance: distKm };
    });

    res.json({ success: true, count: withDistance.length, data: withDistance });
  } catch (error) {
    logger.error('Nearby kennels error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch nearby kennels', error: error.message });
  }
};

// ============================================================================
// GET SINGLE KENNEL
// GET /api/v1/kennels/:id
// ============================================================================
export const getKennel = async (req, res) => {
  try {
    const { id } = req.params;

    const cacheKey = `kennel:${id}`;
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const kennel = await Professional.findOne({ _id: id, role: 'kennel', isVerified: true })
      .select('-__v')
      .lean();

    if (!kennel) {
      return res.status(404).json({ success: false, message: 'Kennel not found' });
    }

    await cache.set(cacheKey, kennel, 300); // 5 min cache

    res.json({ success: true, data: kennel });
  } catch (error) {
    logger.error('Get kennel error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch kennel', error: error.message });
  }
};

// ============================================================================
// GET MY KENNEL PROFILE
// GET /api/v1/kennels/me
// ============================================================================
export const getMyKennelProfile = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const kennel = await Professional.findOne({ userId, role: 'kennel' })
      .select('-__v')
      .lean();

    if (!kennel) {
      return res.status(404).json({ success: false, message: 'No kennel profile found' });
    }

    res.json({ success: true, data: kennel });
  } catch (error) {
    logger.error('Get my kennel error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to fetch profile', error: error.message });
  }
};

// ============================================================================
// UPDATE KENNEL PROFILE
// PUT /api/v1/kennels/profile
// ============================================================================
export const updateKennel = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { businessName, address, specialization, phone, email } = req.body;

    const kennel = await Professional.findOneAndUpdate(
      { userId, role: 'kennel' },
      {
        $set: {
          ...(businessName?.trim() && { businessName: businessName.trim() }),
          ...(address?.trim() && { address: address.trim() }),
          ...(specialization !== undefined && { specialization: specialization.trim() }),
          ...(phone?.trim() && { phone: phone.trim() }),
          ...(email?.trim() && { email: email.trim() }),
        },
      },
      { new: true }
    );

    if (!kennel) {
      return res.status(404).json({ success: false, message: 'Kennel profile not found' });
    }

    await cache.del(`kennel:${kennel._id}`);

    logger.info('Kennel updated', { userId, kennelId: kennel._id });

    res.json({ success: true, message: 'Kennel profile updated.', data: kennel });
  } catch (error) {
    logger.error('Update kennel error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to update kennel', error: error.message });
  }
};

// ============================================================================
// DELETE KENNEL PROFILE
// DELETE /api/v1/kennels/profile
// ============================================================================
export const deleteKennel = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const kennel = await Professional.findOneAndDelete({ userId, role: 'kennel' });

    if (!kennel) {
      return res.status(404).json({ success: false, message: 'Kennel profile not found' });
    }

    // Revert user role
    await User.findByIdAndUpdate(userId, { role: 'user' });
    await cache.del(`kennel:${kennel._id}`);

    logger.info('Kennel deleted', { userId, kennelId: kennel._id });

    res.json({ success: true, message: 'Kennel profile deleted.' });
  } catch (error) {
    logger.error('Delete kennel error', { error: error.message });
    res.status(500).json({ success: false, message: 'Failed to delete kennel', error: error.message });
  }
};