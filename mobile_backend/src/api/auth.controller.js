import User from '../models/User.js';
import logger from '../lib/logger.js';
import { supabaseAdmin, verifySupabaseToken } from '../lib/supabase.js';
import { sendWelcomeEmail } from '../services/email.service.js';
import { logActivity } from '../lib/activityLogger.js';
import { applyReferralReward } from '../lib/referralHelper.js';

export const register = async (req, res) => {
  const { name, email, password, role, location, vetDetails, kennelDetails, vcnNumber, cacNumber, referralCode,
          utmSource, utmCampaign, utmMedium } = req.body;

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

    if (referralCode) {
      const referrer = await User.findOne({ referralCode: referralCode.trim().toUpperCase() }).select('_id').lean();
      if (referrer) user.referredBy = referralCode.trim().toUpperCase();
    }

    if (utmSource || utmCampaign || utmMedium) {
      user.utm = {
        source:   utmSource   || null,
        campaign: utmCampaign || null,
        medium:   utmMedium   || null,
      };
    }

    await user.save();

    // Fire-and-forget — never block the response on email delivery
    sendWelcomeEmail(name, email).catch(() => {});
    logActivity(user._id, user.role, 'user.register', {
      email,
      role:       user.role,
      referredBy: user.referredBy || null,
    }, req);

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

    // FIX: supabaseUser.email_confirmed_at (from auth.getUser(token)) can be stale —
    // when email confirmation and the resulting auto sign-in happen in the same instant,
    // the token used for this sync call doesn't reliably carry the just-committed
    // confirmation. auth.admin.getUserById() always reflects live DB state, so use that
    // as the source of truth instead of trusting the token-decoded user object.
    let isVerified = !!supabaseUser.email_confirmed_at;
    if (!isVerified) {
      try {
        const { data: freshData } = await supabaseAdmin.auth.admin.getUserById(supabaseId);
        if (freshData?.user?.email_confirmed_at) isVerified = true;
      } catch (e) {
        logger.warn('Fresh verification re-check failed during sync', { supabaseId, error: e.message });
      }
    }

    // Validate referral code if provided — only applied on first sync (new users)
    const { referralCode, utmSource, utmCampaign, utmMedium } = req.body;
    let referredBy = null;
    if (referralCode) {
      const referrer = await User.findOne({ referralCode: referralCode.trim().toUpperCase() }).select('_id').lean();
      if (referrer) referredBy = referralCode.trim().toUpperCase();
    }

    // Pre-generate a referral code for new users ($setOnInsert won't run for existing ones)
    const newCode = Array.from({ length: 6 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');

    const user = await User.findOneAndUpdate(
      { supabaseId },
      {
        $setOnInsert: {
          supabaseId,
          email,
          name:         supabaseUser.user_metadata?.name || email.split('@')[0],
          role:         supabaseUser.user_metadata?.role || 'pet_owner',
          password:     'supabase_managed',
          referralCode: newCode,
          ...(referredBy && { referredBy }),
          ...((utmSource || utmCampaign || utmMedium) && {
            utm: { source: utmSource || null, campaign: utmCampaign || null, medium: utmMedium || null },
          }),
        },
        $set: { isVerified, lastLoginAt: new Date() },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );

    logActivity(user._id, user.role, 'user.login', {
      email,
      isVerified,
    }, req);

    // Apply referral reward for pet owners who just verified their email.
    // Professional roles (vet, kennel_owner, etc.) receive their reward when
    // the admin approves their professional listing, so we skip them here to
    // avoid double-rewarding if they were referred before changing role.
    if (
      user.isVerified &&
      user.referredBy &&
      !user.referralRewardApplied &&
      user.role === 'pet_owner'
    ) {
      applyReferralReward(user, 7).catch(() => {});
    }

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

export const getReferralInfo = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    let user = await User.findById(userId).select('referralCode referralRewardsEarned').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    // Existing users registered before the referral feature was added won't have a code.
    // Generate one on-demand using the same logic as the User pre-save hook.
    if (!user.referralCode) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let code;
      let exists = true;
      while (exists) {
        code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        exists = await User.exists({ referralCode: code });
      }
      await User.findByIdAndUpdate(userId, { $set: { referralCode: code } });
      user = { ...user, referralCode: code };
    }

    const referralLink = `https://xpressvetmarketplace.com/auth/register?ref=${user.referralCode}`;
    return res.json({
      success: true,
      data: {
        referralCode:          user.referralCode,
        referralLink,
        shareMessage:          `Join me on Xpress Vet — Nigeria's #1 pet care marketplace! 🐾\n\nUse my referral code ${user.referralCode} when you sign up and we both get rewarded.\n\n👉 Sign up here: ${referralLink}`,
        referralRewardsEarned: user.referralRewardsEarned ?? 0,
      },
    });
  } catch (error) {
    logger.error('Get referral info error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch referral info.' });
  }
};

export const getPublicProfile = async (req, res) => {
  try {
    const { supabaseId } = req.params;
    const user = await User.findOne({ supabaseId }).select('name profileImage').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    return res.json({
      success: true,
      data: { name: user.name, profileImage: user.profileImage ?? null },
    });
  } catch (error) {
    logger.error('Get public profile error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to fetch profile.' });
  }
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