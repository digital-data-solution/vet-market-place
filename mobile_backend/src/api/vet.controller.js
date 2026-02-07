import User from '../models/User.js';
import cache from '../lib/cache.js';

export const getNearbyProfessionals = async (req, res) => {
  try {
    const { lng, lat, distance = 10, type = 'all' } = req.query; // type: 'vet', 'kennel', 'all'

    if (!lng || !lat) {
      return res.status(400).json({ message: "Coordinates are required." });
    }

    const radiusInMeters = distance * 1000;

    // Base geo query
    let query = {
      location: {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [parseFloat(lng), parseFloat(lat)],
          },
          $maxDistance: radiusInMeters,
        },
      },
    };

    if (type === 'vet') {
      // For vets require both phone/otp verification and VCN approval
      query.role = 'vet';
      query.isVerified = true;
      query['vetVerification.status'] = 'approved';
    } else if (type === 'kennel') {
      query.role = 'kennel_owner';
      query.isVerified = true;
    } else {
      query.role = { $in: ['vet', 'kennel_owner'] };
      query.isVerified = true;
    }

    const cacheKey = `professionals:near:${lng}:${lat}:${distance}:${type}`;
    const professionals = await cache.cacheWrap(cacheKey, 30, async () => {
      return await User.find(query)
        .select('name email role location vetDetails kennelDetails')
        .limit(20)
        .lean();
    });

    res.status(200).json({ success: true, count: professionals.length, data: professionals });
  } catch (error) {
    res.status(500).json({ message: "Server error during geolocation search." });
  }
};

// Vet-to-vet search (by name, specialization, VCN)
export const searchProfessionals = async (req, res) => {
  try {
    const { q, lng, lat, distance = 50, role = 'vet', limit = 20 } = req.query;

    if (!q && (!lng || !lat)) {
      return res.status(400).json({ message: 'Provide query or coordinates' });
    }

    const filters = { role: role };
    // Only vets with approved verification
    if (role === 'vet') {
      filters['vetVerification.status'] = 'approved';
      filters.isVerified = true;
    }

    if (q) {
      const regex = new RegExp(q, 'i');
      filters.$or = [
        { name: regex },
        { 'vetDetails.specialization': regex },
        { 'vetDetails.vcnNumber': regex }
      ];
    }

    // If coordinates provided, perform geo-near first
    if (lng && lat) {
      const radiusInMeters = distance * 1000;
      filters.location = {
        $near: {
          $geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
          $maxDistance: radiusInMeters
        }
      };
    }

    const cacheKey = `professionals:search:${role}:${q || ''}:${lng || ''}:${lat || ''}:${distance}:${limit}`;
    const results = await cache.cacheWrap(cacheKey, 60, async () => {
      return await User.find(filters).select('name email role location vetDetails').limit(parseInt(limit, 10)).lean();
    });
    res.json({ count: results.length, data: results });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};