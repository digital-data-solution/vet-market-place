/**
 * Unified "near me" search — combines Professional (vets, kennels, groomers,
 * etc. — all live in one collection, see models/Professional.js) and Shop
 * results in a single distance-sorted call, own-DB-first.
 *
 * Deliberately does NOT include Xpress Market listings — those already have
 * their own free-to-browse nearest-sort (market.controller.js browseListings
 * with sort=nearest) and are not subscription-gated, unlike professional/shop
 * GPS search. Merging them in here would either wrongly paywall free listings
 * or wrongly give away the paid GPS-search feature — kept separate on purpose.
 *
 * Google Places Nearby Search only fires as a supplement when our own results
 * are sparse, and only once GOOGLE_MAPS_API_KEY + ENABLE_GOOGLE_NEARBY_FALLBACK
 * are both set — see services/googlePlaces.service.js for the full ToS/cost
 * rationale. Until then this endpoint is 100% own-DB, same as the existing
 * per-type /nearby endpoints it complements.
 */
import Professional from '../models/Professional.js';
import Shop from '../models/Shop.js';
import cache from '../lib/cache.js';
import logger from '../lib/logger.js';
import { calculateDistanceKm } from '../lib/geoDistance.js';
import { searchNearbyPlaces, isGoogleNearbyFallbackEnabled } from '../services/googlePlaces.service.js';

// Below this many combined own-DB results, we supplement with Google (when enabled).
const GOOGLE_FALLBACK_THRESHOLD = 3;

const VALID_NEARBY_ROLES = [
  'vet', 'kennel', 'groomer', 'trainer', 'pet_sitter',
  'pet_transport', 'cremation_service', 'agro_vet_supplier', 'insurance_provider',
  'pet_pharmacy', 'rescue_center', 'pet_hotel', 'farm',
];

export const getUnifiedNearby = async (req, res) => {
  try {
    const { lng, lat, distance = 10, role, limit = 30 } = req.query;

    if (!lng || !lat) {
      return res.status(400).json({
        success: false,
        message: 'Coordinates (lng, lat) are required for location-based search.',
      });
    }

    const parsedLng = parseFloat(lng);
    const parsedLat = parseFloat(lat);
    const radiusInMeters = parseFloat(distance) * 1000;
    const resultLimit = Math.min(parseInt(limit, 10) || 30, 50);

    const geoFilter = {
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [parsedLng, parsedLat] },
          $maxDistance: radiusInMeters,
        },
      },
    };

    const professionalQuery = { ...geoFilter, isVerified: true };
    if (role && VALID_NEARBY_ROLES.includes(role)) {
      professionalQuery.role = role;
      if (role === 'insurance_provider') professionalQuery.verificationStatus = 'approved';
    } else {
      professionalQuery.$and = [
        {
          $or: [
            { role: { $ne: 'insurance_provider' } },
            { role: 'insurance_provider', verificationStatus: 'approved' },
          ],
        },
      ];
    }

    const cacheKey = `search:nearby:${parsedLng}:${parsedLat}:${distance}:${role || 'all'}`;
    const [professionalsRaw, shopsRaw] = await cache.cacheWrap(cacheKey, 60, async () => {
      return Promise.all([
        Professional.find(professionalQuery)
          .select('name businessName role specialization address location isVerified profileImage')
          .limit(resultLimit)
          .lean(),
        (!role || role === 'shop')
          ? Shop.find({ ...geoFilter, isVerified: true })
              .select('name address location isVerified profileImage')
              .limit(resultLimit)
              .lean()
          : Promise.resolve([]),
      ]);
    });

    const withDistance = (docs, kind) => docs
      .filter((d) => d.location?.coordinates?.length === 2)
      .map((d) => {
        const [docLng, docLat] = d.location.coordinates;
        return {
          source:   'xpressvet',
          kind,
          id:       d._id,
          name:     d.businessName || d.name,
          role:     d.role || 'shop',
          address:  d.address || null,
          lat:      docLat,
          lng:      docLng,
          distance: parseFloat(calculateDistanceKm(parsedLat, parsedLng, docLat, docLng).toFixed(2)),
        };
      });

    let ownResults = [
      ...withDistance(professionalsRaw, 'professional'),
      ...withDistance(shopsRaw, 'shop'),
    ].sort((a, b) => a.distance - b.distance).slice(0, resultLimit);

    let googleResults = [];
    let attribution = null;

    if (ownResults.length < GOOGLE_FALLBACK_THRESHOLD && isGoogleNearbyFallbackEnabled()) {
      const fallback = await searchNearbyPlaces({
        lat: parsedLat,
        lng: parsedLng,
        radiusMeters: radiusInMeters,
      });
      googleResults = fallback.results.map((r) => ({
        source:   'google',
        kind:     'external',
        id:       r.placeId,
        name:     r.name,
        role:     null,
        address:  r.address,
        lat:      r.lat,
        lng:      r.lng,
        distance: (r.lat != null && r.lng != null)
          ? parseFloat(calculateDistanceKm(parsedLat, parsedLng, r.lat, r.lng).toFixed(2))
          : null,
        rating:   r.rating,
        phone:    r.phone,
        googleMapsUri: r.googleMapsUri,
      }));
      attribution = fallback.attribution;
    }

    return res.json({
      success: true,
      data: {
        results:     [...ownResults, ...googleResults],
        ownCount:    ownResults.length,
        googleCount: googleResults.length,
        attribution, // client MUST render this when present — Google ToS requirement
      },
    });
  } catch (error) {
    logger.error('Unified nearby search error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Unable to search nearby right now. Please try again.' });
  }
};

export default { getUnifiedNearby };
