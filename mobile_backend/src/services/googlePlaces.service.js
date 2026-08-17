/**
 * Google Places API (New) — Nearby Search fallback ONLY.
 *
 * Xpress Vet's own MongoDB (Professional/Shop, both 2dsphere-indexed) is
 * always queried first — see api/search.controller.js. This service only
 * fires when the user's own-DB results are sparse, and only when explicitly
 * enabled, so it stays inert (and free) until both an API key exists and the
 * feature is turned on:
 *
 *   GOOGLE_MAPS_API_KEY              — required, from Google Cloud Console
 *   ENABLE_GOOGLE_NEARBY_FALLBACK    — must be exactly "true" to activate
 *
 * Deliberately does NOT touch geocoding/autocomplete — LocationIQ remains the
 * source of truth for onboarding addresses (see utils/location.ts on mobile
 * and the geocodeAddress() helpers in professional/shop/kennel controllers).
 *
 * ToS notes this respects:
 *  - Results are never persisted beyond the lifetime of a single response —
 *    no caching of raw Places data in Mongo, only place_id may be kept if a
 *    caller chooses to store it later.
 *  - Every response includes an `attribution` field the client MUST render
 *    (Google's Nearby Search results require "Powered by Google" attribution
 *    and must be shown on an actual Google Map, not a generic basemap).
 */
import axios from 'axios';
import logger from '../lib/logger.js';

const PLACES_BASE = 'https://places.googleapis.com/v1/places:searchNearby';

const FIELD_MASK = [
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.googleMapsUri',
  'places.id',
  'places.nationalPhoneNumber',
].join(',');

let warnedNoKey = false;

export function isGoogleNearbyFallbackEnabled() {
  return process.env.ENABLE_GOOGLE_NEARBY_FALLBACK === 'true' && !!process.env.GOOGLE_MAPS_API_KEY;
}

/**
 * @param {{ lat: number, lng: number, radiusMeters: number, includedType?: string, maxResults?: number }} opts
 * @returns {Promise<{ results: Array, attribution: string|null }>}
 */
export async function searchNearbyPlaces({ lat, lng, radiusMeters = 10000, includedType = 'veterinary_care', maxResults = 10 }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey || process.env.ENABLE_GOOGLE_NEARBY_FALLBACK !== 'true') {
    if (!warnedNoKey) {
      logger.info('Google Nearby Search fallback is inactive (missing GOOGLE_MAPS_API_KEY or ENABLE_GOOGLE_NEARBY_FALLBACK !== "true") — own-DB-only results will be returned.');
      warnedNoKey = true;
    }
    return { results: [], attribution: null };
  }

  try {
    const res = await axios.post(
      PLACES_BASE,
      {
        includedTypes: [includedType],
        maxResultCount: Math.min(maxResults, 20),
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius: Math.min(radiusMeters, 50000), // Google's Nearby Search cap
          },
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        timeout: 8000,
      },
    );

    const places = Array.isArray(res.data?.places) ? res.data.places : [];

    const results = places.map((p) => ({
      source:          'google',
      placeId:         p.id,
      name:            p.displayName?.text || 'Unknown',
      address:         p.formattedAddress || null,
      lat:             p.location?.latitude  ?? null,
      lng:             p.location?.longitude ?? null,
      rating:          p.rating ?? null,
      ratingCount:     p.userRatingCount ?? null,
      phone:           p.nationalPhoneNumber || null,
      googleMapsUri:   p.googleMapsUri || null,
    }));

    return {
      results,
      attribution: results.length > 0 ? 'Additional results powered by Google' : null,
    };
  } catch (err) {
    logger.error('Google Nearby Search error', {
      error:  err.message,
      status: err.response?.status,
      body:   JSON.stringify(err.response?.data)?.slice(0, 500),
    });
    return { results: [], attribution: null };
  }
}

export default { searchNearbyPlaces, isGoogleNearbyFallbackEnabled };
