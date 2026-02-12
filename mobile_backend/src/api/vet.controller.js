import User from '../models/User.js';
import cache from '../lib/cache.js';
import logger from '../lib/logger.js';

export const getNearbyProfessionals = async (req, res) => {
  try {
    const { lng, lat, distance = 10, type = 'all' } = req.query; // type: 'vet', 'kennel', 'all'

    if (!lng || !lat) {
        logger.warn('Nearby professionals search missing coordinates', { lng, lat });
      return res.status(400).json({
        success: false,
        message: "Coordinates are required for location-based search."
      });
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
        .select('name email phone role location vetDetails kennelDetails vetVerification.status')
        .limit(20)
        .sort({ 'vetVerification.status': -1, createdAt: -1 }) // Prioritize verified vets, then newest
        .lean();
    });

      logger.info('Nearby professionals search', { lng, lat, distance, type, count: professionals.length });
    res.status(200).json({
      success: true,
      count: professionals.length,
      data: professionals,
      message: professionals.length > 0 ? 'Nearby verified professionals found' : 'No verified professionals found in your area'
    });
  } catch (error) {
      logger.error('Nearby professionals search error', { error: error.message, stack: error.stack });
    console.error('Professional search error:', error);
    res.status(500).json({
      success: false,
      message: "Unable to search for professionals at this time. Please try again later."
    });
  }
};

// Professional search by name, specialty, or location
export const searchProfessionals = async (req, res) => {
  try {
    const { q, lng, lat, distance = 50, type = 'all', limit = 20 } = req.query;

    if (!q && (!lng || !lat)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a search query or coordinates for location-based search.'
      });
    }

    let filters = { isVerified: true };

    // Role-based filtering
    if (type === 'vet') {
      filters.role = 'vet';
      filters['vetVerification.status'] = 'approved'; // Only approved vets
    } else if (type === 'kennel') {
      filters.role = 'kennel_owner';
    } else {
      filters.role = { $in: ['vet', 'kennel_owner'] };
    }

    // Text search
    if (q && q.trim().length >= 2) {
      const regex = new RegExp(q.trim(), 'i');
      filters.$or = [
        { name: regex },
        { 'vetDetails.specialty': regex },
        { 'vetDetails.specialization': regex },
        { 'vetDetails.licenseNumber': regex },
        { 'vetDetails.vcnNumber': regex },
        { 'kennelDetails.businessName': regex },
        { email: regex }
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

    const cacheKey = `professionals:search:${type}:${q || ''}:${lng || ''}:${lat || ''}:${distance}:${limit}`;
    const professionals = await cache.cacheWrap(cacheKey, 60, async () => {
      return await User.find(filters)
        .select('name email phone role location vetDetails kennelDetails vetVerification.status')
        .limit(parseInt(limit))
        .sort({ 'vetVerification.status': -1, name: 1 }) // Prioritize verified vets, then alphabetical
        .lean();
    });

    const searchType = q ? `matching "${q}"` : `within ${distance}km`;
    res.status(200).json({
      success: true,
      count: professionals.length,
      data: professionals,
      message: professionals.length > 0
        ? `Found ${professionals.length} verified professional(s) ${searchType}`
        : `No verified professionals found ${searchType}`
    });
  } catch (error) {
    console.error('Professional search error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to perform search at this time. Please try again later.'
    });
  }
};