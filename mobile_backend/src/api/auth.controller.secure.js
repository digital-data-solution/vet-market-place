import User from '../models/User.js';
import logger from '../lib/logger.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-env';
const JWT_EXPIRE = '24h';
const BCRYPT_ROUNDS = 10;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate JWT token
 */
function generateToken(user) {
  return jwt.sign(
    {
      userId: user._id.toString(),
      email: user.email,
      role: user.role,
      name: user.name,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRE }
  );
}

/**
 * Hash password using bcrypt
 */
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Compare plain password with hashed password
 */
async function comparePassword(plainPassword, hashedPassword) {
  return bcrypt.compare(plainPassword, hashedPassword);
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

/**
 * Register a new user (admin only)
 * POST /api/auth/register
 * Body: { name, email, password, role? }
 */
export const register = async (req, res) => {
  const { name, email, password, role } = req.body;

  try {
    // ✅ Validation
    if (!name || !email || !password) {
      logger.warn('Registration failed: missing fields', { email });
      return res.status(400).json({
        success: false,
        message: 'Name, email, and password are required.',
      });
    }

    // ✅ Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format.',
      });
    }

    // ✅ Password strength validation
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters long.',
      });
    }

    // ✅ Check if user already exists
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      logger.warn('Registration failed: user already exists', { email });
      return res.status(400).json({
        success: false,
        message: 'An account with this email already exists.',
      });
    }

    // ✅ Hash password
    const hashedPassword = await hashPassword(password);

    // ✅ Create new user
    const user = new User({
      name: name.trim(),
      email: email.toLowerCase(),
      password: hashedPassword,
      role: role === 'admin' ? 'admin' : 'pet_owner',
      isVerified: false,
      createdAt: new Date(),
    });

    await user.save();

    logger.info('User registered successfully', {
      userId: user._id,
      email: user.email,
      role: user.role,
    });

    return res.status(201).json({
      success: true,
      message: 'User registered successfully. Please login.',
      data: {
        userId: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    logger.error('Registration error', { error: error.message, stack: error.stack });
    return res.status(500).json({
      success: false,
      message: 'Registration failed. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
};

/**
 * Login user with email and password
 * POST /api/auth/login
 * Body: { email, password }
 */
export const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    // ✅ Validation
    if (!email || !password) {
      logger.warn('Login failed: missing credentials');
      return res.status(400).json({
        success: false,
        message: 'Email and password are required.',
      });
    }

    // ✅ Find user by email
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      // Don't reveal if email exists (security best practice)
      logger.warn('Login failed: user not found', { email: email.toLowerCase() });
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    // ✅ Verify password
    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
      logger.warn('Login failed: invalid password', { userId: user._id });
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    // ✅ Generate JWT token
    const token = generateToken(user);

    // ✅ Set secure httpOnly cookie
    res.cookie('authToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      path: '/',
    });

    logger.info('User login successful', {
      userId: user._id,
      email: user.email,
      role: user.role,
    });

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      data: {
        token,
        user: {
          id: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          isVerified: user.isVerified,
        },
      },
    });
  } catch (error) {
    logger.error('Login error', { error: error.message, stack: error.stack });
    return res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
};

/**
 * Logout user (clear cookies)
 * POST /api/auth/logout
 */
export const logout = async (req, res) => {
  try {
    res.clearCookie('authToken', { path: '/' });

    logger.info('User logout', { userId: req.user?._id });

    return res.status(200).json({
      success: true,
      message: 'Logout successful.',
    });
  } catch (error) {
    logger.error('Logout error', { error: error.message });
    return res.status(500).json({
      success: false,
      message: 'Logout failed.',
    });
  }
};

/**
 * Verify JWT token (for token validation)
 * POST /api/auth/verify
 * Header: Authorization: Bearer <token>
 */
export const verifyTokenEndpoint = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided.',
      });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token.',
      });
    }

    // ✅ Verify user still exists
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Token is valid.',
      data: {
        userId: user._id,
        email: user.email,
        role: user.role,
        expiresAt: new Date(decoded.exp * 1000),
      },
    });
  } catch (error) {
    logger.error('Token verification error', { error: error.message });
    return res.status(500).json({
      success: false,
      message: 'Token verification failed.',
    });
  }
};

/**
 * Refresh JWT token
 * POST /api/auth/refresh
 * Header: Authorization: Bearer <token>
 */
export const refreshToken = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided.',
      });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token.',
      });
    }

    // ✅ Get fresh user data
    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found.',
      });
    }

    // ✅ Generate new token
    const newToken = generateToken(user);

    res.cookie('authToken', newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/',
    });

    logger.info('Token refreshed', { userId: user._id });

    return res.status(200).json({
      success: true,
      message: 'Token refreshed.',
      data: {
        token: newToken,
      },
    });
  } catch (error) {
    logger.error('Token refresh error', { error: error.message });
    return res.status(500).json({
      success: false,
      message: 'Token refresh failed.',
    });
  }
};

/**
 * Get current authenticated user profile
 * GET /api/auth/me
 * Requires: Authorization header with valid token
 */
export const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        isVerified: user.isVerified,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    logger.error('Get current user error', { error: error.message });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch user profile.',
    });
  }
};

/**
 * Change password (authenticated users only)
 * POST /api/auth/change-password
 * Body: { currentPassword, newPassword }
 * Requires: Authorization header
 */
export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  try {
    // ✅ Validation
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required.',
      });
    }

    // ✅ Validate new password strength
    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 8 characters long.',
      });
    }

    // ✅ Get user with password
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    // ✅ Verify current password
    const isCurrentPasswordValid = await comparePassword(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      logger.warn('Password change failed: invalid current password', { userId: user._id });
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect.',
      });
    }

    // ✅ Hash and save new password
    user.password = await hashPassword(newPassword);
    await user.save();

    logger.info('Password changed successfully', { userId: user._id });

    return res.status(200).json({
      success: true,
      message: 'Password changed successfully.',
    });
  } catch (error) {
    logger.error('Change password error', { error: error.message });
    return res.status(500).json({
      success: false,
      message: 'Failed to change password.',
    });
  }
};

/**
 * Sync user with Supabase (existing function, kept for compatibility)
 */
export const syncUser = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'No token provided.' });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ message: 'Invalid token.' });
    }

    const user = await User.findById(decoded.userId).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    logger.error('Sync user error', { error: error.message });
    return res.status(500).json({
      success: false,
      message: 'Sync failed.',
    });
  }
};