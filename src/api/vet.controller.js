import User from '../models/User.js';
import Professional from '../models/Professional.js';
import cache from '../lib/cache.js';
import logger from '../lib/logger.js';

// ============================================================================
// VET VCN VERIFICATION WORKFLOW
// ============================================================================

/**
 * Vet submits VCN info/documents for verification
 * POST /api/v1/vet-verification/submit
 * Body: { vcn, documents, notes }
 */
export const submitVCN = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    const { vcn, documents, notes } = req.body; // ✅ FIX: Match frontend field names

    if (!vcn || !vcn.trim()) {
      logger.warn('VCN submission: missing VCN number', { userId });
      return res.status(400).json({ 
        success: false, 
        message: 'VCN number is required' 
      });
    }

    logger.info('Submitting VCN for verification', { userId, vcn: vcn.trim() });

    const user = await User.findById(userId);
    if (!user) {
      logger.warn('VCN submission: user not found', { userId });
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    if (user.role !== 'vet') {
      logger.warn('VCN submission: not a vet', { userId, role: user.role });
      return res.status(403).json({ 
        success: false, 
        message: 'Only vets can submit VCN for verification' 
      });
    }

    // Initialize vetDetails if not exists
    user.vetDetails = user.vetDetails || {};
    user.vetDetails.vcnNumber = vcn.trim();

    // Initialize vetVerification if not exists
    user.vetVerification = user.vetVerification || {};
    user.vetVerification.status = 'pending';
    user.vetVerification.submittedAt = new Date();
    
    // ✅ FIX: Parse documents as newline-separated links
    if (documents && documents.trim()) {
      user.vetVerification.documents = documents
        .split('\n')
        .map(d => d.trim())
        .filter(Boolean);
    }

    // ✅ FIX: Store notes in adminNotes field
    if (notes && notes.trim()) {
      user.vetVerification.adminNotes = notes.trim();
    }

    await user.save();

    // Also update Professional record if exists
    await Professional.findOneAndUpdate(
      { userId },
      { 
        vcnNumber: vcn.trim(),
        $set: { 
          'verificationSubmitted': true,
          'verificationSubmittedAt': new Date()
        }
      }
    );

    logger.info('VCN submitted for review', { userId, vcn: vcn.trim() });

    res.status(200).json({ 
      success: true,
      message: 'VCN submitted for review. Our team will verify within 2-3 business days.', 
      status: user.vetVerification.status 
    });
  } catch (error) {
    logger.error('VCN submission error', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      success: false,
      message: 'Failed to submit VCN. Please try again.',
      error: error.message 
    });
  }
};

// ============================================================================
// ADMIN VERIFICATION MANAGEMENT
// ============================================================================

/**
 * Admin: list pending vet verifications
 * GET /api/v1/vet-verification/pending
 */
export const listPendingVets = async (req, res) => {
  try {
    const { limit = 50, page = 1 } = req.query;

    const pending = await User.find({ 
      role: 'vet', 
      'vetVerification.status': 'pending' 
    })
      .select('name email phone vetDetails vetVerification location createdAt')
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .sort({ 'vetVerification.submittedAt': -1 })
      .lean();

    const total = await User.countDocuments({ 
      role: 'vet', 
      'vetVerification.status': 'pending' 
    });

    logger.info('Admin fetched pending vets', { count: pending.length, total });

    res.json({ 
      success: true,
      count: pending.length,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      data: pending 
    });
  } catch (error) {
    logger.error('List pending vets error', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch pending verifications',
      error: error.message 
    });
  }
};

/**
 * Admin: approve or reject a vet verification
 * POST /api/v1/vet-verification/review/:id
 * Body: { action: 'approve' | 'reject', adminNotes }
 */
export const reviewVet = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, adminNotes } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ 
        success: false,
        message: 'Invalid action. Must be "approve" or "reject"' 
      });
    }

    const user = await User.findById(id);
    if (!user) {
      logger.warn('Vet review: user not found', { id });
      return res.status(404).json({ 
        success: false,
        message: 'Vet not found' 
      });
    }

    if (user.role !== 'vet') {
      logger.warn('Vet review: user is not a vet', { id, role: user.role });
      return res.status(400).json({ 
        success: false,
        message: 'User is not a vet' 
      });
    }

    const adminId = req.user._id || req.user.id;

    if (action === 'approve') {
      // Update User verification status
      user.vetVerification.status = 'approved';
      user.vetVerification.verifiedAt = new Date();
      user.vetVerification.reviewedBy = adminId;
      if (adminNotes) {
        user.vetVerification.adminNotes = adminNotes;
      }

      await user.save();

      // ✅ FIX: Sync to Professional model - make profile visible
      const professionalUpdate = await Professional.findOneAndUpdate(
        { userId: user._id },
        { 
          isVerified: true,
          verifiedAt: new Date(),
          verifiedBy: adminId
        },
        { new: true }
      );

      if (!professionalUpdate) {
        logger.warn('Vet approved but no Professional profile found', { userId: user._id });
      }

      // Clear cache
      await cache.del(`professional:${user._id}`);

      logger.info('Vet verification approved', { 
        userId: user._id, 
        vcnNumber: user.vetDetails?.vcnNumber,
        adminId 
      });

      res.json({ 
        success: true,
        message: 'Vet approved. Profile is now visible in search results.', 
        status: user.vetVerification.status 
      });

    } else if (action === 'reject') {
      // Update User verification status
      user.vetVerification.status = 'rejected';
      user.vetVerification.reviewedAt = new Date();
      user.vetVerification.reviewedBy = adminId;
      if (adminNotes) {
        user.vetVerification.adminNotes = adminNotes;
      }

      await user.save();

      // Professional profile remains hidden (isVerified = false)

      logger.info('Vet verification rejected', { 
        userId: user._id, 
        vcnNumber: user.vetDetails?.vcnNumber,
        adminId,
        reason: adminNotes 
      });

      res.json({ 
        success: true,
        message: 'Vet verification rejected.', 
        status: user.vetVerification.status 
      });
    }
  } catch (error) {
    logger.error('Review vet error', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      success: false,
      message: 'Failed to review vet verification',
      error: error.message 
    });
  }
};

/**
 * Admin: Get verification details for a specific vet
 * GET /api/v1/vet-verification/:id
 */
export const getVetVerification = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id)
      .select('name email phone role vetDetails vetVerification location createdAt')
      .lean();

    if (!user) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found' 
      });
    }

    if (user.role !== 'vet') {
      return res.status(400).json({ 
        success: false,
        message: 'User is not a vet' 
      });
    }

    // Also fetch Professional profile
    const professional = await Professional.findOne({ userId: id })
      .select('-__v')
      .lean();

    res.json({ 
      success: true,
      data: {
        user,
        professional
      }
    });
  } catch (error) {
    logger.error('Get vet verification error', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch vet verification details',
      error: error.message 
    });
  }
};

/**
 * Get current user's verification status
 * GET /api/v1/vet-verification/status
 */
export const getMyVerificationStatus = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;

    const user = await User.findById(userId)
      .select('role vetVerification vetDetails')
      .lean();

    if (!user) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found' 
      });
    }

    if (user.role !== 'vet') {
      return res.status(403).json({ 
        success: false,
        message: 'Only vets have verification status' 
      });
    }

    res.json({ 
      success: true,
      data: {
        vcnNumber: user.vetDetails?.vcnNumber,
        status: user.vetVerification?.status || 'not_submitted',
        submittedAt: user.vetVerification?.submittedAt,
        verifiedAt: user.vetVerification?.verifiedAt,
        adminNotes: user.vetVerification?.adminNotes
      }
    });
  } catch (error) {
    logger.error('Get verification status error', { error: error.message, stack: error.stack });
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch verification status',
      error: error.message 
    });
  }
};