import Professional from '../models/Professional.js';
import User from '../models/User.js';
import cache from '../lib/cache.js';
import axios from 'axios';
import logger from '../lib/logger.js';
import Subscription from '../models/Subscription.js';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Geocode an address to GeoJSON coordinates using Nominatim (OpenStreetMap).
 * Results are cached in Redis for 30 days — same address hits Nominatim only once.
 * Returns null on failure — callers must handle null gracefully.
 */
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
      logger.error('Geocoding error', { error: error.message });
      return null;
    }
  });
};

/**
 * Calculate distance between two lat/lng pairs using the Haversine formula.
 * Returns distance in kilometres.
 */
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

/**
 * Strip contact details and truncate address to city/state for non-subscribed users
 * who have already consumed their one free full-detail search.
 */
function redactProfessional(prof) {
  const parts = (prof.address || '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    _id:            prof._id,
    name:           prof.name,
    businessName:   prof.businessName,
    role:           prof.role,
    specialization: prof.specialization,
    address:        parts.slice(-2).join(', '),
    rating:         prof.rating,
    reviewCount:    prof.reviewCount,
    isVerified:     prof.isVerified,
    distance:       prof.distance,
  };
}

/**
 * Freemium gate — determines what data shape to return based on subscription state.
 *
 * Subscribed  → full data, isPreview: false
 * Not subscribed, first search  → full data, isPreview: false, usedFreeSearch: true
 * Not subscribed, search used   → redacted data, isPreview: true
 */
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

  return { data: data.map(redactProfessional), isPreview: true, usedFreeSearch: false };
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

    // ── Basic validation ────────────────────────────────────────────────────
    if (!name || !role) {
      logger.warn('Onboarding failed: missing name or role', { userId, body: req.body });
      return res.status(400).json({
        success: false,
        message: 'Name and role are required.',
      });
    }

    if (!['vet', 'kennel'].includes(role)) {
      logger.warn('Onboarding failed: invalid role', { userId, role });
      return res.status(400).json({
        success: false,
        message: 'Role must be either "vet" or "kennel".',
      });
    }

    if (!address || !address.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Address is required.',
      });
    }

    if (role === 'vet' && !vcnNumber) {
      logger.warn('Onboarding failed: missing VCN number for vet', { userId, name });
      return res.status(400).json({
        success: false,
        message: 'VCN number is required for veterinarians.',
      });
    }

    if (role === 'kennel' && !businessName) {
      logger.warn('Onboarding failed: missing business name for kennel', { userId, name });
      return res.status(400).json({
        success: false,
        message: 'Business name is required for kennels.',
      });
    }

    // ── Duplicate checks ────────────────────────────────────────────────────
    if (role === 'vet' && vcnNumber) {
      const vcnExists = await Professional.findOne({ vcnNumber: vcnNumber.trim() });
      if (vcnExists) {
        logger.warn('VCN number already registered', { vcnNumber: vcnNumber.trim() });
        return res.status(400).json({
          success: false,
          message: 'This VCN number is already registered.',
        });
      }
    }

    const existingProfile = await Professional.findOne({ userId });
    if (existingProfile) {
      logger.warn('Onboarding failed: profile already exists', { userId });
      return res.status(400).json({
        success: false,
        message: 'You already have a professional profile. Please update your existing profile instead.',
      });
    }

    logger.info(`Onboarding professional: ${name} (${role})`, { userId });

    // ── Geocoding (non-blocking) ────────────────────────────────────────────
    // A failed geocode does NOT block onboarding — location is optional.
    // The pre-save hook on Professional.js owns isVerified / verificationStatus.
    let location = null;
    if (address && address.trim()) {
      location = await geocodeAddress(address);
      if (!location) {
        logger.warn(`Failed to geocode address: ${address}`, { userId });
        // Intentionally continue — profile is saved without coordinates.
      }
    }

    // ── Create professional profile ─────────────────────────────────────────
    // FIX: Do NOT pass `isVerified` here. The pre('save') hook in Professional.js
    // is the single source of truth for verification status. Passing it here
    // caused a conflict that (when combined with the old missing-`next` bug)
    // produced the "next is not a function" 500 error.
    const professional = new Professional({
      userId,
      name: name.trim(),
      role,
      vcnNumber: role === 'vet' ? vcnNumber?.trim() : undefined,
      businessName: businessName?.trim(),
      address: address.trim(),
      specialization: specialization?.trim(),
      phone: phone?.trim(),
      email: email?.trim(),
      location, // null if geocoding failed — that's fine
    });

    await professional.save();

    // ── Sync User model ─────────────────────────────────────────────────────
    await User.findByIdAndUpdate(userId, {
      role: role === 'vet' ? 'vet' : 'kennel_owner',
      ...(location && { location }), // Only sync location if geocoding succeeded
      ...(role === 'vet' && {
        vetDetails: {
          vcnNumber: vcnNumber?.trim(),
          specialization: specialization?.trim(),
          businessName: businessName?.trim(),
        },
      }),
      ...(role === 'kennel' && {
        kennelDetails: {
          businessName: businessName?.trim(),
          services: specialization?.trim(),
        },
      }),
    });

    logger.info('Professional profile created successfully', {
      userId,
      professionalId: professional._id,
      role,
      geocoded: !!location,
    });

    res.status(201).json({
      success: true,
      message:
        role === 'vet'
          ? 'Professional profile created. VCN verification pending admin approval.'
          : 'Kennel profile created and activated successfully.',
      data: professional,
    });
  } catch (error) {
    logger.error('Onboard professional error', { error: error.message, stack: error.stack });

    // Handle duplicate key errors gracefully
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0];
      if (field === 'userId') {
        return res.status(400).json({
          success: false,
          message: 'You already have a professional profile.',
        });
      }
      if (field === 'vcnNumber') {
        return res.status(400).json({
          success: false,
          message: 'This VCN number is already registered.',
        });
      }
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create professional profile. Please try again.',
      error: error.message,
    });
  }
};

// ============================================================================
// UPDATE PROFILE
// ============================================================================

/**
 * Update professional profile
 * PUT /api/v1/professionals/profile
 */
export const updateProfessional = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const updates = req.body;

    // ── Plan-based image limit ───────────────────────────────────────────────
    if (updates.images) {
      const sub = await Subscription.findOne({
        user: userId,
        status: 'active',
        endDate: { $gte: new Date() },
      });
      let maxImages = 1;
      if (sub?.plan === 'premium') maxImages = 5;
      if (sub?.plan === 'enterprise') maxImages = 1000;
      if (updates.images.length > maxImages) {
        return res.status(400).json({
          success: false,
          message: `Your plan allows up to ${maxImages} profile photo(s).`,
        });
      }
    }

    // ── Protect immutable fields ─────────────────────────────────────────────
    delete updates.userId;
    delete updates.role;
    delete updates.isVerified;
    delete updates.verificationStatus;
    delete updates.verifiedAt;

    // ── Re-geocode if address changed ────────────────────────────────────────
    if (updates.address && updates.address.trim()) {
      const location = await geocodeAddress(updates.address);
      if (location) {
        updates.location = location;
        await User.findByIdAndUpdate(userId, { location });
      }
      // If geocoding fails, keep existing location — don't wipe it
    }

    const professional = await Professional.findOneAndUpdate(
      { userId },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!professional) {
      return res.status(404).json({
        success: false,
        message: 'Professional profile not found. Please create one first.',
      });
    }

    await cache.del(`professional:${userId}`);

    logger.info('Professional profile updated', { userId, updates: Object.keys(updates) });

    res.json({
      success: true,
      message: 'Profile updated successfully.',
      data: professional,
    });
  } catch (error) {
    logger.error('Update professional error', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      message: 'Failed to update profile. Please try again.',
      error: error.message,
    });
  }
};

// ============================================================================
// READ OPERATIONS
// ============================================================================

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
        message: 'Professional profile not found.',
      });
    }

    res.json({
      success: true,
      data: professional,
    });
  } catch (error) {
    logger.error('Get my professional profile error', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch profile.',
      error: error.message,
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
        message: 'Professional not found.',
      });
    }

    // Only show unverified profiles to the owner
    const requestingUserId = req.user?._id?.toString() || req.user?.id?.toString();
    const profileUserId = professional.userId?._id?.toString();

    if (!professional.isVerified && requestingUserId !== profileUserId) {
      return res.status(403).json({
        success: false,
        message: 'This professional profile is pending verification.',
      });
    }

    res.json({
      success: true,
      data: professional,
    });
  } catch (error) {
    logger.error('Get professional error', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch profile.',
      error: error.message,
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

    if (role && ['vet', 'kennel'].includes(role)) {
      filters.role = role;
    }

    // VCN lookup — returns immediately without pagination
    if (vcnNumber) {
      filters.vcnNumber = vcnNumber.trim();
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
        data: professional ? [professional] : [],
      });
    }

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
        Professional.countDocuments(filters),
      ]);

      // Fetch user IDs with active 'pro' subscriptions so we can sort them first
      const proUserIds = await Subscription.distinct('user', {
        plan:    'pro',
        status:  'active',
        endDate: { $gte: new Date() },
      });
      const proSet = new Set(proUserIds.map(id => id.toString()));

      professionals.sort((a, b) => {
        const aIsPro = proSet.has(a.userId?._id?.toString() ?? a.userId?.toString() ?? '');
        const bIsPro = proSet.has(b.userId?._id?.toString() ?? b.userId?.toString() ?? '');
        if (aIsPro && !bIsPro) return -1;
        if (!aIsPro && bIsPro) return 1;
        return 0;
      });

      return { professionals, total };
    });

    const { data, isPreview, usedFreeSearch } = await applyFreemiumGate(req, result.professionals);

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
    logger.error('List professionals error', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch professionals.',
      error: error.message,
    });
  }
};

/**
 * Search nearby professionals (location-based)
 * GET /api/v1/professionals/nearby
 * Query params: lng, lat, distance (km), role, search
 */
export const getNearbyProfessionals = async (req, res) => {
  try {
    const { lng, lat, distance = 10, role, search } = req.query;

    if (!lng || !lat) {
      return res.status(400).json({
        success: false,
        message: 'Coordinates (lng, lat) are required for location-based search.',
      });
    }

    const radiusInMeters = parseFloat(distance) * 1000;

    const query = {
      isVerified: true,
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [parseFloat(lng), parseFloat(lat)],
          },
          $maxDistance: radiusInMeters,
        },
      },
    };

    if (role && ['vet', 'kennel'].includes(role)) {
      query.role = role;
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query.$or = [
        { name: regex },
        { businessName: regex },
        { specialization: regex },
        { address: regex },
        { vcnNumber: regex },
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

    // Attach computed distance to each result
    const professionalsWithDistance = professionals.map(prof => {
      if (prof.location?.coordinates?.length === 2) {
        const [profLng, profLat] = prof.location.coordinates;
        const dist = calculateDistance(parseFloat(lat), parseFloat(lng), profLat, profLng);
        return { ...prof, distance: parseFloat(dist.toFixed(2)) };
      }
      return prof;
    });

    const { data, isPreview, usedFreeSearch } = await applyFreemiumGate(req, professionalsWithDistance);

    logger.info('Nearby professionals search', {
      lng, lat, distance, role, search,
      count: data.length,
    });

    res.json({
      success: true,
      count: data.length,
      data,
      isPreview,
      ...(usedFreeSearch && { usedFreeSearch: true }),
      message:
        data.length > 0
          ? `Found ${data.length} professional(s) nearby.`
          : 'No professionals found in this area.',
    });
  } catch (error) {
    logger.error('Nearby professionals error', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      message: 'Unable to search for nearby professionals. Please try again.',
      error: error.message,
    });
  }
};

// ============================================================================
// DELETE
// ============================================================================

/**
 * Delete professional profile (owner only)
 * DELETE /api/v1/professionals/profile
 */
export const deleteProfessional = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const professional = await Professional.findOneAndDelete({ userId });

    if (!professional) {
      return res.status(404).json({
        success: false,
        message: 'Professional profile not found.',
      });
    }

    // Reset user role back to pet_owner
    await User.findByIdAndUpdate(userId, {
      role: 'pet_owner',
      $unset: { vetDetails: '', kennelDetails: '', location: '' },
    });

    await cache.del(`professional:${userId}`);

    logger.info('Professional profile deleted', { userId, professionalId: professional._id });

    res.json({
      success: true,
      message: 'Professional profile deleted successfully.',
    });
  } catch (error) {
    logger.error('Delete professional error', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      message: 'Failed to delete profile.',
      error: error.message,
    });
  }
};