import Shop from '../models/Shop.js';
import User from '../models/User.js';
import cache from '../lib/cache.js';

export const createShop = async (req, res) => {
  try {
    const { name, address, contact, services, location } = req.body;
    const owner = req.user._id;

    const shop = new Shop({ name, address, contact, services, owner });
    if (location && location.coordinates) shop.location = location;

    await shop.save();
    res.status(201).json({ message: 'Shop created', shop });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getNearbyShops = async (req, res) => {
  try {
    const { lng, lat, distance = 10 } = req.query;
    if (!lng || !lat) {
      return res.status(400).json({
        success: false,
        message: 'Coordinates are required for location-based search.'
      });
    }

    const radiusInMeters = distance * 1000;

    const cacheKey = `shops:near:${lng}:${lat}:${distance}`;
    const shops = await cache.cacheWrap(cacheKey, 30, async () => {
      return await Shop.find({
        location: {
          $near: {
            $geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
            $maxDistance: radiusInMeters
          }
        },
        isVerified: true  // Only return verified shops
      })
      .populate('owner', 'name email phone')  // Include owner contact info
      .limit(50)
      .select('name address contact services location isVerified createdAt')
      .sort({ createdAt: -1 })  // Show newest shops first
      .lean();
    });

    res.status(200).json({
      success: true,
      count: shops.length,
      data: shops,
      message: shops.length > 0 ? 'Nearby verified shops found' : 'No verified shops found in your area'
    });
  } catch (error) {
    console.error('Shop search error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to search for shops at this time. Please try again later.'
    });
  }
};

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
        { address: regex },
        { services: { $in: [regex] } },
        { contact: regex }
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
        .select('name address contact services location isVerified createdAt')
        .limit(parseInt(limit))
        .sort({ name: 1 }) // Alphabetical order
        .lean();
    });

    const searchType = q ? `matching "${q}"` : `within ${distance}km`;
    res.status(200).json({
      success: true,
      count: shops.length,
      data: shops,
      message: shops.length > 0
        ? `Found ${shops.length} verified shop(s) ${searchType}`
        : `No verified shops found ${searchType}`
    });
  } catch (error) {
    console.error('Shop search error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to perform shop search at this time. Please try again later.'
    });
  }
};

export const getShopById = async (req, res) => {
  try {
    const { id } = req.params;
    const shop = await Shop.findById(id)
      .populate('owner', 'name email phone')
      .select('name address contact services location isVerified createdAt');

    if (!shop) {
      return res.status(404).json({
        success: false,
        message: 'Shop not found'
      });
    }

    res.status(200).json({
      success: true,
      data: shop,
      message: 'Shop details retrieved successfully'
    });
  } catch (error) {
    console.error('Get shop by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to retrieve shop details at this time. Please try again later.'
    });
  }
};
