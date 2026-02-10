import User from '../models/User.js';
import jwt from 'jsonwebtoken';
// import { sendSMSOTP } from '../services/onesignal.service.js';
// import { redisClient } from '../lib/redis.js';
import { supabaseAdmin } from '../lib/supabase.js';

// OTP logic now handled by Supabase

export const register = async (req, res) => {
  const { name, email, password, phone, role, location } = req.body;

  try {
    // Check if user exists in backend
    const existingUser = await User.findOne({ $or: [{ email }, { 'vetDetails.vcnNumber': req.body.vcnNumber }, { 'kennelDetails.cacNumber': req.body.cacNumber }] });
    if (existingUser) return res.status(400).json({ message: 'User already exists' });

    // Register user in Supabase Auth (triggers OTP if phone provided)
    let supabaseRes;
    if (email || phone) {
      supabaseRes = await supabaseAdmin.auth.signUp({
        email: email || undefined,
        phone: phone || undefined,
        password
      });
    }
    if (supabaseRes?.error) {
      return res.status(500).json({ message: 'Supabase error: ' + supabaseRes.error.message });
    }

    // Create user in backend DB (password hashed by pre-save hook)
    const user = new User({ name, email, password, phone, role, location });
    if (role === 'vet') user.vetDetails = req.body.vetDetails;
    if (role === 'kennel_owner') user.kennelDetails = req.body.kennelDetails;
    await user.save();

    res.status(201).json({ message: 'User registered. Please verify OTP sent to your phone/email.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const verifyOTP = async (req, res) => {
  const { phone, token } = req.body;
  try {
    // Use Supabase to verify OTP
    const { data, error } = await supabaseAdmin.auth.verifyOtp({
      phone,
      token,
      type: 'sms',
    });
    if (error) return res.status(400).json({ message: error.message });
    // Optionally update backend user as verified
    await User.findOneAndUpdate({ phone }, { isVerified: true });
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

// Login with phone - sends OTP
export const loginWithPhone = async (req, res) => {
  const { phone } = req.body;
  try {
    // Use Supabase to send OTP for login
    const { data, error } = await supabaseAdmin.auth.signInWithOtp({
      phone,
    });
    if (error) return res.status(400).json({ message: error.message });
    res.json({ message: 'OTP sent to your phone.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Verify login OTP
export const verifyLoginOTP = async (req, res) => {
  const { phone, token } = req.body;
  try {
    // Use Supabase to verify OTP for login
    const { data, error } = await supabaseAdmin.auth.verifyOtp({
      phone,
      token,
      type: 'sms',
    });
    if (error) return res.status(400).json({ message: error.message });
    // Find user in backend
    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ message: 'User not found' });
    const jwtToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token: jwtToken, user: { id: user._id, name: user.name, role: user.role, isVerified: user.isVerified } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Add comparePassword method to User model
// In User.js, add: userSchema.methods.comparePassword = async function (password) { return await bcrypt.compare(password, this.password); };