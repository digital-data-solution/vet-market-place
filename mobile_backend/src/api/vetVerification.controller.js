import User from '../models/User.js';
import logger from '../lib/logger.js';

// Vet submits VCN info / documents for verification
export const submitVCN = async (req, res) => {
  try {
    const userId = req.user._id;
    const { vcnNumber, documents = [] } = req.body;
    logger.info('Submitting VCN for verification', { userId, vcnNumber });

    const user = await User.findById(userId);
    if (!user) {
      logger.warn('VCN submission: user not found', { userId });
      return res.status(404).json({ message: 'User not found' });
    }
    if (user.role !== 'vet') {
      logger.warn('VCN submission: not a vet', { userId });
      return res.status(403).json({ message: 'Only vets can submit VCN' });
    }

    user.vetDetails = user.vetDetails || {};
    if (vcnNumber) user.vetDetails.vcnNumber = vcnNumber;
    if (documents && documents.length) user.vetVerification.documents = documents;
    user.vetVerification.status = 'pending';
    await user.save();

    logger.info('VCN submitted for review', { userId });
    res.status(200).json({ message: 'VCN submitted for review', status: user.vetVerification.status });
  } catch (error) {
    logger.error('VCN submission error', { error: error.message, stack: error.stack });
    res.status(500).json({ message: error.message });
  }
};

// Admin: list pending vet verifications
export const listPendingVets = async (req, res) => {
  try {
    const pending = await User.find({ role: 'vet', 'vetVerification.status': 'pending' })
      .select('name email vetDetails vetVerification location createdAt');

    res.json({ count: pending.length, data: pending });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Admin: approve or reject a vet verification
export const reviewVet = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, adminNotes } = req.body; // action: 'approve' | 'reject'

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: 'Vet not found' });
    if (user.role !== 'vet') return res.status(400).json({ message: 'User is not a vet' });

    if (action === 'approve') {
      user.vetVerification.status = 'approved';
      user.vetVerification.verifiedAt = new Date();
      user.vetVerification.adminNotes = adminNotes || '';
      // Optionally mark overall account verified (keep OTP verification separate)
      // user.isVerified = true;
    } else if (action === 'reject') {
      user.vetVerification.status = 'rejected';
      user.vetVerification.adminNotes = adminNotes || '';
    } else {
      return res.status(400).json({ message: 'Invalid action' });
    }

    await user.save();
    res.json({ message: `Vet ${action}d`, status: user.vetVerification.status });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
