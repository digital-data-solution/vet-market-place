// ─────────────────────────────────────────────────────────────────────────────
// businessAuth — dual-mode auth for /api/v1/business/* routes.
//
// Accepts EITHER:
//   • an owner's Supabase token (normal app login) → owner mode, and
//   • a scoped staff token (StaffLoginScreen)      → staff mode.
//
// Sets, in both modes:
//   req.businessOwnerId — the owner User._id that owns the tenant's data
//   req.staffActor      — { id, name, permissions } in staff mode, else null
// so the controller isolates data by owner and attributes/permission-checks by
// actor. Owner mode also sets req.user (like `protect`) for backward compat.
// ─────────────────────────────────────────────────────────────────────────────
import { verifySupabaseToken } from '../lib/supabase.js';
import { verifyStaffToken } from '../lib/staffToken.js';
import User from '../models/User.js';
import StaffMember from '../models/StaffMember.js';

export default async function businessAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Not authorized, no token' });

  try {
    // 1) Try staff token first (cheap local verify, no network).
    const staffClaim = verifyStaffToken(token);
    if (staffClaim) {
      const staff = await StaffMember.findOne({ _id: staffClaim.staffId, owner: staffClaim.ownerId, isActive: true })
        .select('name role permissions owner');
      if (!staff) return res.status(401).json({ success: false, message: 'Your access has been revoked. Please contact the owner.' });
      req.businessOwnerId = String(staff.owner);
      req.staffActor = { id: String(staff._id), name: staff.name, role: staff.role, permissions: staff.permissions?.toObject?.() || staff.permissions || {} };
      // Touch last-active without blocking the request.
      StaffMember.updateOne({ _id: staff._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
      return next();
    }

    // 2) Fall back to an owner Supabase token.
    const supabaseUser = await verifySupabaseToken(token);
    if (!supabaseUser?.id) return res.status(401).json({ success: false, message: 'Not authorized, invalid token' });

    const user = await User.findOne({ supabaseId: supabaseUser.id }).select('-password');
    if (!user) return res.status(401).json({ success: false, message: 'Could not resolve user.' });

    req.user = user;
    req.businessOwnerId = String(user._id);
    req.staffActor = null;
    return next();
  } catch (error) {
    console.error('businessAuth error:', error);
    return res.status(401).json({ success: false, message: 'Not authorized, token failed' });
  }
}
