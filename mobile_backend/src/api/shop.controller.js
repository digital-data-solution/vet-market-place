import Shop from '../models/Shop.js';
import User from '../models/User.js';
import cache from '../lib/cache.js';
import logger from '../lib/logger.js';
import Subscription from '../models/Subscription.js';
import axios from 'axios';
import mongoose from 'mongoose';

function redactShop(shop) {
  const addr = typeof shop.address === 'string' ? shop.address : (shop.address?.full || '');
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  return {
    _id:         shop._id,
    name:        shop.name,
    ownerName:   shop.ownerName,
    description: shop.description,
    services:    shop.services,
    address:     parts.slice(-2).join(', '),
    rating:      shop.rating,
    reviewCount: shop.reviewCount,
    isVerified:  shop.isVerified,
    distance:    shop.distance,
  };
}

async function applyFreemiumGate(req, data) {
  if (req.subscription?.isActive === true) {
    return { data, isPreview: false, usedFreeSearch: false };
  }
  const userId = req.user._id || req.user.id;
  const user = await User.findById(userId).select('freeSearchUsed').lean();
  if (!user?.freeSearchUsed) {
    await User.findByIdAndUpdate(userId, { freeSearchUsed: true });
    return { data, isPreview: false, usedFreeSearch: true };
  }
  return { data: data.map(redactShop), isPreview: true, usedFreeSearch: false };
}

// Geocode address → GeoJSON Point. Results cached 30 days so same address
// only hits Nominatim once, avoiding rate-limit 429s.
const geocodeAddress = async (address) => {
  const key = `geocode:${address.trim().toLowerCase()}`;

  return cache.cacheWrap(key, 30 * 24 * 3600, async () => {
    try {
      const response = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: { q: address, format: 'json', limit: 1, countrycodes: 'ng' },
        headers: { 'User-Agent': 'XpressVet/1.0 (xpressvetmarketplace.com)' },
        timeout: 5000,
      });

      if (response.data && response.data.length > 0) {
        const { lat, lon } = response.data[0];
        return { type: 'Point', coordinates: [parseFloat(lon), parseFloat(lat)] };
      }

      return null;
    } catch (error) {
      console.error('Geocoding error:', error.message);
      return null;
    }
  });
};

// Create a new shop
export const createShop = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { name, ownerName, address, phone, email, description, services } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Shop name is required.'
      });
    }

    if (!address || !address.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Address is required.'
      });
    }

    // Check if user already has a shop
    const existing = await Shop.findOne({ owner: userId });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'You already have a shop registered. Please update it instead.'
      });
    }

    // Geocode the address
    const location = await geocodeAddress(address);
    if (!location) {
      console.warn(`Failed to geocode address: ${address}`);
      // Continue anyway - location is optional
    }

    // Create shop
    const shop = new Shop({
      owner: userId,
      name: name.trim(),
      ownerName: ownerName?.trim(),
      address: address.trim(),
      phone: phone?.trim(),
      email: email?.trim(),
      description: description?.trim(),
      services: services || [],
      location,
      isVerified: true,
    });

    await shop.save();

    // Promote user to shop_owner role
    await User.findByIdAndUpdate(userId, { $set: { role: 'shop_owner' } });

    res.status(201).json({
      success: true,
      message: 'Shop created successfully and is now live!',
      data: shop
    });
  } catch (error) {
    console.error('Create shop error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create shop. Please try again.',
      error: error.message
    });
  }
};

// Update shop
export const updateShop = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const updates = req.body;

    // Plan-based image limit
    if (updates.images) {
      const sub = await Subscription.findOne({ user: userId, status: 'active', endDate: { $gte: new Date() } });
      let maxImages = 1;
      if (sub?.plan === 'premium') maxImages = 5;
      if (sub?.plan === 'enterprise') maxImages = 1000;
      if (updates.images.length > maxImages) {
        return res.status(400).json({ success: false, message: `Your plan allows up to ${maxImages} profile photos.` });
      }
    }

    // Don't allow changing owner
    delete updates.owner;

    // If address is being updated, re-geocode
    if (updates.address) {
      const location = await geocodeAddress(updates.address);
      if (location) {
        updates.location = location;
      }
    }

    const shop = await Shop.findOneAndUpdate(
      { owner: userId },
      { $set: updates },
      { returnDocument: 'after', runValidators: true }
    );

    if (!shop) {
      return res.status(404).json({
        success: false,
        message: 'Shop not found. Please create one first.'
      });
    }

    // Clear cache
    await cache.del(`shop:${userId}`);

    res.json({
      success: true,
      message: 'Shop updated successfully',
      data: shop
    });
  } catch (error) {
    console.error('Update shop error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update shop. Please try again.',
      error: error.message
    });
  }
};

// Get current user's shop
export const getMyShop = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const cacheKey = `shop:${userId}`;
    const shop = await cache.cacheWrap(cacheKey, 300, async () => {
      return await Shop.findOne({ owner: userId })
        .populate('owner', 'name email phone')
        .lean();
    });

    if (!shop) {
      return res.status(404).json({
        success: false,
        message: 'Shop not found'
      });
    }

    res.json({
      success: true,
      data: shop
    });
  } catch (error) {
    console.error('Get shop error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch shop',
      error: error.message
    });
  }
};

// Get shop by ID (public)
// FIX: Added ObjectId validation to prevent CastError when non-ID strings hit this route
// (e.g. GET /api/v1/shops/my reaching here if route order is wrong)
export const getShopById = async (req, res) => {
  try {
    const { id } = req.params;

    // Guard: reject non-ObjectId values immediately
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid shop ID.'
      });
    }

    const shop = await Shop.findById(id)
      .populate('owner', 'name email phone supabaseId') // ← supabaseId added
      .select('-__v')
      .lean();

    if (!shop) {
      return res.status(404).json({
        success: false,
        message: 'Shop not found'
      });
    }

    // Freemium gate — applied per-request
    if (req.subscription?.isActive === true) {
      return res.json({ success: true, data: { ...shop, isPreview: false } });
    }

    const userId = req.user._id || req.user.id;
    const user = await User.findById(userId).select('freeSearchUsed').lean();
    if (!user?.freeSearchUsed) {
      await User.findByIdAndUpdate(userId, { freeSearchUsed: true });
      return res.json({ success: true, data: { ...shop, isPreview: false }, usedFreeSearch: true });
    }

    const addr = typeof shop.address === 'string' ? shop.address : (shop.address?.full || '');
    const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
    return res.json({
      success: true,
      data: {
        _id:         shop._id,
        name:        shop.name,
        ownerName:   shop.ownerName,
        description: shop.description,
        services:    shop.services,
        address:     parts.slice(-2).join(', '),
        rating:      shop.rating,
        reviewCount: shop.reviewCount,
        isVerified:  shop.isVerified,
        images:      shop.images,
        isPreview:   true,
      },
    });
  } catch (error) {
    console.error('Get shop by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to retrieve shop details at this time. Please try again later.'
    });
  }
};

// List all verified shops (with optional filtering)
export const listShops = async (req, res) => {
  try {
    const { limit = 50, page = 1 } = req.query;

    const filters = { isVerified: true };

    const cacheKey = `shops:list:${page}:${limit}`;
    const result = await cache.cacheWrap(cacheKey, 120, async () => {
      // Only show shops with active subscription
      const shopsWithSub = await Shop.aggregate([
        { $match: filters },
        {
          $lookup: {
            from: 'subscriptions',
            localField: 'owner',
            foreignField: 'user',
            as: 'subscriptions'
          }
        },
        {
          $addFields: {
            activeSubscription: {
              $filter: {
                input: '$subscriptions',
                as: 'sub',
                cond: {
                  $and: [
                    { $eq: ['$$sub.status', 'active'] },
                    { $gte: ['$$sub.endDate', new Date()] }
                  ]
                }
              }
            }
          }
        },
        { $match: { 'activeSubscription.0': { $exists: true } } },
        { $sort: { createdAt: -1 } },
        { $skip: (parseInt(page) - 1) * parseInt(limit) },
        { $limit: parseInt(limit) }
      ]);
      const total = await Shop.aggregate([
        { $match: filters },
        {
          $lookup: {
            from: 'subscriptions',
            localField: 'owner',
            foreignField: 'user',
            as: 'subscriptions'
          }
        },
        {
          $addFields: {
            activeSubscription: {
              $filter: {
                input: '$subscriptions',
                as: 'sub',
                cond: {
                  $and: [
                    { $eq: ['$$sub.status', 'active'] },
                    { $gte: ['$$sub.endDate', new Date()] }
                  ]
                }
              }
            }
          }
        },
        { $match: { 'activeSubscription.0': { $exists: true } } },
        { $count: 'count' }
      ]);
      return { shops: shopsWithSub, total: total[0]?.count || 0 };
    });

    const { data, isPreview, usedFreeSearch } = await applyFreemiumGate(req, result.shops);

    res.json({
      success: true,
      count: data.length,
      total: result.total,
      page: parseInt(page),
      totalPages: Math.ceil(result.total / parseInt(limit)),
      data,
      isPreview,
      ...(usedFreeSearch && { usedFreeSearch: true }),
    });
  } catch (error) {
    console.error('List shops error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch shops',
      error: error.message
    });
  }
};

// Search nearby shops (location-based)
export const getNearbyShops = async (req, res) => {
  try {
    const { lng, lat, distance = 10, search } = req.query;

    if (!lng || !lat) {
      return res.status(400).json({
        success: false,
        message: 'Coordinates (lng, lat) are required for location-based search.'
      });
    }

    const radiusInMeters = parseFloat(distance) * 1000;

    // Build query
    const query = {
      isVerified: true,
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [parseFloat(lng), parseFloat(lat)]
          },
          $maxDistance: radiusInMeters
        }
      }
    };

    // Text search
    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query.$or = [
        { name: regex },
        { ownerName: regex },
        { address: regex },
        { description: regex },
        { services: { $in: [regex] } }
      ];
    }

    const cacheKey = `shops:nearby:${lng}:${lat}:${distance}:${search || ''}`;
    const shops = await cache.cacheWrap(cacheKey, 60, async () => {
      return await Shop.find(query)
        .populate('owner', 'name phone email')
        .select('-__v')
        .limit(50)
        .lean();
    });

    // Calculate distances
    const shopsWithDistance = shops.map(shop => {
      if (shop.location && shop.location.coordinates) {
        const [shopLng, shopLat] = shop.location.coordinates;
        const distance = calculateDistance(
          parseFloat(lat),
          parseFloat(lng),
          shopLat,
          shopLng
        );
        return { ...shop, distance: parseFloat(distance.toFixed(2)) };
      }
      return shop;
    });

    res.json({
      success: true,
      count: shopsWithDistance.length,
      data: shopsWithDistance,
      message: shopsWithDistance.length > 0
        ? `Found ${shopsWithDistance.length} shop(s) nearby`
        : 'No shops found in this area'
    });
  } catch (error) {
    console.error('Nearby shops error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to search for nearby shops. Please try again.',
      error: error.message
    });
  }
};

// Search shops (text + optional location)
export const searchShops = async (req, res) => {
  try {
    const { q, lng, lat, distance = 25, limit = 20 } = req.query;

    if (!q && (!lng || !lat)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a search query or coordinates for location-based search.'
      });
    }

    let filters = { isVerified: true };

    // Text search
    if (q && q.trim().length >= 2) {
      const regex = new RegExp(q.trim(), 'i');
      filters.$or = [
        { name: regex },
        { ownerName: regex },
        { address: regex },
        { description: regex },
        { services: { $in: [regex] } }
      ];
    }

    // Geo-location search
    if (lng && lat) {
      const radiusInMeters = parseFloat(distance) * 1000;
      filters.location = {
        $near: {
          $geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
          $maxDistance: radiusInMeters
        }
      };
    }

    const cacheKey = `shops:search:${q || ''}:${lng || ''}:${lat || ''}:${distance}:${limit}`;
    const shops = await cache.cacheWrap(cacheKey, 60, async () => {
      return await Shop.find(filters)
        .populate('owner', 'name email phone')
        .select('-__v')
        .limit(parseInt(limit))
        .sort({ name: 1 })
        .lean();
    });

    const searchType = q ? `matching "${q}"` : `within ${distance}km`;
    res.status(200).json({
      success: true,
      count: shops.length,
      data: shops,
      message: shops.length > 0
        ? `Found ${shops.length} shop(s) ${searchType}`
        : `No shops found ${searchType}`
    });
  } catch (error) {
    console.error('Shop search error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to perform shop search at this time. Please try again later.'
    });
  }
};

// Delete shop (user can delete their own)
export const deleteShop = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const shop = await Shop.findOneAndDelete({ owner: userId });

    if (!shop) {
      return res.status(404).json({
        success: false,
        message: 'Shop not found'
      });
    }

    // Revert user to pet_owner when shop is deleted
    await User.findByIdAndUpdate(userId, { $set: { role: 'pet_owner' } });

    // Clear cache
    await cache.del(`shop:${userId}`);

    res.json({
      success: true,
      message: 'Shop deleted successfully'
    });
  } catch (error) {
    console.error('Delete shop error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete shop',
      error: error.message
    });
  }
};

// Helper function: Calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(degrees) {
  return degrees * (Math.PI / 180);
}