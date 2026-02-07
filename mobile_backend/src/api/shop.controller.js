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
    if (!lng || !lat) return res.status(400).json({ message: 'Coordinates required' });

    const radiusInMeters = distance * 1000;

    const cacheKey = `shops:near:${lng}:${lat}:${distance}`;
    const shops = await cache.cacheWrap(cacheKey, 30, async () => {
      return await Shop.find({
        location: {
          $near: {
            $geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
            $maxDistance: radiusInMeters
          }
        }
      }).limit(50).select('name address contact services location isVerified').lean();
    });

    res.json({ count: shops.length, data: shops });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getShopById = async (req, res) => {
  try {
    const { id } = req.params;
    const shop = await Shop.findById(id).populate('owner', 'name email');
    if (!shop) return res.status(404).json({ message: 'Shop not found' });
    res.json({ shop });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
