import User from '../models/User.js';
import logger from '../lib/logger.js';
import { supabaseAdmin, verifySupabaseToken } from '../lib/supabase.js';
import { sendWelcomeEmail } from '../services/email.service.js';

export const register = async (req, res) => {
  const { name, email, password, role, location, vetDetails, kennelDetails, vcnNumber, cacNumber } = req.body;

  try {
    if (!email || !password || !name) {
      return res.status(400).json({ message: 'Name, email and password are required.' });
    }

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

    const user = new User({
      supabaseId: supabaseData.user.id,
      name,
      email,
      password,
      role: role || 'pet_owner',
      location,
      isVerified: false,
    });

    if (role === 'vet')          user.vetDetails    = vetDetails;
    if (role === 'kennel_owner') user.kennelDetails = kennelDetails;

    await user.save();

    // Fire-and-forget — never block the response on email delivery
    sendWelcomeEmail(name, email).catch(() => {});

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

    const supabaseId = supabaseUser.id;     // ← FIXED: was .sub
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
          name:       supabaseUser.user_metadata?.name || email.split('@')[0],
          role:       supabaseUser.user_metadata?.role || 'pet_owner',
          password:   'supabase_managed',
          isVerified: true,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );

    return res.json({ message: 'User synced.', userId: user._id });
  } catch (error) {
    logger.error('Sync error', { error: error.message });
    return res.status(500).json({ message: error.message });
  }
};

// GET /api/auth/me — returns the authenticated user loaded by protect middleware
export const getMe = async (req, res) => {
  return res.json({ user: req.user });
};

export const updateProfile = async (req, res) => {
  try {
    const { profileImage, profileImagePath } = req.body;

    if (profileImage === undefined && profileImagePath === undefined) {
      return res.status(400).json({ message: 'No profile data provided.' });
    }

    const updatePayload = {};
    if (profileImage !== undefined) updatePayload.profileImage = profileImage;
    if (profileImagePath !== undefined) updatePayload.profileImagePath = profileImagePath;

    const updatedUser = await User.findOneAndUpdate(
      { _id: req.user._id },
      { $set: updatePayload },
      { returnDocument: 'after' },
    ).select('-password');

    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.json({ message: 'Profile updated successfully.', user: updatedUser });
  } catch (error) {
    logger.error('Update profile error', { error: error.message });
    return res.status(500).json({ message: error.message });
  }
};