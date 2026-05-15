import Professional from '../models/Professional.js';
import User from '../models/User.js';
import cache from '../lib/cache.js';

// Admin: List pending vet verifications
export const listPendingProfessionals = async (req, res) => {
  try {
    const { role = 'vet', limit = 50, page = 1 } = req.query;

    const filters = {
      verificationStatus: 'pending',
    };

    if (role && ['vet', 'kennel'].includes(role)) {
      filters.role = role;
    }

    const [professionals, total] = await Promise.all([
      Professional.find(filters)
        .populate('userId', 'name email phone isVerified createdAt')
        .select('-__v')
        .limit(parseInt(limit))
        .skip((parseInt(page) - 1) * parseInt(limit))
        .sort({ createdAt: 1 }) // Oldest first
        .lean(),
      Professional.countDocuments(filters)
    ]);

    res.json({
      success: true,
      count: professionals.length,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      data: professionals,
    });
  } catch (error) {
    console.error('List pending professionals error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending verifications',
      error: error.message,
    });
  }
};

// Admin: Review a professional (approve/reject)
export const reviewProfessional = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, adminNotes } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid action. Must be "approve" or "reject".',
      });
    }

    const professional = await Professional.findById(id).populate('userId', 'name email phone');

    if (!professional) {
      return res.status(404).json({
        success: false,
        message: 'Professional not found',
      });
    }

    if (professional.verificationStatus !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `This professional has already been ${professional.verificationStatus}`,
      });
    }

    // Update professional verification status
    if (action === 'approve') {
      professional.isVerified = true;
      professional.verificationStatus = 'approved';
      professional.verifiedAt = new Date();
      professional.adminNotes = adminNotes || 'Approved by admin';

      // Also update User model verification if it's a vet
      if (professional.role === 'vet') {
        await User.findByIdAndUpdate(professional.userId, {
          'vetVerification.status': 'approved',
          'vetVerification.verifiedAt': new Date(),
          'vetVerification.adminNotes': adminNotes || 'Approved by admin',
        });
      }
    } else {
      professional.isVerified = false;
      professional.verificationStatus = 'rejected';
      professional.adminNotes = adminNotes || 'Rejected by admin';

      // Update User model verification if it's a vet
      if (professional.role === 'vet') {
        await User.findByIdAndUpdate(professional.userId, {
          'vetVerification.status': 'rejected',
          'vetVerification.adminNotes': adminNotes || 'Rejected by admin',
        });
      }
    }

    await professional.save();

    // Clear relevant cache
    await cache.del(`professional:${professional.userId}`);

    res.json({
      success: true,
      message: `Professional ${action}d successfully`,
      data: professional,
    });
  } catch (error) {
    console.error('Review professional error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to review professional',
      error: error.message,
    });
  }
};

// Admin: Get all professionals (including unverified)
export const getAllProfessionals = async (req, res) => {
  try {
    const { role, verificationStatus, limit = 50, page = 1 } = req.query;

    const filters = {};

    if (role && ['vet', 'kennel'].includes(role)) {
      filters.role = role;
    }

    if (verificationStatus && ['pending', 'approved', 'rejected'].includes(verificationStatus)) {
      filters.verificationStatus = verificationStatus;
    }

    const [professionals, total] = await Promise.all([
      Professional.find(filters)
        .populate('userId', 'name email phone isVerified createdAt')
        .select('-__v')
        .limit(parseInt(limit))
        .skip((parseInt(page) - 1) * parseInt(limit))
        .sort({ createdAt: -1 })
        .lean(),
      Professional.countDocuments(filters)
    ]);

    res.json({
      success: true,
      count: professionals.length,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      data: professionals,
    });
  } catch (error) {
    console.error('Get all professionals error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch professionals',
      error: error.message,
    });
  }
};

// Admin: Update any professional profile
export const updateProfessionalByAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Admin can update verification fields
    const professional = await Professional.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, runValidators: true }
    ).populate('userId', 'name email phone');

    if (!professional) {
      return res.status(404).json({
        success: false,
        message: 'Professional not found',
      });
    }

    // Clear cache
    await cache.del(`professional:${professional.userId}`);

    res.json({
      success: true,
      message: 'Professional updated successfully',
      data: professional,
    });
  } catch (error) {
    console.error('Update professional by admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update professional',
      error: error.message,
    });
  }
};

// Admin: Delete professional profile
export const deleteProfessionalByAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    const professional = await Professional.findByIdAndDelete(id);

    if (!professional) {
      return res.status(404).json({
        success: false,
        message: 'Professional not found',
      });
    }

    // Reset user role
    await User.findByIdAndUpdate(professional.userId, {
      role: 'pet_owner',
      $unset: { vetDetails: '', kennelDetails: '' },
    });

    // Clear cache
    await cache.del(`professional:${professional.userId}`);

    res.json({
      success: true,
      message: 'Professional deleted successfully',
    });
  } catch (error) {
    console.error('Delete professional by admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete professional',
      error: error.message,
    });
  }
};

// Admin: Get statistics
export const getProfessionalStats = async (req, res) => {
  try {
    const [
      totalVets,
      totalKennels,
      pendingVets,
      approvedVets,
      rejectedVets,
      pendingKennels,
      approvedKennels,
    ] = await Promise.all([
      Professional.countDocuments({ role: 'vet' }),
      Professional.countDocuments({ role: 'kennel' }),
      Professional.countDocuments({ role: 'vet', verificationStatus: 'pending' }),
      Professional.countDocuments({ role: 'vet', verificationStatus: 'approved' }),
      Professional.countDocuments({ role: 'vet', verificationStatus: 'rejected' }),
      Professional.countDocuments({ role: 'kennel', verificationStatus: 'pending' }),
      Professional.countDocuments({ role: 'kennel', verificationStatus: 'approved' }),
    ]);

    res.json({
      success: true,
      data: {
        vets: {
          total: totalVets,
          pending: pendingVets,
          approved: approvedVets,
          rejected: rejectedVets,
        },
        kennels: {
          total: totalKennels,
          pending: pendingKennels,
          approved: approvedKennels,
        },
        overall: {
          total: totalVets + totalKennels,
          pending: pendingVets + pendingKennels,
          approved: approvedVets + approvedKennels,
        },
      },
    });
  } catch (error) {
    console.error('Get professional stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: error.message,
    });
  }
};