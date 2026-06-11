import User from '../models/User.js';
import logger from '../lib/logger.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const JWT_SECRET  = process.env.JWT_SECRET  || 'your-super-secret-key-change-in-env';
const JWT_EXPIRE  = '24h';
const BCRYPT_ROUNDS = 10;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function generateToken(user) {
  return jwt.sign(
    {
      userId: user._id.toString(),
      email:  user.email,
      role:   user.role,
      name:   user.name,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRE }
  );
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
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
  const { name, email, password, role } = req.body;

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

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      logger.warn('Admin registration failed: user already exists', { email });
      return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    }

    const hashedPassword = await hashPassword(password);

    const user = new User({
      name:       name.trim(),
      email:      email.toLowerCase(),
      password:   hashedPassword,
      role:       role === 'admin' ? 'admin' : 'pet_owner',
      isVerified: false,
      createdAt:  new Date(),
    });

    await user.save();

    logger.info('Admin user registered', { userId: user._id, email: user.email, role: user.role });

    return res.status(201).json({
      success: true,
      message: 'User registered successfully. Please login.',
      data: {
        userId: user._id,
        email:  user.email,
        name:   user.name,
        role:   user.role,
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
    if (!user) {
      logger.warn('Admin login failed: user not found', { email });
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    // ✅ Admin-only gate
    if (user.role !== 'admin') {
      logger.warn('Admin login failed: insufficient role', { userId: user._id, role: user.role });
      return res.status(403).json({ success: false, message: 'Admin access required.' });
    }

    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
      logger.warn('Admin login failed: invalid password', { userId: user._id });
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const token = generateToken(user);

    res.cookie('adminAuthToken', token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   24 * 60 * 60 * 1000,
      path:     '/',
    });

    logger.info('Admin login successful', { userId: user._id, email: user.email });

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

    const user = await User.findById(decoded.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const isCurrentPasswordValid = await comparePassword(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      logger.warn('Password change failed: invalid current password', { userId: user._id });
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    user.password = await hashPassword(newPassword);
    await user.save();

    logger.info('Admin password changed successfully', { userId: user._id });
    return res.status(200).json({ success: true, message: 'Password changed successfully.' });
  } catch (error) {
    logger.error('Change password error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to change password.' });
  }
};