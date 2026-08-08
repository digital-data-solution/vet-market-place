/**
 * Feature-adoption marketing campaigns — jobs/marketingCampaigns.js
 *
 * One-time-ever emails introducing the two revenue features (Boost Listing,
 * Wallet escrow) to users who haven't tried them yet. Each user gets each
 * campaign at most once (gated by a *PromoSentAt timestamp), respects
 * marketingOptOut, and runs weekly — deliberately low-frequency so this
 * stays "strategic," not spammy.
 */

import cron from 'node-cron';
import Professional from '../models/Professional.js';
import Shop from '../models/Shop.js';
import User from '../models/User.js';
import Transaction from '../models/Transaction.js';
import Product from '../models/Product.js';
import { sendBoostListingPromo, sendWalletPromo, sendPracticeAddonPromo, sendBusinessSuitePromo } from '../services/email.service.js';
import logger from '../lib/logger.js';

const BATCH_SIZE = 50; // per campaign per run, matches other marketing jobs
const MIN_ACCOUNT_AGE_MS = 3 * 24 * 60 * 60 * 1000; // don't pitch brand-new signups immediately

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN 1: Boost Listing — professionals & shops who've never bought one
// ─────────────────────────────────────────────────────────────────────────────
async function runBoostPromo() {
  const cutoff = new Date(Date.now() - MIN_ACCOUNT_AGE_MS);

  const targets = await Promise.all([
    Professional.find({
      lastFeaturedReference: null,
      boostPromoSentAt: null,
      isVerified: true, // don't pitch boosting a listing that isn't even live yet
      createdAt: { $lte: cutoff },
    })
      .populate('userId', 'name email marketingOptOut')
      .limit(BATCH_SIZE)
      .lean(),
    Shop.find({
      lastFeaturedReference: null,
      boostPromoSentAt: null,
      isVerified: true,
      createdAt: { $lte: cutoff },
    })
      .populate('owner', 'name email marketingOptOut')
      .limit(BATCH_SIZE)
      .lean(),
  ]);

  const [professionals, shops] = targets;
  let sent = 0;

  for (const prof of professionals) {
    const account = prof.userId;
    if (!account?.email || account.marketingOptOut) continue;
    const label = prof.businessName || prof.name;
    sendBoostListingPromo(account.name, account.email, account._id, label).catch(() => {});
    await Professional.findByIdAndUpdate(prof._id, { $set: { boostPromoSentAt: new Date() } });
    sent++;
  }

  for (const shop of shops) {
    const account = shop.owner;
    if (!account?.email || account.marketingOptOut) continue;
    sendBoostListingPromo(account.name, account.email, account._id, shop.name).catch(() => {});
    await Shop.findByIdAndUpdate(shop._id, { $set: { boostPromoSentAt: new Date() } });
    sent++;
  }

  logger.info(`Boost Listing promo: sent ${sent} (${professionals.length} professionals, ${shops.length} shops considered)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN 2: Wallet — users who've never had a wallet Transaction
// ─────────────────────────────────────────────────────────────────────────────
async function runWalletPromo() {
  const cutoff = new Date(Date.now() - MIN_ACCOUNT_AGE_MS);

  // Anyone who has ever moved money through the wallet (fund, pay, receive,
  // withdraw) already knows it exists — exclude them.
  const usedWalletIds = await Transaction.distinct('user', { user: { $ne: null } });

  const users = await User.find({
    _id: { $nin: usedWalletIds },
    role: { $ne: 'admin' },
    marketingOptOut: { $ne: true },
    walletPromoSentAt: null,
    createdAt: { $lte: cutoff },
  })
    .select('name email')
    .limit(BATCH_SIZE)
    .lean();

  let sent = 0;
  for (const user of users) {
    if (!user.email) continue;
    sendWalletPromo(user.name, user.email, user._id).catch(() => {});
    await User.findByIdAndUpdate(user._id, { $set: { walletPromoSentAt: new Date() } });
    sent++;
  }

  logger.info(`Wallet promo: sent ${sent} (${users.length} considered)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN 3: Practice Records — verified vets who've never activated the add-on
// ─────────────────────────────────────────────────────────────────────────────
async function runPracticePromo() {
  const cutoff = new Date(Date.now() - MIN_ACCOUNT_AGE_MS);

  const vets = await Professional.find({
    role: 'vet',
    isVerified: true, // only pitch to vets whose listing is live
    practicePromoSentAt: null,
    // Never activated (or has no add-on record at all). Vets currently on a
    // paid add-on already know the feature exists — exclude them.
    $or: [
      { 'practiceAddon.activeUntil': null },
      { 'practiceAddon.activeUntil': { $exists: false } },
      { 'practiceAddon.activeUntil': { $lt: new Date() } },
    ],
    createdAt: { $lte: cutoff },
  })
    .populate('userId', 'name email marketingOptOut')
    .limit(BATCH_SIZE)
    .lean();

  let sent = 0;
  for (const vet of vets) {
    const account = vet.userId;
    if (!account?.email || account.marketingOptOut) continue;
    sendPracticeAddonPromo(account.name, account.email, account._id).catch(() => {});
    await Professional.findByIdAndUpdate(vet._id, { $set: { practicePromoSentAt: new Date() } });
    sent++;
  }

  logger.info(`Practice Records promo: sent ${sent} (${vets.length} vets considered)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN 4: Business Suite — shop/vet/kennel owners who haven't started using
// inventory yet (no products) and have never activated the paid add-on.
// ─────────────────────────────────────────────────────────────────────────────
async function runBusinessPromo() {
  const cutoff = new Date(Date.now() - MIN_ACCOUNT_AGE_MS);
  const now = new Date();

  const usersUsing = await Product.distinct('owner'); // already have inventory — exclude

  const owners = await User.find({
    role: { $in: ['shop_owner', 'vet', 'kennel_owner'] },
    _id: { $nin: usersUsing },
    marketingOptOut: { $ne: true },
    businessPromoSentAt: null,
    createdAt: { $lte: cutoff },
    $or: [
      { 'businessAddon.activeUntil': null },
      { 'businessAddon.activeUntil': { $exists: false } },
      { 'businessAddon.activeUntil': { $lt: now } },
    ],
  })
    .select('name email')
    .limit(BATCH_SIZE)
    .lean();

  let sent = 0;
  for (const user of owners) {
    if (!user.email) continue;
    sendBusinessSuitePromo(user.name, user.email, user._id).catch(() => {});
    await User.findByIdAndUpdate(user._id, { $set: { businessPromoSentAt: new Date() } });
    sent++;
  }

  logger.info(`Business Suite promo: sent ${sent} (${owners.length} owners considered)`);
}

export default function startMarketingCampaignJobs() {
  // Monday 10:00 UTC (11:00 WAT) — once a week, deliberately gentle cadence.
  cron.schedule('0 10 * * 1', async () => {
    try { await runBoostPromo(); }
    catch (err) { logger.error('Boost promo job error', { error: err.message }); }
    try { await runWalletPromo(); }
    catch (err) { logger.error('Wallet promo job error', { error: err.message }); }
    try { await runPracticePromo(); }
    catch (err) { logger.error('Practice promo job error', { error: err.message }); }
    try { await runBusinessPromo(); }
    catch (err) { logger.error('Business promo job error', { error: err.message }); }
  }, { timezone: 'UTC' });

  logger.info('⏰ Marketing campaign jobs scheduled (weekly, Monday 10:00 UTC)');
}
