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
    // Two simple queries avoid PostgREST nested-AND-in-OR syntax issues.
    // Check either direction: user→professional or professional→user.
    const [fwd, rev] = await Promise.all([
      supabaseAdmin
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('from_user_id', userSupabaseId)
        .eq('to_user_id',   targetSupabaseId),
      supabaseAdmin
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('from_user_id', targetSupabaseId)
        .eq('to_user_id',   userSupabaseId),
    ]);

    if (fwd.error || rev.error) {
      const errMsg = (fwd.error ?? rev.error).message;
      logger.error('reviewEligibility: Supabase query failed', { error: errMsg });
      // Fail open — don't block legitimate reviews when Supabase is temporarily down
      return true;
    }

    return ((fwd.count ?? 0) + (rev.count ?? 0)) > 0;
  } catch (err) {
    logger.error('reviewEligibility: unexpected error', { error: err.message });
    // Fail open
    return true;
  }
}
