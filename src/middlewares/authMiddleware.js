import { verifySupabaseToken } from '../lib/supabase.js';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
  let token = req.headers.authorization?.split(' ')[1];

  if (!token) return res.status(401).json({ message: 'Not authorized, no token' });

  try {
    // Verify Supabase JWT token
    const supabaseUser = await verifySupabaseToken(token);
    if (!supabaseUser) {
      return res.status(401).json({ message: 'Not authorized, invalid token' });
    }

    // Find user in our database by phone number
    const user = await User.findOne({ phone: supabaseUser.phone }).select('-password');
    if (!user) {
      return res.status(401).json({ message: 'User not found in database' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

// Role-based Authorization
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: `Role ${req.user.role} is not authorized` });
    }
    next();
  };
};