import User from '../models/User.js';
import jwt from 'jsonwebtoken';
import { sendSMSOTP, verifySMSOTP } from '../services/onesignal.service.js';

// Temporary storage for OTP (use Redis or DB in production)
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

    // Send OTP for verification
    const otpResult = await sendSMSOTP(phone);
    if (!otpResult.success) return res.status(500).json({ message: 'Failed to send OTP' });

    otpStore.set(phone, { otp: otpResult.otpCode, userId: user._id });

    res.status(201).json({ message: 'User registered. Verify OTP.', otpId: otpResult.otpId });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const verifyOTP = async (req, res) => {
  const { phone, otp } = req.body;

  try {
    const stored = otpStore.get(phone);
    if (!stored || stored.otp !== otp) return res.status(400).json({ message: 'Invalid OTP' });

    // Mark user as verified
    await User.findByIdAndUpdate(stored.userId, { isVerified: true });

    otpStore.delete(phone);

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