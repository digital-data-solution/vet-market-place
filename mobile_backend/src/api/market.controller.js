// ─────────────────────────────────────────────────────────────────────────────
// XPRESS MARKET — user-to-user marketplace (sell pets + products / "Pet Mart")
//
// Xpress Vet is ONLY the connector: it lists items and (optionally) holds the
// buyer's money in escrow. It is not a party to any sale and disclaims liability
// for the goods/animals themselves (see MARKET_DISCLAIMER).
//
// Revenue levers (per the product decision): (1) BOOST — one-off Paystack payment
// to feature a listing at the top, reusing the exact activateFeatured pattern;
// (2) ESCROW COMMISSION — buyers who "Buy with Buyer Protection" pay into the
// existing Wallet/Booking escrow and the platform keeps WALLET_COMMISSION_RATE
// on release.
// ─────────────────────────────────────────────────────────────────────────────

import axios       from 'axios';
import crypto      from 'crypto';
import mongoose    from 'mongoose';
import Listing     from '../models/Listing.js';
import Report      from '../models/Report.js';
import User        from '../models/User.js';
import Wallet      from '../models/Wallet.js';
import Transaction from '../models/Transaction.js';
import Booking     from '../models/Booking.js';
import logger      from '../lib/logger.js';
import { logActivity } from '../lib/activityLogger.js';
import { sendPushToUser } from '../services/pushNotification.service.js';
import { sendEmail, sendListingLiveEmail, sendEscrowSellerEmail, sendEscrowBuyerEmail } from '../services/email.service.js';
import { postListingToTelegram } from '../services/telegram.service.js';
import { deleteFromCloudinary } from '../lib/cloudinaryUpload.js';
import { PET_CATEGORIES, PRODUCT_CATEGORIES, isAllowedVideoUrl } from '../models/Listing.js';

const PAYSTACK_BASE   = process.env.PAYSTACK_BASE       || 'https://api.paystack.co';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const COMMISSION_RATE = parseFloat(process.env.WALLET_COMMISSION_RATE || '0.10');
const AUTO_RELEASE_DAYS = parseFloat(process.env.WALLET_AUTO_RELEASE_DAYS || '7');
const ADMIN_EMAIL     = process.env.ADMIN_EMAIL || 'contact@xpressdigitalanddatasolutions.online';

const LISTING_TTL_DAYS   = 30;   // listings auto-expire after this; renew to extend
const MAX_ACTIVE_LISTINGS = 20;  // anti-spam cap per seller (not a paywall)
const AUTO_FLAG_REPORTS  = 3;    // reports before a listing is auto-hidden for review

// Boost packages — identical shape/price to featured.controller.js.
const BOOST_PACKAGES = {
  7:  { days: 7,  price: 1500, label: '7-Day Boost'  },
  14: { days: 14, price: 2500, label: '14-Day Boost' },
  30: { days: 30, price: 4000, label: '30-Day Boost' },
};

// Prohibited items — protects the brand and stays on the right side of the law.
// Simple substring scan on title+description (case-insensitive).
const BANNED_KEYWORDS = [
  'ivory', 'pangolin', 'rhino horn', 'tiger', 'leopard', 'cheetah', 'elephant tusk',
  'endangered', 'bushmeat', 'firearm', 'gun', 'ammunition', 'cocaine', 'heroin',
  'tramadol', 'human', 'organ', 'counterfeit',
];

const MARKET_DISCLAIMER =
  'Xpress Vet only connects buyers and sellers. We do not own, inspect, or guarantee ' +
  'any item or animal listed here and are not responsible for any transaction. ' +
  'Meet in a safe place, verify what you are buying, and use Buyer Protection (escrow) ' +
  'when you can. Never send money for an item you have not verified.';

function internalRef(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function containsBanned(text) {
  const t = (text || '').toLowerCase();
  return BANNED_KEYWORDS.find((kw) => t.includes(kw)) || null;
}

// Free the listing's Cloudinary images — keeps storage costs down when a
// listing is removed, taken down, or hard-deleted by the cleanup cron.
// Best-effort: never throws.
export async function purgeListingImages(listing) {
  const imgs = listing?.images || [];
  for (const img of imgs) {
    try { await deleteFromCloudinary(img.publicId || img.url); }
    catch (e) { logger.warn('purgeListingImages failed', { error: e.message }); }
  }
}

// Shape a listing for public consumption (hide nothing sensitive — it's public
// data by nature — but compute isFeaturedNow and normalise seller info).
function publicListing(doc, { includeSeller = false } = {}) {
  const o = doc.toObject ? doc.toObject() : doc;
  const now = Date.now();
  o.isFeaturedNow = !!(o.featuredUntil && new Date(o.featuredUntil).getTime() > now);
  if (includeSeller && o.seller && typeof o.seller === 'object') {
    o.seller = {
      _id:          o.seller._id,
      name:         o.seller.name,
      profileImage: o.seller.profileImage || null,
    };
  }
  return o;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — marketplace metadata (categories, disclaimer, boost pricing)
// ─────────────────────────────────────────────────────────────────────────────
export const getMarketMeta = async (_req, res) => {
  res.json({
    success: true,
    data: {
      petCategories:     PET_CATEGORIES,
      productCategories: PRODUCT_CATEGORIES,
      disclaimer:        MARKET_DISCLAIMER,
      boost: { currency: 'NGN', packages: Object.values(BOOST_PACKAGES) },
      commissionRate:    COMMISSION_RATE,
      maxActiveListings: MAX_ACTIVE_LISTINGS,
      listingTtlDays:    LISTING_TTL_DAYS,
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — browse / search listings
// Query: kind, category, q, minPrice, maxPrice, lat, lng, sort, page, limit
// ─────────────────────────────────────────────────────────────────────────────
export const browseListings = async (req, res) => {
  try {
    const { kind, category, q, minPrice, maxPrice, lat, lng, sort } = req.query;
    const page  = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));

    const now = new Date();
    const filter = {
      status: 'active',
      isFlagged: { $ne: true },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    };
    if (kind === 'pet' || kind === 'product') filter.kind = kind;
    if (category) filter.category = category;
    if (q) {
      const re = new RegExp(q.toString().trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      // Match text AND location: buyers commonly type a city/area ("Lagos",
      // "Ikeja") into the search box expecting location filtering, so include
      // city + address alongside the content fields.
      filter.$and = [{ $or: [{ title: re }, { description: re }, { breed: re }, { species: re }, { city: re }, { address: re }] }];
    }
    const price = {};
    if (minPrice) price.$gte = parseInt(minPrice, 10);
    if (maxPrice) price.$lte = parseInt(maxPrice, 10);
    if (Object.keys(price).length) filter.price = price;

    const hasGeo = lat && lng && !Number.isNaN(parseFloat(lat)) && !Number.isNaN(parseFloat(lng));

    let query;
    // "near me" — use $near (returns nearest first). Otherwise featured-first, newest.
    if (hasGeo && sort === 'nearest') {
      filter.location = {
        $near: {
          $geometry: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
          $maxDistance: 500 * 1000, // 500km
        },
      };
      query = Listing.find(filter).limit(limit).skip((page - 1) * limit);
    } else {
      let sortSpec = { featuredUntil: -1, createdAt: -1 };
      if (sort === 'price_asc')  sortSpec = { price: 1, createdAt: -1 };
      if (sort === 'price_desc') sortSpec = { price: -1, createdAt: -1 };
      // featuredUntil desc puts nulls last automatically only if we guard; keep it simple:
      query = Listing.find(filter).sort(sortSpec).limit(limit).skip((page - 1) * limit);
    }

    const [docs, total] = await Promise.all([
      query.populate('seller', 'name profileImage').lean(),
      Listing.countDocuments(filter),
    ]);

    // Featured-first: bubble currently-featured listings to the top of the page
    // (a lean() query can't easily express "featuredUntil>now first" in sort).
    const nowMs = now.getTime();
    const withFlag = docs.map((d) => ({
      ...d,
      isFeaturedNow: !!(d.featuredUntil && new Date(d.featuredUntil).getTime() > nowMs),
      seller: d.seller ? { _id: d.seller._id, name: d.seller.name, profileImage: d.seller.profileImage || null } : null,
    }));
    if (!sort || sort === 'newest') {
      withFlag.sort((a, b) => (b.isFeaturedNow ? 1 : 0) - (a.isFeaturedNow ? 1 : 0));
    }

    return res.json({
      success: true,
      data: withFlag,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    logger.error('Browse listings error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to load listings.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC — single listing (increments view count fire-and-forget)
// ─────────────────────────────────────────────────────────────────────────────
export const getListing = async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id)
      .populate('seller', 'name profileImage phone');
    if (!listing || listing.status === 'removed') {
      return res.status(404).json({ success: false, message: 'Listing not found.' });
    }

    Listing.updateOne({ _id: listing._id }, { $inc: { views: 1 } }).catch(() => {});

    return res.json({
      success: true,
      data: publicListing(listing, { includeSeller: true }),
      disclaimer: MARKET_DISCLAIMER,
    });
  } catch (error) {
    logger.error('Get listing error', { error: error.message, id: req.params.id });
    return res.status(500).json({ success: false, message: 'Failed to load listing.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PROTECTED — my listings (all statuses)
// ─────────────────────────────────────────────────────────────────────────────
export const myListings = async (req, res) => {
  const userId = req.user._id || req.user.id;
  try {
    const docs = await Listing.find({ seller: userId, status: { $ne: 'removed' } })
      .sort({ createdAt: -1 })
      .lean();
    const nowMs = Date.now();
    const data = docs.map((d) => ({
      ...d,
      isFeaturedNow: !!(d.featuredUntil && new Date(d.featuredUntil).getTime() > nowMs),
    }));
    return res.json({ success: true, data });
  } catch (error) {
    logger.error('My listings error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to load your listings.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PROTECTED — create a listing
// ─────────────────────────────────────────────────────────────────────────────
export const createListing = async (req, res) => {
  const userId = req.user._id || req.user.id;
  const b = req.body || {};

  try {
    if (!b.riskAccepted) {
      return res.status(400).json({ success: false, message: 'You must accept the Seller Agreement to publish a listing.' });
    }
    const kind = b.kind === 'product' ? 'product' : (b.kind === 'pet' ? 'pet' : null);
    if (!kind) return res.status(400).json({ success: false, message: 'Choose what you are listing (a pet or a product).' });

    const title = (b.title || '').toString().trim();
    const description = (b.description || '').toString().trim();
    const price = parseInt(b.price, 10);

    if (title.length < 3)        return res.status(400).json({ success: false, message: 'Please enter a clear title.' });
    if (description.length < 10) return res.status(400).json({ success: false, message: 'Please add a description (at least 10 characters).' });
    if (Number.isNaN(price) || price < 0) return res.status(400).json({ success: false, message: 'Please enter a valid price.' });

    const banned = containsBanned(`${title} ${description} ${b.species || ''} ${b.breed || ''}`);
    if (banned) {
      return res.status(400).json({
        success: false,
        message: `Listings for prohibited or illegal items are not allowed (matched: "${banned}").`,
      });
    }

    const activeCount = await Listing.countDocuments({
      seller: userId, status: 'active',
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    });
    if (activeCount >= MAX_ACTIVE_LISTINGS) {
      return res.status(400).json({
        success: false,
        message: `You have reached the limit of ${MAX_ACTIVE_LISTINGS} active listings. Mark some as sold or remove them first.`,
      });
    }

    const images = Array.isArray(b.images)
      ? b.images.filter((i) => i && i.url).map((i) => ({ url: i.url, publicId: i.publicId || null })).slice(0, 8)
      : [];

    const videoUrl = (b.videoUrl || '').toString().trim() || null;
    if (videoUrl && !isAllowedVideoUrl(videoUrl)) {
      return res.status(400).json({
        success: false,
        message: 'Video link must be a YouTube, TikTok, Instagram, or Vimeo URL.',
      });
    }

    const doc = {
      seller: userId,
      kind,
      title:       title.slice(0, 120),
      description: description.slice(0, 3000),
      price,
      currency:    (b.currency || 'NGN').toString().slice(0, 8),
      negotiable:  !!b.negotiable,
      category:    (b.category || 'other').toString().trim().slice(0, 40),
      images,
      videoUrl,
      contactPhone:    (b.contactPhone || req.user.phone || '').toString().trim().slice(0, 30) || null,
      contactWhatsapp: (b.contactWhatsapp || '').toString().trim().slice(0, 30) || null,
      address: (b.address || '').toString().trim().slice(0, 200) || null,
      city:    (b.city || '').toString().trim().slice(0, 80) || null,
      riskAccepted: true,
      status: 'active',
      expiresAt: new Date(Date.now() + LISTING_TTL_DAYS * 86400000),
    };

    if (kind === 'pet') {
      doc.species    = (b.species || '').toString().trim().slice(0, 60) || undefined;
      doc.breed      = (b.breed || '').toString().trim().slice(0, 80) || undefined;
      doc.ageText    = (b.ageText || '').toString().trim().slice(0, 40) || undefined;
      doc.sex        = ['male', 'female', 'unknown'].includes(b.sex) ? b.sex : null;
      doc.healthInfo = (b.healthInfo || '').toString().trim().slice(0, 1000) || undefined;
    } else {
      doc.condition = ['new', 'used'].includes(b.condition) ? b.condition : null;
      doc.quantity  = Number.isFinite(parseInt(b.quantity, 10)) ? Math.max(0, parseInt(b.quantity, 10)) : 1;
    }

    // Optional geolocation (client passes lat/lng from device or geocoder).
    const lat = parseFloat(b.lat), lng = parseFloat(b.lng);
    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      doc.location = { type: 'Point', coordinates: [lng, lat] };
    }

    const listing = await Listing.create(doc);

    // Stamp the user's seller-agreement acceptance once (audit).
    User.updateOne(
      { _id: userId, sellerAgreementAcceptedAt: null },
      { $set: { sellerAgreementAcceptedAt: new Date() } },
    ).catch(() => {});

    logActivity(userId, req.user.role, 'market.listing.created', { listingId: listing._id, kind, price }, req);
    if (req.user.email) sendListingLiveEmail(req.user.name, req.user.email, listing.title).catch(() => {});
    postListingToTelegram(listing).catch(() => {}); // no-op until TELEGRAM_BOT_TOKEN/TELEGRAM_CHANNEL_ID are set
    return res.status(201).json({ success: true, message: 'Listing published.', data: publicListing(listing) });
  } catch (error) {
    logger.error('Create listing error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to create listing.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PROTECTED (owner) — update / mark sold / renew / delete
// ─────────────────────────────────────────────────────────────────────────────
async function ownedListing(userId, id) {
  const listing = await Listing.findById(id);
  if (!listing) return { error: 404 };
  if (listing.seller.toString() !== userId.toString()) return { error: 403 };
  return { listing };
}

export const updateListing = async (req, res) => {
  const userId = req.user._id || req.user.id;
  try {
    const { listing, error } = await ownedListing(userId, req.params.id);
    if (error === 404) return res.status(404).json({ success: false, message: 'Listing not found.' });
    if (error === 403) return res.status(403).json({ success: false, message: 'This is not your listing.' });

    const b = req.body || {};
    const editable = ['title', 'description', 'price', 'category', 'negotiable', 'species', 'breed',
      'ageText', 'sex', 'healthInfo', 'condition', 'quantity', 'contactPhone', 'contactWhatsapp', 'address', 'city'];
    for (const key of editable) {
      if (b[key] === undefined) continue;
      if (key === 'price')    { const p = parseInt(b.price, 10); if (!Number.isNaN(p) && p >= 0) listing.price = p; continue; }
      if (key === 'quantity') { const q = parseInt(b.quantity, 10); if (!Number.isNaN(q) && q >= 0) listing.quantity = q; continue; }
      listing[key] = typeof b[key] === 'string' ? b[key].toString().trim() : b[key];
    }
    if (Array.isArray(b.images)) {
      listing.images = b.images.filter((i) => i && i.url).map((i) => ({ url: i.url, publicId: i.publicId || null })).slice(0, 8);
    }
    if (b.videoUrl !== undefined) {
      const videoUrl = (b.videoUrl || '').toString().trim() || null;
      if (videoUrl && !isAllowedVideoUrl(videoUrl)) {
        return res.status(400).json({
          success: false,
          message: 'Video link must be a YouTube, TikTok, Instagram, or Vimeo URL.',
        });
      }
      listing.videoUrl = videoUrl;
    }
    const banned = containsBanned(`${listing.title} ${listing.description}`);
    if (banned) return res.status(400).json({ success: false, message: `Prohibited content not allowed (matched: "${banned}").` });

    await listing.save();
    return res.json({ success: true, message: 'Listing updated.', data: publicListing(listing) });
  } catch (error) {
    logger.error('Update listing error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to update listing.' });
  }
};

export const markSold = async (req, res) => {
  const userId = req.user._id || req.user.id;
  try {
    const { listing, error } = await ownedListing(userId, req.params.id);
    if (error === 404) return res.status(404).json({ success: false, message: 'Listing not found.' });
    if (error === 403) return res.status(403).json({ success: false, message: 'This is not your listing.' });
    listing.status = 'sold';
    await listing.save();
    return res.json({ success: true, message: 'Marked as sold.', data: { id: listing._id } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update listing.' });
  }
};

export const renewListing = async (req, res) => {
  const userId = req.user._id || req.user.id;
  try {
    const { listing, error } = await ownedListing(userId, req.params.id);
    if (error === 404) return res.status(404).json({ success: false, message: 'Listing not found.' });
    if (error === 403) return res.status(403).json({ success: false, message: 'This is not your listing.' });
    listing.status    = 'active';
    listing.expiresAt = new Date(Date.now() + LISTING_TTL_DAYS * 86400000);
    await listing.save();
    return res.json({ success: true, message: 'Listing renewed for 30 more days.', data: { id: listing._id, expiresAt: listing.expiresAt } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to renew listing.' });
  }
};

export const deleteListing = async (req, res) => {
  const userId = req.user._id || req.user.id;
  try {
    const { listing, error } = await ownedListing(userId, req.params.id);
    if (error === 404) return res.status(404).json({ success: false, message: 'Listing not found.' });
    if (error === 403) return res.status(403).json({ success: false, message: 'This is not your listing.' });
    // Free Cloudinary storage immediately; keep a tiny 'removed' row for audit /
    // any escrow booking that references it. The cleanup cron hard-deletes it later.
    await purgeListingImages(listing);
    listing.status = 'removed';
    listing.images = [];
    await listing.save();
    return res.json({ success: true, message: 'Listing removed.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to remove listing.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PROTECTED — report a listing (moderation)
// ─────────────────────────────────────────────────────────────────────────────
export const reportListing = async (req, res) => {
  const userId = req.user._id || req.user.id;
  const reason = (req.body.reason || 'other').toString();
  const note   = (req.body.note || '').toString().trim().slice(0, 500);

  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing || listing.status === 'removed') {
      return res.status(404).json({ success: false, message: 'Listing not found.' });
    }
    await Report.create({ listing: listing._id, reporter: userId, reason, note });
    listing.reportCount = (listing.reportCount || 0) + 1;
    if (listing.reportCount >= AUTO_FLAG_REPORTS) listing.isFlagged = true; // auto-hide for review
    await listing.save();

    if (listing.isFlagged) {
      sendEmail(
        ADMIN_EMAIL,
        `🚩 Marketplace listing auto-flagged — "${listing.title}"`,
        `<p>Listing <strong>${listing.title}</strong> (${listing._id}) reached ${listing.reportCount} reports and was auto-hidden.</p>
         <p>Latest reason: <strong>${reason}</strong>${note ? ` — ${note}` : ''}</p>
         <p>Review it in the admin dashboard → Marketplace.</p>`,
      ).catch(() => {});
    }

    logActivity(userId, req.user.role, 'market.listing.reported', { listingId: listing._id, reason }, req);
    return res.json({ success: true, message: 'Thank you. Our team will review this listing.' });
  } catch (error) {
    logger.error('Report listing error', { error: error.message });
    return res.status(500).json({ success: false, message: 'Failed to submit report.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// BOOST — one-off Paystack payment to feature a listing.
// Mirrors featured.controller.js (metadata.type='listing_featured').
// ─────────────────────────────────────────────────────────────────────────────
export const createListingBoostPayment = async (req, res) => {
  const userId = req.user._id || req.user.id;
  const days   = parseInt(req.body.days, 10);

  if (!PAYSTACK_SECRET) return res.status(500).json({ success: false, message: 'Payment system not configured.' });
  const pkg = BOOST_PACKAGES[days];
  if (!pkg) return res.status(400).json({ success: false, message: 'Invalid boost package. Choose 7, 14 or 30 days.' });

  try {
    const { listing, error } = await ownedListing(userId, req.params.id);
    if (error === 404) return res.status(404).json({ success: false, message: 'Listing not found.' });
    if (error === 403) return res.status(403).json({ success: false, message: 'This is not your listing.' });

    const user = await User.findById(userId);
    if (!user?.email) return res.status(400).json({ success: false, message: 'Account email required to pay.' });

    const initRes = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email:    user.email,
        amount:   pkg.price * 100,
        currency: 'NGN',
        metadata: {
          type:      'listing_featured',
          listingId: listing._id.toString(),
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
    logger.error('Create listing boost error', { error: error.message, userId });
    return res.status(500).json({ success: false, message: 'Failed to start boost payment.' });
  }
};

// Called by the Paystack webhook + verify fallback (subscription.controller.js).
// Idempotent — same reference never applied twice.
export async function activateListingFeatured(metadata, reference) {
  const { listingId, days } = metadata;
  const boostDays = BOOST_PACKAGES[days]?.days ?? parseInt(days, 10);
  if (!listingId || !boostDays) throw new Error('listing_featured metadata incomplete');

  const listing = await Listing.findById(listingId);
  if (!listing) throw new Error('listing_featured target not found');

  if (listing.lastFeaturedReference && listing.lastFeaturedReference === reference) {
    return { featuredUntil: listing.featuredUntil, days: boostDays };
  }

  const now  = new Date();
  const base = listing.featuredUntil && listing.featuredUntil > now ? listing.featuredUntil : now;
  listing.featuredUntil         = new Date(base.getTime() + boostDays * 86400000);
  listing.lastFeaturedReference = reference;
  // Boosting an expired listing reactivates + refreshes it (you paid for reach).
  if (listing.status === 'expired' || (listing.expiresAt && listing.expiresAt < now)) {
    listing.status    = 'active';
    listing.expiresAt = new Date(now.getTime() + LISTING_TTL_DAYS * 86400000);
  }
  await listing.save();

  logger.info('Listing boost activated', { listingId, days: boostDays, reference });
  logActivity(listing.seller, null, 'market.listing.boosted', { listingId, days: boostDays, reference });
  return { featuredUntil: listing.featuredUntil, days: boostDays };
}

// ─────────────────────────────────────────────────────────────────────────────
// BUY WITH BUYER PROTECTION — pay for a listing into escrow.
// Mirrors wallet.controller.payProvider but the seller can be ANY user (not
// only a registered professional/shop), and the Booking is tagged kind:'listing'.
// Release / refund / dispute all reuse the existing /api/v1/wallet endpoints.
// ─────────────────────────────────────────────────────────────────────────────
export const buyListing = async (req, res) => {
  const buyerId = req.user._id || req.user.id;
  const amount  = parseInt(req.body.amount, 10);

  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing || listing.status !== 'active') {
      return res.status(404).json({ success: false, message: 'This listing is no longer available.' });
    }
    const sellerId = listing.seller.toString();
    if (sellerId === buyerId.toString()) {
      return res.status(400).json({ success: false, message: 'You cannot buy your own listing.' });
    }
    const payAmount = Number.isFinite(amount) && amount > 0 ? amount : listing.price;
    if (!payAmount || payAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid amount.' });
    }

    const commissionAmount = Math.round(payAmount * COMMISSION_RATE);
    const providerAmount   = payAmount - commissionAmount;

    let bookingId;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        let buyerWallet = await Wallet.findOne({ user: buyerId }, null, { session });
        if (!buyerWallet) buyerWallet = (await Wallet.create([{ user: buyerId }], { session }))[0];
        if (buyerWallet.balance < payAmount) throw new Error('INSUFFICIENT_FUNDS');

        await Wallet.updateOne(
          { _id: buyerWallet._id },
          { $inc: { balance: -payAmount, escrowBalance: payAmount } },
          { session },
        );

        const now = new Date();
        const booking = await Booking.create([{
          buyer:    buyerId,
          provider: listing.seller,
          kind:     'listing',
          listing:  listing._id,
          amount:   payAmount,
          commissionRate:   COMMISSION_RATE,
          commissionAmount,
          providerAmount,
          description: `Purchase: ${listing.title}`.slice(0, 300),
          status:   'funded',
          fundedAt: now,
          autoReleaseAt: new Date(now.getTime() + AUTO_RELEASE_DAYS * 86400000),
        }], { session });
        bookingId = booking[0]._id;

        await Transaction.create([{
          wallet:       buyerWallet._id,
          user:         buyerId,
          counterparty: listing.seller,
          amount:       payAmount,
          type:     'payment_escrow',
          status:   'completed',
          reference: internalRef('esc'),
          booking:  bookingId,
          metadata: { description: `Escrow for "${listing.title}"` },
        }], { session });
      });
    } finally {
      session.endSession();
    }

    logActivity(buyerId, req.user.role, 'market.listing.escrow_funded', { listingId: listing._id, amount: payAmount, bookingId }, req);
    sendPushToUser(
      listing.seller,
      '💰 A buyer paid into escrow',
      `${req.user.name || 'A buyer'} paid ₦${payAmount.toLocaleString()} for "${listing.title}". It's held safely and released to you once they confirm delivery.`,
      { type: 'market', bookingId: String(bookingId), listingId: String(listing._id) },
    ).catch(() => {});
    // Keep both sides posted by email too.
    User.findById(listing.seller).select('name email').lean().then((seller) => {
      if (seller?.email) sendEscrowSellerEmail(seller.name, seller.email, req.user.name, listing.title, payAmount).catch(() => {});
    }).catch(() => {});
    if (req.user.email) sendEscrowBuyerEmail(req.user.name, req.user.email, listing.title, payAmount).catch(() => {});

    return res.status(201).json({
      success: true,
      message: 'Payment held in escrow. Coordinate delivery with the seller, then release it from your Wallet once you receive the item.',
      data: { bookingId, amount: payAmount, providerAmount, commissionAmount },
    });
  } catch (error) {
    if (error.message === 'INSUFFICIENT_FUNDS') {
      return res.status(400).json({ success: false, message: 'Insufficient wallet balance. Add money to your wallet first.', code: 'INSUFFICIENT_FUNDS' });
    }
    logger.error('Buy listing error', { error: error.message, buyerId });
    return res.status(500).json({ success: false, message: 'Failed to create escrow payment.' });
  }
};
