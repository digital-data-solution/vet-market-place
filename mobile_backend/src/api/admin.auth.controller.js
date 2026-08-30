import User from '../models/User.js';
import AdminStaffAccount from '../models/AdminStaffAccount.js';
import logger from '../lib/logger.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { beginSetup, confirmSetup, disable as disableTwoFactorOn, verifyLoginCode } from '../services/twoFactor.service.js';

const JWT_SECRET  = process.env.JWT_SECRET  || 'your-super-secret-key-change-in-env';
const JWT_EXPIRE  = '24h';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function generateToken(user) {
  return jwt.sign(
    {
      userId:  user._id.toString(),
      email:   user.email,
      role:    user.role,
      isAdmin: user.isAdmin === true,
      name:    user.name,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRE }
  );
}

// Staff token — deliberately shaped differently from the owner token above
// (isStaff:true, staffId instead of userId, no isAdmin). `modules` IS
// embedded here for the dashboard's convenience (render nav without an
// extra round-trip) but adminProtect NEVER trusts it for the actual gating
// decision — every module-gated request re-reads AdminStaffAccount fresh.
function generateStaffToken(staff) {
  return jwt.sign(
    {
      staffId: staff._id.toString(),
      email:   staff.email,
      name:    staff.name,
      role:    staff.role,
      isAdmin: false,
      isStaff: true,
      modules: staff.modules,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRE }
  );
}

// Short-lived, deliberately-unusable-elsewhere token issued after a correct
// password when the account has 2FA enabled — see login() below. `role:
// 'pending_2fa'` is a value adminProtect never recognises as either 'owner'
// or 'staff', so even if this token were used as a Bearer token against any
// other route, it's rejected identically to garbage input. Only good for
// POST /admin/login/2fa, and only for 5 minutes.
function generatePendingToken(tier, id) {
  return jwt.sign({ id, tier, role: 'pending_2fa' }, JWT_SECRET, { expiresIn: '5m' });
}

async function comparePassword(plainPassword, hashedPassword) {
  return bcrypt.compare(plainPassword, hashedPassword);
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ============================================================================
// ADMIN AUTH ENDPOINTS  (mounted at /api/auth/admin/*)
// ============================================================================

/**
 * Register a new admin user
 * POST /api/auth/admin/register
 * Body: { name, email, password }
 */
export const register = async (req, res) => {
  const { name, email, password } = req.body;

  try {
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, and password are required.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long.' });
    }

    // Reached only via adminProtect — an already-authenticated admin is
    // granting admin-dashboard access to a (possibly existing) account.
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      if (existing.isAdmin) {
        return res.status(400).json({ success: false, message: 'This account already has admin access.' });
      }
      existing.isAdmin = true;
      await existing.save();

      logger.info('Existing user granted admin access', { userId: existing._id, email: existing.email });

      return res.status(200).json({
        success: true,
        message: 'Admin access granted to existing account.',
        data: { userId: existing._id, email: existing.email, name: existing.name, isAdmin: true },
      });
    }

    const user = new User({
      name:       name.trim(),
      email:      email.toLowerCase(),
      password,
      isAdmin:    true,
      isVerified: false,
      createdAt:  new Date(),
    });

    await user.save();

    logger.info('Admin user registered', { userId: user._id, email: user.email });

    return res.status(201).json({
      success: true,
      message: 'User registered successfully. Please login.',
      data: {
        userId:  user._id,
        email:   user.email,
        name:    user.name,
        isAdmin: user.isAdmin,
      },
    });
  } catch (error) {
    logger.error('Admin registration error', { error: error.message, stack: error.stack });
    return res.status(500).json({
      success: false,
      message: 'Registration failed. Please try again.',
      error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
};

/**
 * Admin login — issues a JWT
 * POST /api/auth/admin/login
 * Body: { email, password }
 */
export const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    // Owner tier — unchanged behaviour when a matching User with isAdmin
    // exists. Falls through to the staff-account check below only when
    // there's no such owner account, so an email that's simultaneously a
    // (non-admin) User and a staff account still logs in as staff correctly.
    if (user?.isAdmin) {
      const isPasswordValid = await comparePassword(password, user.password);
      if (!isPasswordValid) {
        logger.warn('Admin login failed: invalid password', { userId: user._id });
        return res.status(401).json({ success: false, message: 'Invalid email or password.' });
      }

      if (user.twoFactorEnabled) {
        const pendingToken = generatePendingToken('owner', user._id.toString());
        logger.info('Admin login: password OK, awaiting 2FA code (owner)', { userId: user._id });
        return res.status(200).json({ success: true, requiresTwoFactor: true, data: { pendingToken } });
      }

      const token = generateToken(user);
      res.cookie('adminAuthToken', token, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge:   24 * 60 * 60 * 1000,
        path:     '/',
      });

      logger.info('Admin login successful (owner)', { userId: user._id, email: user.email });

      return res.status(200).json({
        success: true,
        message: 'Login successful.',
        data: {
          token,
          user: {
            id:         user._id,
            email:      user.email,
            name:       user.name,
            role:       user.role,
            isVerified: user.isVerified,
            isOwner:    true,
            modules:    null, // null = every module, dashboard treats this as "all"
          },
        },
      });
    }

    // Staff tier — AdminStaffAccount, module-scoped. See middlewares/
    // adminAuthMiddleware.js for how `modules`/`isActive` are re-checked
    // fresh on every subsequent request rather than trusted from this token.
    const staff = await AdminStaffAccount.findOne({ email: email.toLowerCase() });
    if (!staff) {
      logger.warn('Admin login failed: no matching owner or staff account', { email });
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }
    if (!staff.isActive) {
      logger.warn('Admin login failed: staff account deactivated', { staffId: staff._id });
      return res.status(403).json({ success: false, message: 'This staff account has been deactivated. Contact the site owner.' });
    }

    const staffPasswordValid = await staff.comparePassword(password);
    if (!staffPasswordValid) {
      logger.warn('Admin login failed: invalid staff password', { staffId: staff._id });
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    if (staff.twoFactorEnabled) {
      const pendingToken = generatePendingToken('staff', staff._id.toString());
      logger.info('Admin login: password OK, awaiting 2FA code (staff)', { staffId: staff._id });
      return res.status(200).json({ success: true, requiresTwoFactor: true, data: { pendingToken } });
    }

    staff.lastLoginAt = new Date();
    await staff.save();

    const staffToken = generateStaffToken(staff);
    res.cookie('adminAuthToken', staffToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   24 * 60 * 60 * 1000,
      path:     '/',
    });

    logger.info('Admin login successful (staff)', { staffId: staff._id, email: staff.email });

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      data: {
        token: staffToken,
        user: {
          id:                 staff._id,
          email:              staff.email,
          name:               staff.name,
          role:               staff.role,
          isOwner:            false,
          modules:            staff.modules,
          mustChangePassword: staff.mustChangePassword,
        },
      },
    });
  } catch (error) {
    logger.error('Admin login error', { error: error.message, stack: error.stack });
    return res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.',
      error:   process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
};

/**
 * Step 2 of a 2FA-protected login — POST /api/auth/admin/login
 * returned { requiresTwoFactor: true, pendingToken } instead of a real
 * session; this exchanges that + a 6-digit code (or an 8-char backup code)
 * for the real thing.
 * POST /api/auth/admin/login/2fa
 * Body: { pendingToken, code }
 */
export const loginTwoFactor = async (req, res) => {
  const { pendingToken, code } = req.body;

  try {
    if (!pendingToken || !code) {
      return res.status(400).json({ success: false, message: 'pendingToken and code are required.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(pendingToken, JWT_SECRET);
    } catch {
      decoded = null;
    }
    if (!decoded || decoded.role !== 'pending_2fa') {
      return res.status(401).json({ success: false, message: 'Your login session expired — please log in again.' });
    }

    if (decoded.tier === 'owner') {
      const user = await User.findById(decoded.id).select('+twoFactorSecret +twoFactorBackupCodes');
      if (!user || !user.isAdmin) {
        return res.status(401).json({ success: false, message: 'Your login session expired — please log in again.' });
      }
      const codeValid = await verifyLoginCode(user, code);
      if (!codeValid) {
        logger.warn('Admin 2FA login failed: incorrect code', { userId: user._id });
        return res.status(401).json({ success: false, message: 'Incorrect code.' });
      }

      const token = generateToken(user);
      res.cookie('adminAuthToken', token, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge:   24 * 60 * 60 * 1000,
        path:     '/',
      });

      logger.info('Admin login successful (owner, 2FA)', { userId: user._id, email: user.email });

      return res.status(200).json({
        success: true,
        message: 'Login successful.',
        data: {
          token,
          user: {
            id: user._id, email: user.email, name: user.name, role: user.role,
            isVerified: user.isVerified, isOwner: true, modules: null,
          },
        },
      });
    }

    if (decoded.tier === 'staff') {
      const staff = await AdminStaffAccount.findById(decoded.id).select('+twoFactorSecret +twoFactorBackupCodes');
      if (!staff || !staff.isActive) {
        return res.status(401).json({ success: false, message: 'Your login session expired — please log in again.' });
      }
      const codeValid = await verifyLoginCode(staff, code);
      if (!codeValid) {
        logger.warn('Admin 2FA login failed: incorrect code', { staffId: staff._id });
        return res.status(401).json({ success: false, message: 'Incorrect code.' });
      }

      staff.lastLoginAt = new Date();
      await staff.save();

      const staffToken = generateStaffToken(staff);
      res.cookie('adminAuthToken', staffToken, {
        httpOnly: true,
        secure:   process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge:   24 * 60 * 60 * 1000,
        path:     '/',
      });

      logger.info('Admin login successful (staff, 2FA)', { staffId: staff._id, email: staff.email });

      return res.status(200).json({
        success: true,
        message: 'Login successful.',
        data: {
          token: staffToken,
          user: {
            id: staff._id, email: staff.email, name: staff.name, role: staff.role,
            isOwner: false, modules: staff.modules, mustChangePassword: staff.mustChangePassword,
          },
        },
      });
    }

    return res.status(401).json({ success: false, message: 'Your login session expired — please log in again.' });
  } catch (error) {
    logger.error('2FA login error', { error: error.message, stack: error.stack });
    return res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
};

/**
 * Admin logout — clears cookie
 * POST /api/auth/admin/logout
 */
export const logout = async (req, res) => {
  try {
    res.clearCookie('adminAuthToken', { path: '/' });
    logger.info('Admin logout', { userId: req.user?._id });
    return res.status(200).json({ success: true, message: 'Logout successful.' });
  } catch (error) {
    logger.error('Admin logout error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Logout failed.' });
  }
};

/**
 * Verify token
 * POST /api/auth/admin/verify
 * Header: Authorization: Bearer <token>
 */
export const verifyTokenEndpoint = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'No token provided.' });

    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ success: false, message: 'Invalid or expired token.' });

    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ success: false, message: 'User not found.' });

    return res.status(200).json({
      success: true,
      message: 'Token is valid.',
      data: {
        userId:    user._id,
        email:     user.email,
        role:      user.role,
        expiresAt: new Date(decoded.exp * 1000),
      },
    });
  } catch (error) {
    logger.error('Token verification error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Token verification failed.' });
  }
};

/**
 * Refresh token
 * POST /api/auth/admin/refresh
 * Header: Authorization: Bearer <token>
 */
export const refreshToken = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'No token provided.' });

    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ success: false, message: 'Invalid or expired token.' });

    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ success: false, message: 'User not found.' });

    const newToken = generateToken(user);

    res.cookie('adminAuthToken', newToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   24 * 60 * 60 * 1000,
      path:     '/',
    });

    logger.info('Admin token refreshed', { userId: user._id });

    return res.status(200).json({ success: true, message: 'Token refreshed.', data: { token: newToken } });
  } catch (error) {
    logger.error('Token refresh error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Token refresh failed.' });
  }
};

/**
 * Get current admin profile
 * GET /api/auth/admin/me
 */
export const getCurrentUser = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'No token provided.' });

    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ success: false, message: 'Invalid or expired token.' });

    if (decoded.isStaff && decoded.staffId) {
      const staff = await AdminStaffAccount.findById(decoded.staffId).select('-password');
      if (!staff || !staff.isActive) return res.status(401).json({ success: false, message: 'Staff account not found or deactivated.' });
      return res.status(200).json({
        success: true,
        data: {
          id: staff._id, email: staff.email, name: staff.name, role: staff.role,
          isOwner: false, modules: staff.modules, mustChangePassword: staff.mustChangePassword,
          twoFactorEnabled: staff.twoFactorEnabled,
          createdAt: staff.createdAt,
        },
      });
    }

    const user = await User.findById(decoded.userId).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    return res.status(200).json({
      success: true,
      data: {
        id:         user._id,
        email:      user.email,
        name:       user.name,
        role:       user.role,
        isVerified: user.isVerified,
        isOwner:    true,
        modules:    null,
        twoFactorEnabled: user.twoFactorEnabled,
        createdAt:  user.createdAt,
      },
    });
  } catch (error) {
    logger.error('Get current admin error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch user profile.' });
  }
};

/**
 * Change password (admin only)
 * POST /api/auth/admin/change-password
 * Body: { currentPassword, newPassword }
 */
export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  try {
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current and new passwords are required.' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });
    }

    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'No token provided.' });

    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ success: false, message: 'Invalid or expired token.' });

    if (decoded.isStaff && decoded.staffId) {
      const staff = await AdminStaffAccount.findById(decoded.staffId);
      if (!staff) return res.status(404).json({ success: false, message: 'Staff account not found.' });

      const staffCurrentValid = await staff.comparePassword(currentPassword);
      if (!staffCurrentValid) {
        logger.warn('Staff password change failed: invalid current password', { staffId: staff._id });
        return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
      }

      staff.password = newPassword;
      staff.mustChangePassword = false;
      await staff.save();

      logger.info('Staff password changed successfully', { staffId: staff._id });
      return res.status(200).json({ success: true, message: 'Password changed successfully.' });
    }

    const user = await User.findById(decoded.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const isCurrentPasswordValid = await comparePassword(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      logger.warn('Password change failed: invalid current password', { userId: user._id });
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    user.password = newPassword;
    await user.save();

    logger.info('Admin password changed successfully', { userId: user._id });
    return res.status(200).json({ success: true, message: 'Password changed successfully.' });
  } catch (error) {
    logger.error('Change password error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to change password.' });
  }
};

// ============================================================================
// TWO-FACTOR AUTHENTICATION — self-service setup/confirm/disable, always
// behind adminProtect (so req.user/req.adminIsOwner already identify who's
// asking — see middlewares/adminAuthMiddleware.js). All three routes
// re-fetch the account fresh with the secret fields explicitly selected,
// rather than reusing whatever adminProtect attached to req, since that
// projection deliberately doesn't include the 2FA secret fields.
// ============================================================================

async function loadSelfAccount(req, selectExtra) {
  if (req.adminIsOwner) {
    return User.findById(req.user.userId).select(selectExtra);
  }
  return AdminStaffAccount.findById(req.user.staffId).select(selectExtra);
}

/**
 * POST /api/auth/admin/2fa/setup
 * Generates a new secret, stores it PENDING (not active), returns a QR code
 * + manual-entry key. Nothing changes about the account's real login
 * behaviour until /2fa/confirm below verifies it actually works.
 */
export const setupTwoFactor = async (req, res) => {
  try {
    const account = await loadSelfAccount(req, '+twoFactorPendingSecret');
    if (!account) return res.status(404).json({ success: false, message: 'Account not found.' });

    const { qrDataUrl, manualKey } = await beginSetup(account, account.email);
    return res.status(200).json({ success: true, data: { qrDataUrl, manualKey } });
  } catch (error) {
    logger.error('2FA setup error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to start 2FA setup.' });
  }
};

/**
 * POST /api/auth/admin/2fa/confirm
 * Body: { code }
 * Verifies the just-scanned authenticator app actually works before
 * enabling 2FA for real. Returns 8 one-time backup codes exactly once —
 * they are never retrievable again after this response.
 */
export const confirmTwoFactor = async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Code is required.' });

    const account = await loadSelfAccount(req, '+twoFactorSecret +twoFactorPendingSecret +twoFactorBackupCodes');
    if (!account) return res.status(404).json({ success: false, message: 'Account not found.' });

    const result = await confirmSetup(account, code);
    if (!result.ok) return res.status(400).json({ success: false, message: result.message });

    logger.info('2FA enabled', { isOwner: req.adminIsOwner, id: account._id.toString() });
    return res.status(200).json({
      success: true,
      message: 'Two-factor authentication is now enabled.',
      data: { backupCodes: result.backupCodes },
    });
  } catch (error) {
    logger.error('2FA confirm error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to confirm 2FA.' });
  }
};

/**
 * POST /api/auth/admin/2fa/disable
 * Body: { password }
 * Requires the CURRENT password, not just an authenticated session — a
 * stolen session token alone should never be enough to turn 2FA back off.
 */
export const disableTwoFactor = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ success: false, message: 'Current password is required.' });

    if (req.adminIsOwner) {
      const user = await User.findById(req.user.userId);
      if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });
      const valid = await comparePassword(password, user.password);
      if (!valid) return res.status(401).json({ success: false, message: 'Incorrect password.' });
      await disableTwoFactorOn(user);
    } else {
      const staff = await AdminStaffAccount.findById(req.user.staffId);
      if (!staff) return res.status(404).json({ success: false, message: 'Account not found.' });
      const valid = await staff.comparePassword(password);
      if (!valid) return res.status(401).json({ success: false, message: 'Incorrect password.' });
      await disableTwoFactorOn(staff);
    }

    logger.info('2FA disabled', { isOwner: req.adminIsOwner, id: req.adminIsOwner ? req.user.userId : req.user.staffId });
    return res.status(200).json({ success: true, message: 'Two-factor authentication disabled.' });
  } catch (error) {
    logger.error('2FA disable error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to disable 2FA.' });
  }
};