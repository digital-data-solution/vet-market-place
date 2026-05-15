import Professional from '../models/Professional.js';
import User from '../models/User.js';
import cache from '../lib/cache.js';
import axios from 'axios';
import logger from '../lib/logger.js';
import Subscription from '../models/Subscription.js';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// Helper: Geocode address to coordinates using a free geocoding service
const geocodeAddress = async (address) => {
  try {
    // Using Nominatim (OpenStreetMap) - free, no API key required
    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q: address,
        format: 'json',
        limit: 1,
        countrycodes: 'ng', // Restrict to Nigeria for better accuracy
      },
      headers: {
        'User-Agent': 'VetPlatform/1.0' // Required by Nominatim
      }
    });

    if (response.data && response.data.length > 0) {
      const { lat, lon } = response.data[0];
      return {
        type: 'Point',
        coordinates: [parseFloat(lon), parseFloat(lat)] // [longitude, latitude] for GeoJSON
      };
    }
    return null;
  } catch (error) {
    logger.error('Geocoding error', { error: error.message });
    return null;
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

// ============================================================================
// ONBOARDING & PROFILE MANAGEMENT
// ============================================================================

/**
 * Onboard a new professional (vet or kennel)
 * POST /api/v1/professionals/onboard
 */
export const onboardProfessional = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { name, vcnNumber, role, businessName, address, specialization, phone, email } = req.body;

    // Validation
    if (!name || !role) {
      logger.warn('Onboarding failed: missing name or role', { userId, body: req.body });
      return res.status(400).json({ 
        success: false,
        message: 'Name and role are required.' 
      });
    }

    if (!['vet', 'kennel'].includes(role)) {
      logger.warn('Onboarding failed: invalid role', { userId, role });
      return res.status(400).json({ 
        success: false,
        message: 'Role must be either "vet" or "kennel".' 
      });
    }

    if (role === 'vet' && !vcnNumber) {
      logger.warn('Onboarding failed: missing VCN number for vet', { userId, name });
      return res.status(400).json({ 
        success: false,
        message: 'VCN number is required for veterinarians.' 
      });
    }

    // Check for duplicate VCN number if vet
    if (role === 'vet' && vcnNumber) {
      const vcnExists = await Professional.findOne({ vcnNumber: vcnNumber.trim() });
      if (vcnExists) {
        logger.warn('VCN number already registered', { vcnNumber: vcnNumber.trim() });
        return res.status(400).json({ 
          success: false,
          message: 'This VCN number is already registered.' 
        });
      }
    }

    // Kennel requires businessName
    if (role === 'kennel' && !businessName) {
      logger.warn('Onboarding failed: missing business name for kennel', { userId, name });
      return res.status(400).json({ 
        success: false,
        message: 'Business name is required for kennels.' 
      });
    }

    logger.info(`Onboarding professional: ${name} (${role})`, { userId, body: req.body });

    // Geocode the address
    let location = null;
    if (address && address.trim()) {
      location = await geocodeAddress(address);
      if (!location) {
        logger.warn(`Failed to geocode address: ${address}`, { userId });
        // Continue anyway - location is optional
      }
    }

    // Create professional profile
    const professional = new Professional({
      userId,
      name: name.trim(),
      role,
      vcnNumber: role === 'vet' ? vcnNumber?.trim() : undefined,
      businessName: businessName?.trim(),
      address: address?.trim(),
      specialization: specialization?.trim(),
      phone: phone?.trim(),
      email: email?.trim(),
      location,
      isVerified: role === 'kennel', // Auto-verify kennels, vets need admin approval
    });

    await professional.save();

    // Update User model to reflect professional status
    await User.findByIdAndUpdate(userId, {
      role: role === 'vet' ? 'vet' : 'kennel_owner',
      location, // Sync location to User model for nearby search
      ...(role === 'vet' && {
        vetDetails: {
          vcnNumber: vcnNumber?.trim(),
          specialization: specialization?.trim(),
          businessName: businessName?.trim(),
        }
      }),
      ...(role === 'kennel' && {
        kennelDetails: {
          businessName: businessName?.trim(),
          services: specialization?.trim(),
        }
      })
    });

    logger.info('Professional profile created successfully', { 
      userId, 
      professionalId: professional._id,
      role 
    });

    res.status(201).json({ 
      success: true,
      message: role === 'vet' 
        ? 'Professional profile created. VCN verification pending.' 
        : 'Kennel profile created and activated successfully.',
      data: professional 
    });
  } catch (error) {
    logger.error('Onboard professional error', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      success: false,
      message: 'Failed to create professional profile. Please try again.',
      error: error.message 
    });
  }
};

/**
 * Update professional profile
 * PUT /api/v1/professionals/profile
 */
export const updateProfessional = async (req, res) => {
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

    // Don't allow changing userId or role
    delete updates.userId;
    delete updates.role;

    // If address is being updated, re-geocode
    if (updates.address) {
      const location = await geocodeAddress(updates.address);
      if (location) {
        updates.location = location;
        
        // Also sync to User model
        await User.findByIdAndUpdate(userId, { location });
      }
    }

    // Don't allow users to self-verify
    delete updates.isVerified;
    delete updates.verificationStatus;

    const professional = await Professional.findOneAndUpdate(
      { userId },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!professional) {
      return res.status(404).json({ 
        success: false,
        message: 'Professional profile not found. Please create one first.' 
      });
    }

    // Clear relevant cache
    await cache.del(`professional:${userId}`);

    logger.info('Professional profile updated', { userId, updates: Object.keys(updates) });

    res.json({ 
      success: true,
      message: 'Profile updated successfully',
      data: professional 
    });
  } catch (error) {
    logger.error('Update professional error', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      success: false,
      message: 'Failed to update profile. Please try again.',
      error: error.message 
    });
  }
};

/**
 * Get current user's professional profile
 * GET /api/v1/professionals/me
 */
export const getMyProfessionalProfile = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const cacheKey = `professional:${userId}`;
    const professional = await cache.cacheWrap(cacheKey, 300, async () => {
      return await Professional.findOne({ userId })
        .populate('userId', 'name email phone isVerified')
        .lean();
    });

    if (!professional) {
      return res.status(404).json({ 
        success: false,
        message: 'Professional profile not found' 
      });
    }

    res.json({ 
      success: true,
      data: professional 
    });
  } catch (error) {
    logger.error('Get professional error', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch profile',
      error: error.message 
    });
  }
};

/**
 * Get professional profile by ID (public)
 * GET /api/v1/professionals/:id
 */
export const getProfessional = async (req, res) => {
  try {
    const { id } = req.params;

    const professional = await Professional.findById(id)
      .populate('userId', 'name email phone')
      .select('-__v')
      .lean();

    if (!professional) {
      return res.status(404).json({ 
        success: false,
        message: 'Professional not found' 
      });
    }

    // Only show verified professionals publicly (except to themselves)
    const requestingUserId = req.user?._id?.toString() || req.user?.id?.toString();
    const profileUserId = professional.userId?._id?.toString();

    if (!professional.isVerified && requestingUserId !== profileUserId) {
      return res.status(403).json({ 
        success: false,
        message: 'This professional profile is pending verification' 
      });
    }

    res.json({ 
      success: true,
      data: professional 
    });
  } catch (error) {
    logger.error('Get professional error', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch profile',
      error: error.message 
    });
  }
};

// ============================================================================
// SEARCH & DISCOVERY
// ============================================================================

/**
 * List all verified professionals (with optional filtering)
 * GET /api/v1/professionals/list
 * Query params: role, limit, page, vcnNumber
 */
export const listProfessionals = async (req, res) => {
  try {
    const { role, limit = 50, page = 1, vcnNumber } = req.query;

    const filters = { isVerified: true };
    
    // Filter by role
    if (role && ['vet', 'kennel'].includes(role)) {
      filters.role = role;
    }

    // ✅ FIX: Add VCN number filtering for verification lookups
    if (vcnNumber) {
      filters.vcnNumber = vcnNumber.trim();
      
      // For VCN lookup, return immediately without pagination
      const professional = await Professional.findOne(filters)
        .populate('userId', 'name email phone')
        .select('-__v')
        .lean();
      
      return res.json({
        success: true,
        count: professional ? 1 : 0,
        total: professional ? 1 : 0,
        page: 1,
        totalPages: 1,
        data: professional ? [professional] : []
      });
    }

    // Regular list with pagination
    const cacheKey = `professionals:list:${role || 'all'}:${page}:${limit}`;
    const result = await cache.cacheWrap(cacheKey, 120, async () => {
      const [professionals, total] = await Promise.all([
        Professional.find(filters)
          .populate('userId', 'name email phone')
          .select('-__v')
          .limit(parseInt(limit))
          .skip((parseInt(page) - 1) * parseInt(limit))
          .sort({ createdAt: -1 })
          .lean(),
        Professional.countDocuments(filters)
      ]);

      return { professionals, total };
    });

    res.json({ 
      success: true,
      count: result.professionals.length,
      total: result.total,
      page: parseInt(page),
      totalPages: Math.ceil(result.total / parseInt(limit)),
      data: result.professionals 
    });
  } catch (error) {
    logger.error('List professionals error', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch professionals',
      error: error.message 
    });
  }
};

/**
 * Search nearby professionals (location-based)
 * GET /api/v1/professionals/nearby
 * Query params: lng, lat, distance, role, search
 */
export const getNearbyProfessionals = async (req, res) => {
  try {
    const { lng, lat, distance = 10, role, search } = req.query;

    if (!lng || !lat) {
      logger.warn('Nearby professionals search missing coordinates', { lng, lat });
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

    // Filter by role
    if (role && ['vet', 'kennel'].includes(role)) {
      query.role = role;
    }

    // Text search
    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query.$or = [
        { name: regex },
        { businessName: regex },
        { specialization: regex },
        { address: regex },
        { vcnNumber: regex }
      ];
    }

    const cacheKey = `professionals:nearby:${lng}:${lat}:${distance}:${role || 'all'}:${search || ''}`;
    const professionals = await cache.cacheWrap(cacheKey, 60, async () => {
      return await Professional.find(query)
        .populate('userId', 'name phone email')
        .select('-__v')
        .limit(50)
        .lean();
    });

    // Calculate distances
    const professionalsWithDistance = professionals.map(prof => {
      if (prof.location && prof.location.coordinates) {
        const [profLng, profLat] = prof.location.coordinates;
        const distance = calculateDistance(
          parseFloat(lat),
          parseFloat(lng),
          profLat,
          profLng
        );
        return { ...prof, distance: parseFloat(distance.toFixed(2)) };
      }
      return prof;
    });

    logger.info('Nearby professionals search', { 
      lng, 
      lat, 
      distance, 
      role, 
      search,
      count: professionalsWithDistance.length 
    });

    res.json({
      success: true,
      count: professionalsWithDistance.length,
      data: professionalsWithDistance,
      message: professionalsWithDistance.length > 0 
        ? `Found ${professionalsWithDistance.length} professional(s) nearby`
        : 'No professionals found in this area'
    });
  } catch (error) {
    logger.error('Nearby professionals error', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      message: 'Unable to search for nearby professionals. Please try again.',
      error: error.message
    });
  }
};

// ============================================================================
// PROFILE DELETION
// ============================================================================

/**
 * Delete professional profile (user can delete their own)
 * DELETE /api/v1/professionals/profile
 */
export const deleteProfessional = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const professional = await Professional.findOneAndDelete({ userId });

    if (!professional) {
      return res.status(404).json({ 
        success: false,
        message: 'Professional profile not found' 
      });
    }

    // Reset user role back to pet_owner
    await User.findByIdAndUpdate(userId, {
      role: 'pet_owner',
      $unset: { vetDetails: '', kennelDetails: '', location: '' }
    });

    // Clear cache
    await cache.del(`professional:${userId}`);

    logger.info('Professional profile deleted', { userId, professionalId: professional._id });

    res.json({ 
      success: true,
      message: 'Professional profile deleted successfully' 
    });
  } catch (error) {
    logger.error('Delete professional error', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      success: false,
      message: 'Failed to delete profile',
      error: error.message 
    });
  }
};