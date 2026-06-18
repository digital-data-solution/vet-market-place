import Professional from '../models/Professional.js';
import User from '../models/User.js';
import cache from '../lib/cache.js';
import { applyReferralReward } from '../lib/referralHelper.js';
import {
  sendVerificationApproved,
  sendVerificationRejected,
} from '../services/email.service.js';

// Admin: List pending professional verifications (all roles — vet, kennel, groomer, shop, etc.)
export const listPendingProfessionals = async (req, res) => {
  try {
    const { role, limit = 50, page = 1 } = req.query;

    const VALID_ROLES = ['vet','kennel','groomer','trainer','pet_sitter','pet_transport','cremation_service','agro_vet_supplier','insurance_provider','pet_pharmacy','rescue_center','pet_hotel','farm'];
    const filters = { verificationStatus: 'pending' };
    if (role && VALID_ROLES.includes(role)) filters.role = role;

    const [professionals, total] = await Promise.all([
      Professional.find(filters)
        .populate('userId', 'name email phone isVerified createdAt vetDetails')
        .select('-__v')
        .limit(parseInt(limit))
        .skip((parseInt(page) - 1) * parseInt(limit))
        .sort({ createdAt: 1 }) // Oldest first
        .lean(),
      Professional.countDocuments(filters)
    ]);

    // Normalize VCN: fall back to User.vetDetails.vcnNumber for vets who submitted
    // via VetVerificationScreen before the Professional-level sync was fixed.
    const data = professionals.map(p => ({
      ...p,
      vcnNumber: p.vcnNumber || p.userId?.vetDetails?.vcnNumber || null,
    }));

    res.json({
      success: true,
      count: data.length,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
      data,
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

    const adminId = req.user._id || req.user.id;

    // Update professional verification status
    if (action === 'approve') {
      professional.isVerified = true;
      professional.verificationStatus = 'approved';
      professional.verifiedAt = new Date();
      professional.verifiedBy = adminId;
      professional.adminNotes = adminNotes || 'Approved by admin';

      // Also update User model verification if it's a vet
      if (professional.role === 'vet') {
        const user = await User.findById(professional.userId);
        if (user) {
          if (!user.vetVerification) user.vetVerification = {};
          user.vetVerification.status = 'approved';
          user.vetVerification.reviewedAt = new Date();
          user.vetVerification.reviewedBy = adminId;
          if (adminNotes) user.vetVerification.adminNotes = adminNotes;
          user.markModified('vetVerification');
          await user.save({ validateBeforeSave: false });

          // Deferred referral reward — vet referrals only rewarded once verified (60 days)
          if (user.referredBy && !user.referralRewardApplied) {
            applyReferralReward(user, 60).catch(() => {});
          }
        }
      }
    } else {
      professional.isVerified = false;
      professional.verificationStatus = 'rejected';
      professional.adminNotes = adminNotes || 'Rejected by admin';

      // Update User model verification if it's a vet
      if (professional.role === 'vet') {
        await User.findByIdAndUpdate(professional.userId, {
          'vetVerification.status': 'rejected',
          'vetVerification.reviewedAt': new Date(),
          'vetVerification.reviewedBy': adminId,
          ...(adminNotes && { 'vetVerification.adminNotes': adminNotes }),
        });
      }
    }

    await professional.save();

    // Clear relevant cache
    await cache.del(`professional:${professional.userId}`);
    await cache.cacheDel(`professionals:list:${professional.role}:1:50:`);
    await cache.cacheDel(`professionals:list:${professional.role}:1:20:`);

    // Email the professional — fire-and-forget
    const profEmail = professional.email || professional.userId?.email;
    const profName  = professional.name;
    if (profEmail) {
      if (action === 'approve') {
        sendVerificationApproved(profName, profEmail).catch(() => {});
      } else {
        sendVerificationRejected(profName, profEmail, adminNotes).catch(() => {});
      }
    }

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

    const ALL_ROLES = ['vet','kennel','groomer','trainer','pet_sitter','pet_transport','cremation_service','agro_vet_supplier','insurance_provider','pet_pharmacy','rescue_center','pet_hotel','farm'];
    if (role && ALL_ROLES.includes(role)) filters.role = role;

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

    // ✅ FIXED: Changed { new: true } to { returnDocument: 'after' }
    const professional = await Professional.findByIdAndUpdate(
      id,
      { $set: updates },
      { returnDocument: 'after', runValidators: true }
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