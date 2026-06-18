import Professional from '../models/Professional.js';
import User from '../models/User.js';
import ActivityLog from '../models/ActivityLog.js';
import cache from '../lib/cache.js';
import axios from 'axios';
import logger from '../lib/logger.js';
import Subscription from '../models/Subscription.js';
import {
  sendDocumentSubmissionReceived,
  sendAdminDocumentReviewAlert,
} from '../services/email.service.js';
import { logActivity } from '../lib/activityLogger.js';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Geocode an address to GeoJSON coordinates using LocationIQ.
 * Results are cached in Redis for 30 days — same address hits LocationIQ only once.
 * Returns null on failure — callers must handle null gracefully.
 *
 * Uses progressive fallback: tries the full address, then strips leading
 * comma-parts one at a time (street number → street → neighbourhood → city).
 * Nigerian OSM data is sparse at street level — falling back to neighbourhood
 * or city still gives useful proximity for nearby search.
 */
const geocodeAddress = async (address) => {
  const key = `geocode:${address.trim().toLowerCase()}`;

  return cache.cacheWrap(key, 30 * 24 * 3600, async () => {
    const liqKey = process.env.LOCATIONIQ_KEY;
    if (!liqKey) {
      logger.warn('LOCATIONIQ_KEY not set — skipping geocode');
      return null;
    }

    // Build candidate list: full address, then drop leading comma-parts,
    // then try last 1-3 words of the final part (city/state names are usually
    // at the end — handles "Veterinary Clinic Kwoi" → "Kwoi" and
    // "Odo Ona Kekere Ibadan" → "Ibadan").
    const parts = address.trim().split(',').map(s => s.trim()).filter(Boolean);
    const set = new Set();
    for (let i = 0; i < Math.min(parts.length, 4); i++) {
      set.add(parts.slice(i).join(', '));
    }
    const lastPart = parts[parts.length - 1] || address.trim();
    const words = lastPart.split(/\s+/).filter(Boolean);
    for (let w = 1; w <= Math.min(3, words.length); w++) {
      const tail = words.slice(words.length - w).join(' ');
      if (tail.length > 2) set.add(tail);
    }
    const candidates = [...set];

    for (const candidate of candidates) {
      try {
        const response = await axios.get('https://us1.locationiq.com/v1/search', {
          params: { key: liqKey, q: candidate, format: 'json', limit: 1, countrycodes: 'ng' },
          timeout: 5000,
        });

        if (Array.isArray(response.data) && response.data.length > 0) {
          const { lat, lon } = response.data[0];
          if (candidate !== parts.join(', ')) {
            logger.info(`Geocoded via fallback "${candidate}" for original: "${address}"`);
          }
          return { type: 'Point', coordinates: [parseFloat(lon), parseFloat(lat)] };
        }
      } catch (error) {
        logger.warn('Geocoding attempt failed', { candidate, error: error.message });
      }
    }

    logger.warn(`Could not geocode address after all fallbacks: "${address}"`);
    return null;
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
 * Lift profileImage/mediaImages from the populated userId subdoc to top level,
 * mirroring the single-profile fetch enrichment so list/nearby cards can render
 * a real photo instead of always falling back to the role emoji.
 */
function liftUserMedia(prof) {
  const mediaImages  = (prof.userId?.mediaImages ?? []).filter(m => m.url);
  const profileImage = prof.userId?.profileImage ?? null;
  return { ...prof, mediaImages, profileImage };
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
    const { name, vcnNumber, role, businessName, address, specialization, phone, email, verificationDocuments } = req.body;

    // ── Basic validation ────────────────────────────────────────────────────
    if (!name || !role) {
      logger.warn('Onboarding failed: missing name or role', { userId, body: req.body });
      return res.status(400).json({
        success: false,
        message: 'Name and role are required.',
      });
    }

    const VALID_ROLES = [
      'vet', 'kennel', 'groomer', 'trainer', 'pet_sitter',
      'pet_transport', 'cremation_service', 'agro_vet_supplier', 'insurance_provider',
      'pet_pharmacy', 'rescue_center', 'pet_hotel', 'farm',
    ];
    // Roles where businessName is required (not optional)
    const BUSINESS_NAME_REQUIRED = new Set([
      'kennel', 'pet_transport', 'cremation_service', 'agro_vet_supplier', 'insurance_provider',
      'pet_pharmacy', 'rescue_center', 'pet_hotel', 'farm',
    ]);

    if (!VALID_ROLES.includes(role)) {
      logger.warn('Onboarding failed: invalid role', { userId, role });
      return res.status(400).json({
        success: false,
        message: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}.`,
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

    if (BUSINESS_NAME_REQUIRED.has(role) && !businessName) {
      logger.warn('Onboarding failed: missing business name', { userId, role });
      return res.status(400).json({
        success: false,
        message: 'Business name is required for this service type.',
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
      ...(verificationDocuments && typeof verificationDocuments === 'object' && { verificationDocuments }),
    });

    await professional.save();

    // ── Sync User model ─────────────────────────────────────────────────────
    // Map Professional.role → User.role (kennel stays kennel_owner for legacy reasons)
    const USER_ROLE_MAP = {
      vet:               'vet',
      kennel:            'kennel_owner',
      groomer:           'groomer',
      trainer:           'trainer',
      pet_sitter:        'pet_sitter',
      pet_transport:     'pet_transport',
      cremation_service: 'cremation_service',
      agro_vet_supplier: 'agro_vet_supplier',
      insurance_provider: 'insurance_provider',
    };
    await User.findByIdAndUpdate(userId, {
      role: USER_ROLE_MAP[role] ?? role,
      ...(location && { location }),
    });

    logger.info('Professional profile created successfully', {
      userId,
      professionalId: professional._id,
      role,
      geocoded: !!location,
    });
    logActivity(userId, req.user.role, 'professional.onboarded', {
      professionalId: professional._id,
      role,
      needsReview,
    }, req);

    const REQUIRES_ADMIN_REVIEW = new Set(['vet', 'insurance_provider', 'pet_transport', 'cremation_service', 'agro_vet_supplier', 'pet_pharmacy', 'rescue_center', 'farm']);
    const needsReview = REQUIRES_ADMIN_REVIEW.has(role);

    // ── Fire-and-forget emails — never block the response ───────────────────
    const profEmail  = email?.trim() || req.user?.email;
    const adminEmail = process.env.ADMIN_EMAIL || 'contact@xpressdigitalanddatasolutions.online';

    if (profEmail && needsReview) {
      sendDocumentSubmissionReceived(name, profEmail, role).catch(() => {});
    }
    if (adminEmail && needsReview) {
      sendAdminDocumentReviewAlert(adminEmail, {
        name, email: profEmail, role, businessName,
        vcnNumber: role === 'vet' ? vcnNumber : undefined,
        verificationDocuments,
      }).catch(() => {});
    }

    res.status(201).json({
      success: true,
      message: needsReview
        ? 'Profile created. Pending admin review — you will be notified once approved.'
        : 'Profile created and listed successfully.',
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
        .populate('userId', 'name email phone isVerified profileImage mediaImages')
        .lean();
    });

    if (!professional) {
      return res.status(404).json({
        success: false,
        message: 'Professional profile not found.',
      });
    }

    // Lift mediaImages and profileImage to top level; filter null-URL entries from old broken uploads
    const mediaImages  = (professional.userId?.mediaImages ?? []).filter(m => m.url);
    const profileImage = professional.userId?.profileImage ?? null;

    res.json({
      success: true,
      data: { ...professional, mediaImages, profileImage },
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
      .populate('userId', 'name email phone supabaseId profileImage mediaImages')
      .select('-__v')
      .lean();

    if (!professional) {
      return res.status(404).json({
        success: false,
        message: 'Professional not found.',
      });
    }

    const requestingUserId = req.user?._id?.toString() || req.user?.id?.toString();
    const profileUserId = professional.userId?._id?.toString();

    // Count views and log activity for non-owner visitors (fire-and-forget)
    if (requestingUserId !== profileUserId) {
      Professional.findByIdAndUpdate(id, { $inc: { profileViews: 1 } }).catch(() => {});
      logActivity(req.user?._id || req.user?.id, req.user?.role, 'profile.view', {
        targetId:   id,
        targetType: 'professional',
        targetRole: professional.role,
      }, req);
    }

    if (!professional.isVerified && requestingUserId !== profileUserId) {
      return res.status(403).json({
        success: false,
        message: 'This professional profile is pending verification.',
      });
    }

    // Lift mediaImages and profileImage from the populated userId subdoc to top level; filter null-URL entries
    const mediaImages   = (professional.userId?.mediaImages ?? []).filter(m => m.url);
    const profileImage  = professional.userId?.profileImage  ?? null;
    const enriched      = { ...professional, mediaImages, profileImage };

    // Profile owner always sees full data
    if (requestingUserId === profileUserId) {
      return res.json({ success: true, data: { ...enriched, isPreview: false } });
    }

    // Freemium gate for everyone else
    if (req.subscription?.isActive === true) {
      return res.json({ success: true, data: { ...enriched, isPreview: false } });
    }

    const userId = req.user._id || req.user.id;
    const user = await User.findById(userId).select('freeSearchUsed').lean();

    if (!user?.freeSearchUsed) {
      await User.findByIdAndUpdate(userId, { freeSearchUsed: true });
      return res.json({ success: true, data: { ...enriched, isPreview: false }, usedFreeSearch: true });
    }

    const parts = (professional.address || '').split(',').map(s => s.trim()).filter(Boolean);
    return res.json({
      success: true,
      data: {
        _id:            professional._id,
        name:           professional.name,
        businessName:   professional.businessName,
        role:           professional.role,
        vcnNumber:      professional.vcnNumber,
        specialization: professional.specialization,
        address:        parts.slice(-2).join(', '),
        rating:         professional.rating,
        reviewCount:    professional.reviewCount,
        isVerified:     professional.isVerified,
        profileImage,
        mediaImages,
        isPreview:      true,
        // Viewer's current plan (if any) so the frontend can show "Upgrade" vs "Subscribe"
        viewerPlan:     req.subscription?.plan ?? null,
      },
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
    const { role, limit = 50, page = 1, vcnNumber, search } = req.query;

    const VALID_LIST_ROLES = [
      'vet', 'kennel', 'groomer', 'trainer', 'pet_sitter',
      'pet_transport', 'cremation_service', 'agro_vet_supplier', 'insurance_provider',
      'pet_pharmacy', 'rescue_center', 'pet_hotel', 'farm',
    ];
    const filters = { isVerified: true };

    if (role && VALID_LIST_ROLES.includes(role)) {
      filters.role = role;
      if (role === 'insurance_provider') filters.verificationStatus = 'approved';
    } else {
      // Hide unverified insurance_providers from the "all" listing
      filters.$and = [
        {
          $or: [
            { role: { $ne: 'insurance_provider' } },
            { role: 'insurance_provider', verificationStatus: 'approved' },
          ],
        },
      ];
    }

    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      filters.$or = [
        { name: regex },
        { businessName: regex },
        { specialization: regex },
        { address: regex },
        { vcnNumber: regex },
      ];
    }

    // VCN lookup — returns immediately without pagination
    if (vcnNumber) {
      filters.vcnNumber = vcnNumber.trim();
      const professional = await Professional.findOne(filters)
        .populate('userId', 'name email phone profileImage mediaImages')
        .select('-__v')
        .lean();

      return res.json({
        success: true,
        count: professional ? 1 : 0,
        total: professional ? 1 : 0,
        page: 1,
        totalPages: 1,
        data: professional ? [liftUserMedia(professional)] : [],
      });
    }

    const cacheKey = `professionals:list:${role || 'all'}:${page}:${limit}:${search || ''}`;
    const result = await cache.cacheWrap(cacheKey, search ? 30 : 120, async () => {
      const [professionalsRaw, total] = await Promise.all([
        Professional.find(filters)
          .populate('userId', 'name email phone profileImage mediaImages')
          .select('-__v')
          .limit(parseInt(limit))
          .skip((parseInt(page) - 1) * parseInt(limit))
          .sort({ createdAt: -1 })
          .lean(),
        Professional.countDocuments(filters),
      ]);
      const professionals = professionalsRaw.map(liftUserMedia);

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

    logActivity(req.user?._id || req.user?.id, req.user?.role, 'search.list', {
      role:      role || null,
      search:    search || null,
      page:      parseInt(page),
      results:   data.length,
      isPreview,
    }, req);

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

    const VALID_NEARBY_ROLES = [
      'vet', 'kennel', 'groomer', 'trainer', 'pet_sitter',
      'pet_transport', 'cremation_service', 'agro_vet_supplier', 'insurance_provider',
      'pet_pharmacy', 'rescue_center', 'pet_hotel', 'farm',
    ];
    if (role && VALID_NEARBY_ROLES.includes(role)) {
      query.role = role;
      if (role === 'insurance_provider') query.verificationStatus = 'approved';
    } else {
      query.$and = [
        {
          $or: [
            { role: { $ne: 'insurance_provider' } },
            { role: 'insurance_provider', verificationStatus: 'approved' },
          ],
        },
      ];
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
    const professionalsRaw = await cache.cacheWrap(cacheKey, 60, async () => {
      return await Professional.find(query)
        .populate('userId', 'name phone email profileImage mediaImages')
        .select('-__v')
        .limit(50)
        .lean();
    });
    const professionals = professionalsRaw.map(liftUserMedia);

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

    logActivity(req.user?._id || req.user?.id, req.user?.role, 'search.nearby', {
      role:        role || null,
      search:      search || null,
      distanceKm:  parseFloat(distance),
      results:     data.length,
      isPreview,
    }, req);

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
// ─── ADMIN: re-geocode professionals with missing coordinates ─────────────────

/**
 * POST /api/v1/professionals/admin/regeocode
 * Admin-only. Finds all Professional docs that have no location coordinates
 * and re-geocodes them using LocationIQ. Returns a summary of what was fixed.
 *
 * Run this once after deploying the LocationIQ geocoding fix to backfill the
 * professionals who were registered when Nominatim was rate-limited.
 */
export const regeocodeAll = async (req, res) => {
  try {
    // Find professionals missing coordinates
    const missing = await Professional.find({
      $or: [
        { location: null },
        { 'location.coordinates': { $exists: false } },
        { 'location.coordinates': { $size: 0 } },
      ],
      address: { $exists: true, $ne: '' },
    }).select('_id name address role').lean();

    if (missing.length === 0) {
      return res.json({ success: true, message: 'All professionals already have coordinates.', fixed: 0 });
    }

    let fixed = 0;
    let failed = 0;
    const errors = [];

    for (const prof of missing) {
      try {
        // Invalidate cached null result so LocationIQ is actually called
        await cache.del(`geocode:${prof.address.trim().toLowerCase()}`);

        const location = await geocodeAddress(prof.address);
        if (location) {
          await Professional.findByIdAndUpdate(prof._id, { $set: { location } });
          await User.findByIdAndUpdate(prof.userId, { $set: { location } }).catch(() => {});
          fixed++;
          logger.info('Re-geocoded professional', { id: prof._id, name: prof.name, address: prof.address });
        } else {
          failed++;
          errors.push({ id: prof._id, name: prof.name, address: prof.address, reason: 'geocode returned null' });
        }
      } catch (err) {
        failed++;
        errors.push({ id: prof._id, name: prof.name, address: prof.address, reason: err.message });
      }
    }

    return res.json({
      success: true,
      message: `Re-geocoded ${fixed} of ${missing.length} professionals.`,
      total: missing.length,
      fixed,
      failed,
      errors: errors.slice(0, 20), // cap output
    });
  } catch (err) {
    logger.error('regeocodeAll error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Re-geocoding failed.', error: err.message });
  }
};

// ─── GET /me/stats ────────────────────────────────────────────────────────────

/**
 * Returns profile view count + contact-tap breakdown for the logged-in
 * professional's own listing. Used by the ProfileScreen dashboard card.
 * Returns zero counts if the user has no professional profile.
 */
export const getMyStats = async (req, res) => {
  try {
    const professional = await Professional.findOne({ userId: req.user._id })
      .select('profileViews rating reviewCount')
      .lean();

    const empty = { profileViews: 0, contactTaps: { total: 0, phone: 0, whatsapp: 0, email: 0 }, rating: 0, reviewCount: 0 };
    if (!professional) return res.json({ success: true, data: empty });

    const taps = await ActivityLog.aggregate([
      {
        $match: {
          action: 'contact.tapped',
          'metadata.targetId': professional._id.toString(),
        },
      },
      { $group: { _id: '$metadata.method', count: { $sum: 1 } } },
    ]);

    const tapMap = { phone: 0, whatsapp: 0, email: 0 };
    taps.forEach(t => { if (t._id && t._id in tapMap) tapMap[t._id] = t.count; });
    const total = tapMap.phone + tapMap.whatsapp + tapMap.email;

    return res.json({
      success: true,
      data: {
        profileViews: professional.profileViews ?? 0,
        contactTaps:  { total, ...tapMap },
        rating:       professional.rating      ?? 0,
        reviewCount:  professional.reviewCount ?? 0,
      },
    });
  } catch (err) {
    logger.error('getMyStats error', { error: err.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
  }
};
