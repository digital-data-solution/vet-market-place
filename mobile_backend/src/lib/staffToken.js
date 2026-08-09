// ─────────────────────────────────────────────────────────────────────────────
// STAFF TOKEN — scoped bearer token for a staff member logging in on their own
// phone (StaffLoginScreen). Not a Supabase account; signed by us with
// jsonwebtoken. Carries staffId + ownerId + type so businessAuth can resolve
// which owner's tenant the staff acts within and who is acting.
// ─────────────────────────────────────────────────────────────────────────────
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET
  || process.env.SUPABASE_JWT_SECRET
  || process.env.PAYSTACK_SECRET_KEY // last-resort: any stable server secret
  || 'xpressvet-staff-fallback-secret';

const TTL = '30d';

export function signStaffToken({ staffId, ownerId }) {
  return jwt.sign({ staffId: String(staffId), ownerId: String(ownerId), type: 'staff' }, SECRET, { expiresIn: TTL });
}

export function verifyStaffToken(token) {
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload?.type !== 'staff' || !payload.staffId || !payload.ownerId) return null;
    return { staffId: payload.staffId, ownerId: payload.ownerId };
  } catch {
    return null;
  }
}
