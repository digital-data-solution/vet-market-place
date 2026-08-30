import jwt from 'jsonwebtoken';
import AdminStaffAccount from '../models/AdminStaffAccount.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-env';

/**
 * adminProtect — authenticates EITHER tier of admin-dashboard access:
 *   - Owner:  a User with isAdmin:true (unchanged, pre-existing behaviour).
 *             Always full access — no module ever blocks an owner.
 *   - Staff:  an AdminStaffAccount (new). Scoped to whatever `modules` the
 *             owner granted — see requireModule/requireModuleRead below.
 *
 * Sets req.user = decoded JWT payload (unchanged shape/name, so every
 * existing `req.user?.email` etc. across the codebase keeps working) plus
 * req.adminIsOwner (bool) and, for staff, req.staffAccount — the FRESH
 * document re-read from Mongo on every single request. The JWT's own
 * `modules`/`isActive` claims are convenience only (so the dashboard can
 * render nav without an extra round-trip) and are never trusted for the
 * actual access decision here — a staff account the owner just deactivated,
 * or just had a module pulled from, is blocked on its very next request,
 * not just at its next login.
 */
export const adminProtect = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ success: false, message: 'No token provided.' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded) {
      return res.status(401).json({ success: false, message: 'Invalid token.' });
    }

    if (decoded.isAdmin) {
      req.user = decoded;
      req.adminIsOwner = true;
      return next();
    }

    if (decoded.isStaff && decoded.staffId) {
      const staff = await AdminStaffAccount.findById(decoded.staffId).select('isActive modules name email role mustChangePassword');
      if (!staff || !staff.isActive) {
        return res.status(403).json({ success: false, message: 'This staff account has been deactivated. Contact the site owner.' });
      }
      // Blocks every module-gated route until the temp password is changed —
      // does NOT block /admin/me or /admin/change-password, since neither of
      // those two bootstrap endpoints goes through this middleware (both
      // verify the token themselves in admin.auth.controller.js), so the
      // dashboard can still show "you must change your password" and let
      // them actually do it.
      if (staff.mustChangePassword) {
        return res.status(403).json({ success: false, requiresPasswordChange: true, message: 'You must set a new password before continuing.' });
      }
      req.user = decoded;
      req.adminIsOwner = false;
      req.staffAccount = staff; // fresh from DB — .modules is the source of truth downstream
      return next();
    }

    return res.status(403).json({ success: false, message: 'Admin access required.' });
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
};

/**
 * requireOwner — for the handful of things staff must NEVER be able to do
 * regardless of any module grant: managing staff accounts themselves (a
 * staff account granting itself, or another staff account, more access
 * would defeat the whole point of scoping). Mount AFTER adminProtect.
 */
export const requireOwner = (req, res, next) => {
  if (!req.adminIsOwner) {
    return res.status(403).json({ success: false, message: 'Only the site owner can do this.' });
  }
  next();
};

/**
 * requireModule(key) / requireModuleRead(key) — module-scoped gates, mount
 * AFTER adminProtect on every admin route. An owner always passes. Staff
 * needs `key` in their (freshly re-read) modules array.
 *
 * Kept as two separate functions, applied per-verb (Read on GET, the plain
 * one on POST/PUT/PATCH/DELETE) even though they currently behave
 * identically — there is no read-only "viewer" tier on this codebase yet,
 * but keeping the split now means adding one later is a one-function change
 * instead of re-touching every route. (This mirrors a real lesson from the
 * CRM/HR admin's own module system: using the write-level gate on a GET/
 * analytics route by habit silently blocks read-only access that should be
 * allowed — split reads vs writes from day one.)
 */
export const requireModule = (key) => (req, res, next) => {
  if (req.adminIsOwner) return next();
  if (req.staffAccount?.modules?.includes(key)) return next();
  return res.status(403).json({ success: false, message: 'Your staff account does not have access to this section.' });
};

export const requireModuleRead = (key) => requireModule(key);

/**
 * requireAnyModule(...keys) — for the handful of endpoints genuinely shared
 * across several composer modules. Concretely: GET /api/admin/users (the
 * search-a-person picker) backs the Users tab AND the "send to a specific
 * person" picker in Push Notifications / Email Campaigns / Blog — a staff
 * account with only, say, the blog module still needs to find a person to
 * send a post to, without also being granted the full Users module. Passes
 * if the staff account holds ANY one of the listed modules.
 */
export const requireAnyModule = (...keys) => (req, res, next) => {
  if (req.adminIsOwner) return next();
  if (keys.some((k) => req.staffAccount?.modules?.includes(k))) return next();
  return res.status(403).json({ success: false, message: 'Your staff account does not have access to this section.' });
};
