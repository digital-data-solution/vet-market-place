import User from '../models/User.js';
import jwt from 'jsonwebtoken';
import { sendSMSOTP } from '../services/onesignal.service.js';
import { redisClient } from '../lib/redis.js';

// OTP config
const OTP_TTL = parseInt(process.env.OTP_TTL_SECONDS || '300', 10); // default 5 minutes
// Fallback in-memory OTP store if Redis unavailable
const otpStore = new Map();

export const register = async (req, res) => {
  const { name, email, password, phone, role, location } = req.body;

  try {
    // Check if user exists
    const existingUser = await User.findOne({ $or: [{ email }, { 'vetDetails.vcnNumber': req.body.vcnNumber }, { 'kennelDetails.cacNumber': req.body.cacNumber }] });
    if (existingUser) return res.status(400).json({ message: 'User already exists' });

    // Create user (password hashed by pre-save hook)
    const user = new User({ name, email, password, phone, role, location });
    if (role === 'vet') user.vetDetails = req.body.vetDetails;
    if (role === 'kennel_owner') user.kennelDetails = req.body.kennelDetails;

    await user.save();

    // Generate server-side OTP and store in Redis with TTL
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpResult = await sendSMSOTP(phone, otpCode);
    if (!otpResult.success) return res.status(500).json({ message: 'Failed to send OTP' });

    // store OTP in Redis: key otp:<phone> -> JSON { otp, userId }
    try {
      await redisClient.setEx(`otp:${phone}`, OTP_TTL, JSON.stringify({ otp: otpCode, userId: user._id.toString() }));
    } catch (err) {
      // Fallback to in-memory only if Redis not available
      console.warn('Redis setEx failed, falling back to in-memory OTP store');
      otpStore.set(phone, { otp: otpCode, userId: user._id.toString(), expiresAt: Date.now() + OTP_TTL * 1000 });
    }

    res.status(201).json({ message: 'User registered. Verify OTP.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const verifyOTP = async (req, res) => {
  const { phone, otp } = req.body;

  try {
    // Try Redis first
    let storedRaw;
    try {
      storedRaw = await redisClient.get(`otp:${phone}`);
    } catch (err) {
      storedRaw = null;
    }

    let stored = null;
    if (storedRaw) {
      stored = JSON.parse(storedRaw);
    } else if (otpStore.has(phone)) {
      const s = otpStore.get(phone);
      if (s.expiresAt && s.expiresAt > Date.now()) stored = s;
    }

    if (!stored || stored.otp !== otp) return res.status(400).json({ message: 'Invalid or expired OTP' });

    // Mark user as phone-verified
    await User.findByIdAndUpdate(stored.userId, { isVerified: true });

    // cleanup
    try { await redisClient.del(`otp:${phone}`); } catch (e) { /* ignore */ }
    if (otpStore.has(phone)) otpStore.delete(phone);

    res.json({ message: 'OTP verified. Registration complete.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) return res.status(401).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { id: user._id, name: user.name, role: user.role, isVerified: user.isVerified } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Add comparePassword method to User model
// In User.js, add: userSchema.methods.comparePassword = async function (password) { return await bcrypt.compare(password, this.password); };