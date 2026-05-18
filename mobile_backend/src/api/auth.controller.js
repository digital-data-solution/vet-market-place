import User from '../models/User.js';
import logger from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { verifySupabaseToken } from '../lib/supabase.js';

export const register = async (req, res) => {
  const { name, email, password, role, location, vetDetails, kennelDetails, vcnNumber, cacNumber } = req.body;

  try {
    if (!email || !password || !name) {
      return res.status(400).json({ message: 'Name, email and password are required.' });
    }

    // Check for duplicate in MongoDB
    const existing = await User.findOne({
      $or: [
        { email },
        ...(vcnNumber ? [{ 'vetDetails.vcnNumber': vcnNumber }] : []),
        ...(cacNumber ? [{ 'kennelDetails.cacNumber': cacNumber }] : []),
      ],
    });
    if (existing) {
      return res.status(400).json({ message: 'An account with these details already exists.' });
    }

    // Register in Supabase — sends confirmation email automatically
    const { data: supabaseData, error: supabaseError } = await supabaseAdmin.auth.signUp({
      email,
      password,
      options: {
        data: { name, role: role || 'pet_owner' },
      },
    });

    if (supabaseError) {
      logger.error('Supabase registration error', { error: supabaseError.message });
      return res.status(500).json({ message: supabaseError.message });
    }

    // Create MongoDB user — supabaseId links the two systems
    const user = new User({
      supabaseId: supabaseData.user.id,
      name,
      email,
      password,           // hashed by pre-save hook
      role: role || 'pet_owner',
      location,
      isVerified: false,  // flipped to true after email confirmation
    });

    if (role === 'vet') user.vetDetails = vetDetails;
    if (role === 'kennel_owner') user.kennelDetails = kennelDetails;

    await user.save();

    logger.info('User registered', { userId: user._id, email });
    return res.status(201).json({
      message: 'Registration successful. Please check your email to verify your account.',
    });
  } catch (error) {
    logger.error('Registration error', { error: error.message });
    return res.status(500).json({ message: error.message });
  }
};

export const login = async (req, res) => {
  // Login is handled entirely client-side via Supabase SDK.
  // The JWT from Supabase is passed in the Authorization header on every
  // subsequent request, and protect() middleware validates it.
  // This endpoint is kept only for legacy compatibility — it is not needed.
  return res.status(410).json({
    message: 'Direct login is handled by the Supabase client SDK. Use supabase.auth.signInWithPassword() on the frontend.',
  });
};

export const syncUser = async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token provided.' });

    const supabaseUser = await verifySupabaseToken(token);
    if (!supabaseUser) return res.status(401).json({ message: 'Invalid token.' });

    const supabaseId = supabaseUser.sub;
    const email      = supabaseUser.email;

    if (!supabaseId || !email) {
      return res.status(400).json({ message: 'Token missing required fields.' });
    }

    const user = await User.findOneAndUpdate(
      { supabaseId },
      {
        $setOnInsert: {
          supabaseId,
          email,
          name: supabaseUser.user_metadata?.name || email.split('@')[0],
          role: supabaseUser.user_metadata?.role || 'pet_owner',
          password: 'supabase_managed',
          isVerified: true,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return res.json({ message: 'User synced.', userId: user._id });
  } catch (error) {
    logger.error('Sync error', { error: error.message });
    return res.status(500).json({ message: error.message });
  }
};