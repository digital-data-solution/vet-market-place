import Professional from '../models/Professional.js';
import User from '../models/User.js';
import cache from '../lib/cache.js';
import axios from 'axios';
import logger from '../lib/logger.js';

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
    console.error('Geocoding error:', error.message);
    return null;
  }
};

// Onboard a new professional (vet or kennel)

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
        return res.status(400).json({ 
          success: false,
          message: 'This VCN number is already registered.' 
        });
      }
    }

    logger.info(`Onboarding professional: ${name} (${role})`, { userId, body: req.body });

    // Geocode the address
    const location = await geocodeAddress(address);
    if (!location) {
      console.warn(`Failed to geocode address: ${address}`);
      // Continue anyway - location is optional
    }

    // Create professional profile
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
      location,
      isVerified: false, // Requires admin verification for vets
    });

    await professional.save();

    // Update User model to reflect professional status
    await User.findByIdAndUpdate(userId, {
      role: role === 'vet' ? 'vet' : 'kennel_owner',
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

    res.status(201).json({ 
      success: true,
      message: role === 'vet' 
        ? 'Professional profile created. VCN verification pending.' 
        : 'Kennel profile created successfully.',
      data: professional 
    });
  } catch (error) {
    console.error('Onboard professional error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to create professional profile. Please try again.',
      error: error.message 
    });
  }
};

// Update professional profile
export const updateProfessional = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const updates = req.body;

    // Don't allow changing userId or role
    delete updates.userId;
    delete updates.role;

    // If address is being updated, re-geocode
    if (updates.address) {
      const location = await geocodeAddress(updates.address);
      if (location) {
        updates.location = location;
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

    res.json({ 
      success: true,
      message: 'Profile updated successfully',
      data: professional 
    });
  } catch (error) {
    console.error('Update professional error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to update profile. Please try again.',
      error: error.message 
    });
  }
};

// Get current user's professional profile
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
    console.error('Get professional error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch profile',
      error: error.message 
    });
  }
};

// Get professional profile by ID (public)
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
    console.error('Get professional error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch profile',
      error: error.message 
    });
  }
};

// List all verified professionals (with optional filtering)
export const listProfessionals = async (req, res) => {
  try {
    const { role, limit = 50, page = 1 } = req.query;

    const filters = { isVerified: true };
    if (role && ['vet', 'kennel'].includes(role)) {
      filters.role = role;
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
    console.error('List professionals error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch professionals',
      error: error.message 
    });
  }
};

// Search nearby professionals (location-based)
export const getNearbyProfessionals = async (req, res) => {
  try {
    const { lng, lat, distance = 10, role, search } = req.query;

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

    res.json({
      success: true,
      count: professionalsWithDistance.length,
      data: professionalsWithDistance,
      message: professionalsWithDistance.length > 0 
        ? `Found ${professionalsWithDistance.length} professional(s) nearby`
        : 'No professionals found in this area'
    });
  } catch (error) {
    console.error('Nearby professionals error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to search for nearby professionals. Please try again.',
      error: error.message
    });
  }
};

// Delete professional profile (user can delete their own)
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
      $unset: { vetDetails: '', kennelDetails: '' }
    });

    // Clear cache
    await cache.del(`professional:${userId}`);

    res.json({ 
      success: true,
      message: 'Professional profile deleted successfully' 
    });
  } catch (error) {
    console.error('Delete professional error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to delete profile',
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