import crypto from 'crypto';
import mongoose from 'mongoose';
import logger from '../lib/logger.js';

/**
 * partner.controller.js
 *
 * Read-only, scoped API for trusted sibling platforms under the same
 * company (currently: Xpress Digital & Data Solutions' internal tools,
 * e.g. their "Call Assignment" feature) to pull real professional segments
 * instead of Sam pasting names/numbers by hand. Same shared-secret pattern
 * as academyWebhook.controller.js (fail closed, constant-time compare) —
 * this is the outbound mirror of that inbound one.
 *
 * Deliberately narrow: only fields a call-assignment brief actually needs
 * (name/contact/role/verification/subscription/last-active). No financial
 * account details, no verification documents (government ID/CAC numbers),
 * no admin notes, no passwords/tokens. Read-only — no route here ever
 * writes anything.
 */
const PARTNER_SECRET = process.env.PARTNER_API_SECRET;

function secretMatches(provided) {
  if (!PARTNER_SECRET || !provided || typeof provided !== 'string') return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(PARTNER_SECRET);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const requirePartnerSecret = (req, res, next) => {
  const provided = req.headers['x-partner-secret'];
  if (!secretMatches(provided)) {
    logger.warn('Partner API rejected: missing/invalid X-Partner-Secret', { ip: req.ip, path: req.path });
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

const VALID_ROLES = [
  'vet', 'kennel', 'groomer', 'trainer', 'pet_sitter', 'pet_transport',
  'cremation_service', 'agro_vet_supplier', 'insurance_provider',
  'pet_pharmacy', 'rescue_center', 'pet_hotel', 'farm',
];
const VALID_VERIFICATION_STATUSES = ['pending', 'approved', 'rejected'];
const VALID_PLANS = ['starter', 'pro', 'basic'];

/**
 * GET /api/partner/professionals
 * Query params (all optional):
 *   role              comma-separated list, e.g. "vet,kennel"
 *   verificationStatus  "pending" | "approved" | "rejected"
 *   plan              "starter" | "pro" | "basic" — filters by their most
 *                     recent subscription's plan (any status)
 *   activeSince       ISO date — only professionals whose account last
 *                     logged in on/after this date
 *   limit             default 100, max 500
 *   cursor            _id of the last row from a previous page, for
 *                     simple keyset pagination (sorted by _id ascending)
 */
export const listProfessionalsForCallAssignment = async (req, res) => {
  try {
    const { role, verificationStatus, plan, activeSince, cursor } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    const match = {};

    if (role) {
      const roles = String(role).split(',').map((r) => r.trim()).filter((r) => VALID_ROLES.includes(r));
      if (!roles.length) {
        return res.status(400).json({ success: false, message: `role must be one of: ${VALID_ROLES.join(', ')}` });
      }
      match.role = { $in: roles };
    }

    if (verificationStatus) {
      if (!VALID_VERIFICATION_STATUSES.includes(verificationStatus)) {
        return res.status(400).json({ success: false, message: `verificationStatus must be one of: ${VALID_VERIFICATION_STATUSES.join(', ')}` });
      }
      match.verificationStatus = verificationStatus;
    }

    if (plan && !VALID_PLANS.includes(plan)) {
      return res.status(400).json({ success: false, message: `plan must be one of: ${VALID_PLANS.join(', ')}` });
    }

    if (cursor) {
      if (!mongoose.isValidObjectId(cursor)) {
        return res.status(400).json({ success: false, message: 'cursor must be a valid id.' });
      }
      match._id = { $gt: new mongoose.Types.ObjectId(cursor) };
    }

    let activeSinceDate = null;
    if (activeSince) {
      activeSinceDate = new Date(activeSince);
      if (Number.isNaN(activeSinceDate.getTime())) {
        return res.status(400).json({ success: false, message: 'activeSince must be a valid ISO date.' });
      }
    }

    const pipeline = [
      { $match: match },
      { $sort: { _id: 1 } },
      // Overfetch a bit before the activeSince/plan post-filters below (which
      // depend on the joined docs) so a real page of `limit` survives them —
      // capped well short of "everything" to keep this cheap.
      { $limit: limit * 3 },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'userDoc',
        },
      },
      { $unwind: { path: '$userDoc', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'subscriptions',
          let: { uid: '$userId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$user', '$$uid'] } } },
            { $sort: { endDate: -1 } },
            { $limit: 1 },
          ],
          as: 'subDoc',
        },
      },
      { $unwind: { path: '$subDoc', preserveNullAndEmptyArrays: true } },
    ];

    let rows = await mongoose.connection.db.collection('professionals').aggregate(pipeline).toArray();

    if (activeSinceDate) {
      rows = rows.filter((r) => r.userDoc?.lastLoginAt && new Date(r.userDoc.lastLoginAt) >= activeSinceDate);
    }
    if (plan) {
      rows = rows.filter((r) => r.subDoc?.plan === plan);
    }
    rows = rows.slice(0, limit);

    const data = rows.map((r) => ({
      professionalId:     String(r._id),
      name:                r.name || null,
      businessName:        r.businessName || null,
      role:                r.role,
      specialization:      r.specialization || null,
      phone:               r.phone || null,
      email:               r.email || null,
      address:             r.address || null,
      isVerified:          !!r.isVerified,
      verificationStatus:  r.verificationStatus || 'pending',
      isActive:            r.isActive !== false,
      acceptingClients:    r.acceptingClients !== false,
      lastLoginAt:         r.userDoc?.lastLoginAt || null,
      subscriptionPlan:    r.subDoc?.plan || null,
      subscriptionStatus:  r.subDoc?.status || null,
      subscriptionEndDate: r.subDoc?.endDate || null,
    }));

    const nextCursor = data.length === limit ? data[data.length - 1].professionalId : null;

    return res.json({ success: true, data, nextCursor });
  } catch (error) {
    logger.error('listProfessionalsForCallAssignment error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load professionals.' });
  }
};
