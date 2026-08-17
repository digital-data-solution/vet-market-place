// ─────────────────────────────────────────────────────────────────────────────
// XPRESS VET JOB BOARD — connects verified clinics/shops/kennels with vets
// and vet-adjacent staff (vet techs, groomers, receptionists, etc.)
//
// Deliberately a DIRECTORY, not a feed: two-sided from day one ('position' +
// 'seeking_work') so it stays useful even at low posting volume, unlike a
// feed that looks abandoned without constant fresh content.
//
// Contact happens off-platform (phone/WhatsApp) — no CV upload, no
// application tracking. Same "connector, not intermediary" posture as
// Xpress Market, and the same reason it can ship this small.
//
// Revenue lever: BOOST — one-off Paystack payment to feature a posting at the
// top, reusing the exact activateFeatured/activateListingFeatured pattern.
// ─────────────────────────────────────────────────────────────────────────────

import axios        from 'axios';
import JobPosting    from '../models/JobPosting.js';
import JobReport     from '../models/JobReport.js';
import User          from '../models/User.js';
import Professional  from '../models/Professional.js';
import Shop          from '../models/Shop.js';
import logger         from '../lib/logger.js';
import { logActivity } from '../lib/activityLogger.js';
import { sendEmail }   from '../services/email.service.js';
import { ROLE_CATEGORIES, EMPLOYMENT_TYPES } from '../models/JobPosting.js';

const PAYSTACK_BASE   = process.env.PAYSTACK_BASE       || 'https://api.paystack.co';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const ADMIN_EMAIL     = process.env.ADMIN_EMAIL || 'contact@xpressdigitalanddatasolutions.online';

const POSTING_TTL_DAYS    = 30;  // postings auto-expire after this; renew to extend
const MAX_ACTIVE_POSTINGS = 10;  // anti-spam cap per poster (not a paywall)
const AUTO_FLAG_REPORTS   = 3;   // reports before a posting is auto-hidden for review

// Same shape/price as market.controller.js's BOOST_PACKAGES — one consistent
// boost price across every listing/posting type in the app.
const BOOST_PACKAGES = {
  7:  { days: 7,  price: 1500, label: '7-Day Boost'  },
  14: { days: 14, price: 2500, label: '14-Day Boost' },
  30: { days: 30, price: 4000, label: '30-Day Boost' },
};

const JOB_BOARD_DISCLAIMER =
  'Xpress Vet only connects job posters and candidates. We do not verify individual ' +
  'employment claims, run background checks, or guarantee any position or candidate, and ' +
  'are not a party to any hiring decision or employment relationship. Verify credentials ' +
  'directly before hiring or accepting a role.';

// Verified-poster gate for 'position' postings — mirrors the exact check used
// by subscriptionMiddleware.js's professionalOnly (Professional.findOne({userId})
// / Shop.findOne({owner})), scoped to isVerified so unverified accounts can't
// post fake job listings. 'seeking_work' postings intentionally skip this —
// a vet tech or receptionist looking for work usually isn't a registered
// business, so gating candidate-side posting would kill the supply side.
async function isVerifiedPoster(userId) {
  const [prof, shop] = await Promise.all([
    Professional.findOne({ userId, isVerified: true }).select('_id').lean(),
    Shop.findOne({ owner: userId, isVerified: true }).select('_id').lean(),
  ]);
  return !!(prof || shop);
}

function publicPosting(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  o.isFeaturedNow = !!(o.featuredUntil && new Date(o.featuredUntil).getTime() > Date.now());
  return o;
}

async function ownedPosting(userId, id) {
  const posting = await JobPosting.findById(id);
  if (!posting) return { error: 404 };
  if (posting.poster.toString() !== userId.toString()) return { error: 403 };
  return { posting };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — job board metadata
// ─────────────────────────────────────────────────────────────────────────────
export const getJobBoardMeta = async (_req, res) => {
  res.json({
    success: true,
    data: {
      roleCategories:    ROLE_CATEGORIES,
      employmentTypes:   EMPLOYMENT_TYPES,
      disclaimer:        JOB_BOARD_DISCLAIMER,
      boost:             { currency: 'NGN', packages: Object.values(BOOST_PACKAGES) },
      maxActivePostings: MAX_ACTIVE_POSTINGS,
      postingTtlDays:    POSTING_TTL_DAYS,
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — browse / search postings
// Query: kind, roleCategory, employmentType, q, lat, lng, sort, page, limit
// ─────────────────────────────────────────────────────────────────────────────
export const browseJobPostings = async (req, res) => {
  try {
    const { kind, roleCategory, employmentType, q, lat, lng, sort } = req.query;
    const page  = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));

    const now = new Date();
    const filter = {
      status: 'active',
      isFlagged: { $ne: true },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    };
    if (kind === 'position' || kind === 'seeking_work') filter.kind = kind;
    if (roleCategory) filter.roleCategory = roleCategory;
    if (employmentType) filter.employmentType = employmentType;
    if (q) {
      const re = new RegExp(q.toString().trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$and = [{ $or: [{ title: re }, { description: re }, { city: re }, { address: re }] }];
    }

    const hasGeo = lat && lng && !Number.isNaN(parseFloat(lat)) && !Number.isNaN(parseFloat(lng));

    let query;
    if (hasGeo && sort === 'nearest') {
      filter.location = {
        $near: {
          $geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
          $maxDistance: 500 * 1000, // 500km
        },
      };
      query = JobPosting.find(filter).limit(limit).skip((page - 1) * limit);
    } else {
      query = JobPosting.find(filter).sort({ featuredUntil: -1, createdAt: -1 }).limit(limit).skip((page - 1) * limit);
    }

    const [docs, total] = await Promise.all([
      query.populate('poster', 'name profileImage').lean(),
      JobPosting.countDocuments(filter),
    ]);

    const nowMs = now.getTime();
    const withFlag = docs.map((d) => ({
      ...d,
      isFeaturedNow: !!(d.featuredUntil && new Date(d.featuredUntil).getTime() > nowMs),
      poster: d.poster ? { _id: d.poster._id, name: d.poster.name, profileImage: d.poster.profileImage || null } : null,
    }));
    if (!sort || sort === 'newest') {
      withFlag.sort((a, b) => (b.isFeaturedNow ? 1 : 0) - (a.isFeaturedNow ? 1 : 0));
    }

    return res.json({ success: true, data: withFlag, total, page, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    logger.error('Browse job postings error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load job postings.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — single posting (increments view count fire-and-forget)
// ─────────────────────────────────────────────────────────────────────────────
export const getJobPosting = async (req, res) => {
  try {
    const posting = await JobPosting.findById(req.params.id).populate('poster', 'name profileImage phone');
    if (!posting || posting.status === 'removed') {
      return res.status(404).json({ success: false, message: 'Job posting not found.' });
    }
    JobPosting.updateOne({ _id: posting._id }, { $inc: { views: 1 } }).catch(() => {});
    return res.json({ success: true, data: publicPosting(posting), disclaimer: JOB_BOARD_DISCLAIMER });
  } catch (error) {
    logger.error('Get job posting error', { error: error.message, id: req.params.id });
    return res.status(500).json({ success: false, message: 'Failed to load job posting.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PROTECTED — my postings (all statuses)
// ─────────────────────────────────────────────────────────────────────────────
export const myJobPostings = async (req, res) => {
  const userId = req.user._id || req.user.id;
  try {
    const docs = await JobPosting.find({ poster: userId, status: { $ne: 'removed' } }).sort({ createdAt: -1 }).lean();
    const nowMs = Date.now();
    const data = docs.map((d) => ({ ...d, isFeaturedNow: !!(d.featuredUntil && new Date(d.featuredUntil).getTime() > nowMs) }));
    return res.json({ success: true, data });
  } catch (error) {
    logger.error('My job postings error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to load your job postings.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PROTECTED — create a posting
// ─────────────────────────────────────────────────────────────────────────────
export const createJobPosting = async (req, res) => {
  const userId = req.user._id || req.user.id;
  const b = req.body || {};

  try {
    const kind = b.kind === 'position' ? 'position' : (b.kind === 'seeking_work' ? 'seeking_work' : null);
    if (!kind) return res.status(400).json({ success: false, message: 'Choose whether you are posting an open position or your own availability.' });

    if (kind === 'position' && !(await isVerifiedPoster(userId))) {
      return res.status(403).json({
        success: false,
        message: 'Only verified clinics, shops, or kennels can post open positions. Get verified first, or post under "Seeking Work" if you are a candidate.',
      });
    }

    const title = (b.title || '').toString().trim();
    const description = (b.description || '').toString().trim();
    if (title.length < 3)        return res.status(400).json({ success: false, message: 'Please enter a clear title.' });
    if (description.length < 10) return res.status(400).json({ success: false, message: 'Please add a description (at least 10 characters).' });

    const activeCount = await JobPosting.countDocuments({
      poster: userId, status: 'active',
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    });
    if (activeCount >= MAX_ACTIVE_POSTINGS) {
      return res.status(400).json({
        success: false,
        message: `You have reached the limit of ${MAX_ACTIVE_POSTINGS} active job postings. Mark some as filled or remove them first.`,
      });
    }

    const doc = {
      poster: userId,
      kind,
      title:       title.slice(0, 120),
      description: description.slice(0, 3000),
      roleCategory:    ROLE_CATEGORIES.includes(b.roleCategory) ? b.roleCategory : '',
      employmentType:  EMPLOYMENT_TYPES.includes(b.employmentType) ? b.employmentType : null,
      experienceText:  (b.experienceText || '').toString().trim().slice(0, 100) || null,
      salaryText:      (b.salaryText || '').toString().trim().slice(0, 100) || null,
      contactPhone:    (b.contactPhone || req.user.phone || '').toString().trim().slice(0, 30) || null,
      contactWhatsapp: (b.contactWhatsapp || '').toString().trim().slice(0, 30) || null,
      address: (b.address || '').toString().trim().slice(0, 200) || null,
      city:    (b.city || '').toString().trim().slice(0, 80) || null,
      status: 'active',
      expiresAt: new Date(Date.now() + POSTING_TTL_DAYS * 86400000),
    };

    const lat = parseFloat(b.lat), lng = parseFloat(b.lng);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      doc.location = { type: 'Point', coordinates: [lng, lat] };
    }

    const posting = await JobPosting.create(doc);

    logActivity(userId, req.user.role, 'jobboard.posting.created', { postingId: posting._id, kind }, req);
    return res.status(201).json({ success: true, message: 'Job posting published.', data: publicPosting(posting) });
  } catch (error) {
    logger.error('Create job posting error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to create job posting.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PROTECTED (owner) — update / mark filled / renew / delete / report
// ─────────────────────────────────────────────────────────────────────────────
export const updateJobPosting = async (req, res) => {
  const userId = req.user._id || req.user.id;
  try {
    const { posting, error } = await ownedPosting(userId, req.params.id);
    if (error === 404) return res.status(404).json({ success: false, message: 'Job posting not found.' });
    if (error === 403) return res.status(403).json({ success: false, message: 'This is not your job posting.' });

    const b = req.body || {};
    const editable = ['title', 'description', 'roleCategory', 'employmentType', 'experienceText',
      'salaryText', 'contactPhone', 'contactWhatsapp', 'address', 'city'];
    for (const key of editable) {
      if (b[key] === undefined) continue;
      if (key === 'roleCategory')   { posting.roleCategory   = ROLE_CATEGORIES.includes(b[key]) ? b[key] : ''; continue; }
      if (key === 'employmentType') { posting.employmentType = EMPLOYMENT_TYPES.includes(b[key]) ? b[key] : null; continue; }
      posting[key] = typeof b[key] === 'string' ? b[key].toString().trim() : b[key];
    }

    await posting.save();
    return res.json({ success: true, message: 'Job posting updated.', data: publicPosting(posting) });
  } catch (error) {
    logger.error('Update job posting error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to update job posting.' });
  }
};

export const markFilled = async (req, res) => {
  const userId = req.user._id || req.user.id;
  try {
    const { posting, error } = await ownedPosting(userId, req.params.id);
    if (error === 404) return res.status(404).json({ success: false, message: 'Job posting not found.' });
    if (error === 403) return res.status(403).json({ success: false, message: 'This is not your job posting.' });
    posting.status = 'filled';
    await posting.save();
    return res.json({ success: true, message: 'Marked as filled.', data: { id: posting._id } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update job posting.' });
  }
};

export const renewJobPosting = async (req, res) => {
  const userId = req.user._id || req.user.id;
  try {
    const { posting, error } = await ownedPosting(userId, req.params.id);
    if (error === 404) return res.status(404).json({ success: false, message: 'Job posting not found.' });
    if (error === 403) return res.status(403).json({ success: false, message: 'This is not your job posting.' });
    posting.status    = 'active';
    posting.expiresAt = new Date(Date.now() + POSTING_TTL_DAYS * 86400000);
    await posting.save();
    return res.json({ success: true, message: 'Job posting renewed for 30 more days.', data: { id: posting._id, expiresAt: posting.expiresAt } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to renew job posting.' });
  }
};

export const deleteJobPosting = async (req, res) => {
  const userId = req.user._id || req.user.id;
  try {
    const { posting, error } = await ownedPosting(userId, req.params.id);
    if (error === 404) return res.status(404).json({ success: false, message: 'Job posting not found.' });
    if (error === 403) return res.status(403).json({ success: false, message: 'This is not your job posting.' });
    posting.status = 'removed';
    await posting.save();
    return res.json({ success: true, message: 'Job posting removed.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to remove job posting.' });
  }
};

export const reportJobPosting = async (req, res) => {
  const userId = req.user._id || req.user.id;
  const reason = (req.body.reason || 'other').toString();
  const note   = (req.body.note || '').toString().trim().slice(0, 500);

  try {
    const posting = await JobPosting.findById(req.params.id);
    if (!posting || posting.status === 'removed') {
      return res.status(404).json({ success: false, message: 'Job posting not found.' });
    }
    await JobReport.create({ jobPosting: posting._id, reporter: userId, reason, note });
    posting.reportCount = (posting.reportCount || 0) + 1;
    if (posting.reportCount >= AUTO_FLAG_REPORTS) posting.isFlagged = true;
    await posting.save();

    if (posting.isFlagged) {
      sendEmail(
        ADMIN_EMAIL,
        `🚩 Job posting auto-flagged — "${posting.title}"`,
        `<p>Posting <strong>${posting.title}</strong> (${posting._id}) reached ${posting.reportCount} reports and was auto-hidden.</p>
         <p>Latest reason: <strong>${reason}</strong>${note ? ` — ${note}` : ''}</p>`,
      ).catch(() => {});
    }

    logActivity(userId, req.user.role, 'jobboard.posting.reported', { postingId: posting._id, reason }, req);
    return res.json({ success: true, message: 'Thank you. Our team will review this posting.' });
  } catch (error) {
    logger.error('Report job posting error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to submit report.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// BOOST — one-off Paystack payment to feature a job posting.
// Mirrors market.controller.js's createListingBoostPayment (metadata.type='job_boost').
// ─────────────────────────────────────────────────────────────────────────────
export const createJobBoostPayment = async (req, res) => {
  const userId = req.user._id || req.user.id;
  const days   = parseInt(req.body.days, 10);

  if (!PAYSTACK_SECRET) return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  const pkg = BOOST_PACKAGES[days];
  if (!pkg) return res.status(400).json({ success: false, message: 'Invalid boost package. Choose 7, 14 or 30 days.' });

  try {
    const { posting, error } = await ownedPosting(userId, req.params.id);
    if (error === 404) return res.status(404).json({ success: false, message: 'Job posting not found.' });
    if (error === 403) return res.status(403).json({ success: false, message: 'This is not your job posting.' });

    const user = await User.findById(userId);
    if (!user?.email) return res.status(400).json({ success: false, message: 'Account email required to pay.' });

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email:    user.email,
        amount:   pkg.price * 100,
        currency: 'NGN',
        metadata: {
          type:      'job_boost',
          postingId: posting._id.toString(),
          days:      pkg.days,
          userId:    userId.toString(),
        },
        callback_url: process.env.PAYSTACK_CALLBACK_URL,
        channels: ['card', 'bank', 'ussd', 'qr', 'mobile_money', 'bank_transfer'],
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } },
    );

    const { data } = initRes;
    if (!data?.status || !data?.data) return res.status(500).json({ success: false, message: 'Payment initialization failed.' });

    return res.status(201).json({
      success: true,
      message: 'Boost payment initialized.',
      data: { authorization_url: data.data.authorization_url, reference: data.data.reference, amount: pkg.price, days: pkg.days },
    });
  } catch (error) {
    logger.error('Create job boost error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to start boost payment.' });
  }
};

// Called by the Paystack webhook + verify fallback (subscription.controller.js).
// Idempotent — same reference never applied twice.
export async function activateJobBoost(metadata, reference) {
  const { postingId, days } = metadata;
  const boostDays = BOOST_PACKAGES[days]?.days ?? parseInt(days, 10);
  if (!postingId || !boostDays) throw new Error('job_boost metadata incomplete');

  const posting = await JobPosting.findById(postingId);
  if (!posting) throw new Error('job_boost target not found');

  if (posting.lastFeaturedReference && posting.lastFeaturedReference === reference) {
    return { featuredUntil: posting.featuredUntil, days: boostDays };
  }

  const now  = new Date();
  const base = posting.featuredUntil && posting.featuredUntil > now ? posting.featuredUntil : now;
  posting.featuredUntil         = new Date(base.getTime() + boostDays * 86400000);
  posting.lastFeaturedReference = reference;
  if (posting.status === 'expired' || (posting.expiresAt && posting.expiresAt < now)) {
    posting.status    = 'active';
    posting.expiresAt = new Date(now.getTime() + POSTING_TTL_DAYS * 86400000);
  }
  await posting.save();
  return { featuredUntil: posting.featuredUntil, days: boostDays };
}
