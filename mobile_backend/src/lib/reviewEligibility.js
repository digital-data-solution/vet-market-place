/**
 * reviewEligibility.js
 *
 * Eligibility gate for the review system.
 *
 * A user may only review a professional/shop if there is at least one message
 * between them in the Supabase messages table (either direction).
 * This prevents strangers leaving reviews for listings they've never engaged with.
 */

import { supabaseAdmin } from './supabase.js';
import logger           from './logger.js';

/**
 * Returns true if userSupabaseId and targetSupabaseId have exchanged
 * at least one message in either direction.
 *
 * @param {string} userSupabaseId   - Supabase UUID of the reviewing user
 * @param {string} targetSupabaseId - Supabase UUID of the professional/shop owner
 * @returns {Promise<boolean>}
 */
export async function hasContactedProfessional(userSupabaseId, targetSupabaseId) {
  if (!userSupabaseId || !targetSupabaseId) return false;

  // Guard: a user cannot review themselves
  if (userSupabaseId === targetSupabaseId) return false;

  try {
    // PostgREST OR syntax: match rows where either party sent the first message
    const { count, error } = await supabaseAdmin
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .or(
        `and(from_user_id.eq.${userSupabaseId},to_user_id.eq.${targetSupabaseId}),` +
        `and(from_user_id.eq.${targetSupabaseId},to_user_id.eq.${userSupabaseId})`,
      );

    if (error) {
      logger.error('reviewEligibility: Supabase query failed', { error: error.message });
      // Fail open — don't block the review if Supabase is temporarily down
      return false;
    }

    return (count ?? 0) > 0;
  } catch (err) {
    logger.error('reviewEligibility: unexpected error', { error: err.message });
    return false;
  }
}
