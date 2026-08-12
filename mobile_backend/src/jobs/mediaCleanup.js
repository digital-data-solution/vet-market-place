/**
 * Media cleanup job — reclaims Cloudinary storage (cost control) after a paid
 * plan lapses.
 *
 * Scenario it solves: a user upgrades, uploads extra gallery photos (up to their
 * paid allowance), then lets the subscription expire. The extra images keep
 * costing us storage forever. This job, after a GRACE window, trims such a user's
 * User.mediaImages back down to their role's FREE allowance and deletes the
 * excess from Cloudinary.
 *
 * Two phases, so nobody is ever surprised:
 *   1. WARN   — the first time an eligible member is seen, email them that their
 *               extra photos will be removed on a given date, and stamp
 *               mediaCleanupWarnedAt. No deletion this run.
 *   2. DELETE — only after BOTH the grace window has elapsed AND at least
 *               WARN_NOTICE_DAYS have passed since the warning email.
 *
 * Safety rules (deliberately conservative — we never delete content a user is
 * entitled to keep):
 *   • Only users who currently have MORE images than their CURRENT plan allows.
 *   • Only users with a PAST paid period (an endDate exists) that lapsed more
 *     than MEDIA_GRACE_DAYS ago. Users who never paid are left untouched — their
 *     images were always free.
 *   • Still-active payers (embedded subscription OR the Subscription collection)
 *     are skipped, and their warning stamp is cleared so a future lapse re-warns.
 *   • We keep the FIRST `free` images (their oldest/primary photos) and delete
 *     the newest extras.
 */

import cron from 'node-cron';
import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import { deleteFromCloudinary } from '../lib/cloudinaryUpload.js';
import { getLimitsForUser, freeLimitFor } from '../lib/mediaLimits.js';
import { sendMediaCleanupWarning } from '../services/email.service.js';
import logger from '../lib/logger.js';

const GRACE_DAYS       = parseInt(process.env.MEDIA_GRACE_DAYS || '30', 10);
const WARN_NOTICE_DAYS = parseInt(process.env.MEDIA_WARN_NOTICE_DAYS || '7', 10); // min days between warning email and deletion
const MAX_PER_RUN      = parseInt(process.env.MEDIA_CLEANUP_MAX_PER_RUN || '500', 10);
const DAY_MS = 86400000;

// Latest paid-period end + whether any paid access is still active right now,
// looking at BOTH the embedded user.subscription and the Subscription collection.
function accessState(user, subsByUser, now) {
  const ends = [];
  let activeNow = false;

  const emb = user.subscription;
  if (emb?.endDate) ends.push(new Date(emb.endDate));
  if (emb?.status === 'active' && emb.endDate && new Date(emb.endDate) >= now) activeNow = true;

  for (const s of (subsByUser.get(String(user._id)) || [])) {
    if (s.endDate) ends.push(new Date(s.endDate));
    if (s.status === 'active' && s.endDate && new Date(s.endDate) >= now) activeNow = true;
  }

  const lapsedAt = ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null;
  return { activeNow, lapsedAt, everPaid: ends.length > 0 };
}

export async function runMediaCleanup() {
  const now    = new Date();
  const cutoff = new Date(now.getTime() - GRACE_DAYS * 86400000);

  // Prefilter: anyone over ANY role's free limit has ≥ 3 images (min free is 2),
  // so requiring a 3rd element (index 2) cheaply excludes the vast majority.
  const candidates = await User.find({ 'mediaImages.2': { $exists: true } })
    .select('name email role subscription mediaImages mediaCleanupWarnedAt')
    .limit(MAX_PER_RUN)
    .lean();
  if (!candidates.length) return;

  // One batched lookup of collection-based subscriptions for all candidates.
  const ids = candidates.map((u) => u._id);
  const subs = await Subscription.find({ user: { $in: ids } }).select('user status endDate').lean();
  const subsByUser = new Map();
  for (const s of subs) {
    const k = String(s.user);
    if (!subsByUser.has(k)) subsByUser.set(k, []);
    subsByUser.get(k).push(s);
  }

  let warnedUsers = 0, trimmedUsers = 0, deletedImages = 0;

  for (const user of candidates) {
    const role   = user.role || 'pet_owner';
    const images = (user.mediaImages || []).filter((m) => m && m.url);

    const { activeNow, lapsedAt, everPaid } = accessState(user, subsByUser, now);

    // The most this account may hold right now.
    const plan = activeNow ? (user.subscription?.plan || 'free') : 'free';
    const currentMax = getLimitsForUser(role, plan).maxImages;

    const eligible = images.length > currentMax && !activeNow && everPaid && lapsedAt && lapsedAt < cutoff;
    if (!eligible) {
      // Recovered (renewed or back within limit) — clear any pending warning.
      if (user.mediaCleanupWarnedAt) {
        await User.updateOne({ _id: user._id }, { $set: { mediaCleanupWarnedAt: null } });
      }
      continue;
    }

    const keep   = freeLimitFor(role);
    const remove = images.slice(keep);
    if (!remove.length) continue;

    // Phase 1 — WARN once, then wait. Never delete in the same run as the warning.
    if (!user.mediaCleanupWarnedAt) {
      const removalDate = new Date(now.getTime() + WARN_NOTICE_DAYS * DAY_MS);
      if (user.email) {
        try { await sendMediaCleanupWarning(user.name, user.email, remove.length, keep, removalDate); }
        catch (e) { logger.warn('mediaCleanup: warning email failed', { user: String(user._id), error: e.message }); }
      }
      await User.updateOne({ _id: user._id }, { $set: { mediaCleanupWarnedAt: now } });
      warnedUsers++;
      continue;
    }

    // Phase 2 — DELETE only once the warning notice period has also elapsed.
    if (now.getTime() - new Date(user.mediaCleanupWarnedAt).getTime() < WARN_NOTICE_DAYS * DAY_MS) continue;

    const kept = images.slice(0, keep);
    for (const img of remove) {
      try { await deleteFromCloudinary(img.publicId || img.url); deletedImages++; }
      catch (e) { logger.warn('mediaCleanup: Cloudinary delete failed', { user: String(user._id), error: e.message }); }
    }
    await User.updateOne({ _id: user._id }, { $set: { mediaImages: kept, mediaCleanupWarnedAt: null } });
    trimmedUsers++;
    logger.info('mediaCleanup: trimmed lapsed account', {
      user: String(user._id), role, kept: kept.length, removed: remove.length,
      lapsedAt: lapsedAt.toISOString(),
    });
  }

  if (warnedUsers || trimmedUsers) {
    logger.info('Media cleanup done', { warnedUsers, trimmedUsers, deletedImages, graceDays: GRACE_DAYS });
  }
}

export default function startMediaCleanupJob() {
  // Daily at 03:10 UTC (04:10 WAT) — off-peak, after the market cleanup.
  cron.schedule('10 3 * * *', async () => {
    try { await runMediaCleanup(); }
    catch (err) { logger.error('Media cleanup cron error', { error: err.message }); }
  });
  logger.info(`⏰ Media cleanup job scheduled (daily 03:10 UTC, grace ${GRACE_DAYS}d).`);
}
