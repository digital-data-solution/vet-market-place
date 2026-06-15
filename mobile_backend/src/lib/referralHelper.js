import User         from '../models/User.js';
import Subscription from '../models/Subscription.js';
import logger       from './logger.js';
import { sendReferralRewardEmail } from '../services/email.service.js';

/**
 * Extend the referrer's active subscription by bonusDays and increment their
 * referralRewardsEarned count. Sets referralRewardApplied = true on the referred
 * user so this runs exactly once.
 *
 * referralRewardsEarned is ALWAYS incremented — even if the referrer has no active
 * subscription — so the admin dashboard accurately reflects earned rewards regardless
 * of subscription status.
 *
 * Safe to call fire-and-forget (.catch(() => {})) — all errors are swallowed
 * after logging so they never surface to the caller.
 */
export async function applyReferralReward(referredUser, bonusDays) {
  try {
    const referrer = await User.findOne({ referralCode: referredUser.referredBy });
    if (!referrer) return;

    // Prefer professional subscription (separate Subscription collection) if active
    const proSub = await Subscription.findOne({
      user:    referrer._id,
      status:  'active',
      endDate: { $gte: new Date() },
    });

    if (proSub) {
      proSub.endDate = new Date(proSub.endDate.getTime() + bonusDays * 24 * 60 * 60 * 1000);
      await proSub.save();
    } else if (referrer.subscription?.status === 'active' && referrer.subscription?.endDate) {
      const currentEnd = new Date(referrer.subscription.endDate);
      referrer.subscription.endDate = new Date(currentEnd.getTime() + bonusDays * 24 * 60 * 60 * 1000);
      referrer.markModified('subscription');
    }

    // Always increment — even if referrer has no subscription yet
    referrer.referralRewardsEarned = (referrer.referralRewardsEarned || 0) + 1;
    await referrer.save({ validateBeforeSave: false });

    referredUser.referralRewardApplied = true;
    await referredUser.save({ validateBeforeSave: false });

    // Notify referrer by email
    if (referrer.email) {
      sendReferralRewardEmail(referrer.name, referrer.email, bonusDays).catch(() => {});
    }

    logger.info('Referral reward applied', {
      referredUserId: referredUser._id,
      referrerId:     referrer._id,
      bonusDays,
    });
  } catch (err) {
    logger.warn('Referral reward application failed', { error: err.message });
  }
}
