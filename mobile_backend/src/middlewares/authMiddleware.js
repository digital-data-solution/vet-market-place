import { verifySupabaseToken } from '../lib/supabase.js';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) return res.status(401).json({ message: 'Not authorized, no token' });

  try {
    const supabaseUser = await verifySupabaseToken(token);
    if (!supabaseUser) {
      return res.status(401).json({ message: 'Not authorized, invalid token' });
    }

    const supabaseId = supabaseUser.id;     // ← FIXED: was .sub (undefined on User object)
    const email      = supabaseUser.email;

    if (!supabaseId || !email) {
      return res.status(401).json({ message: 'Token missing required fields' });
    }

    const user = await User.findOneAndUpdate(
      { supabaseId },
      {
        $setOnInsert: {
          supabaseId,
          email,
          role:      supabaseUser.user_metadata?.role || 'pet_owner',
          name:      supabaseUser.user_metadata?.name || email.split('@')[0],
          password:  'supabase_managed',
          createdAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).select('-password');

    if (!user) {
      return res.status(401).json({ message: 'Could not resolve user.' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: `Role ${req.user.role} is not authorized` });
    }
    next();
  };
};