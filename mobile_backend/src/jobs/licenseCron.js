import cron from 'node-cron';
import User from '../models/User.js';
import Subscription from '../models/Subscription.js';

/**
 * Daily cron: runs at 00:00 WAT (UTC+1 → 23:00 UTC previous day)
 *
 * Order of operations:
 * 1. Expire vet licences past their expiry date.
 * 2. Expire active subscriptions past their end date.
 * 3. Unverify professionals whose subscription is now 'expired'
 *    (join via userId on the Subscription collection — NOT arrayFilters,
 *    which only works on embedded arrays, not a separate collection).
 */
const startLicenseCheckJob = () => {
  // '0 23 * * *' = 23:00 UTC = 00:00 WAT (UTC+1)
  cron.schedule('0 23 * * *', async () => {
    console.log('--- Running Daily License & Subscription Expiry Check ---');

    try {
      const today = new Date();

      // ── 1. Expire vet licences ───────────────────────────────────────────────
      const licenseResult = await User.updateMany(
        {
          role:                        'vet',
          isVerified:                  true,
          'vetDetails.licenseExpiry':  { $lte: today },
        },
        { $set: { isVerified: false } },
      );

      console.log(`  🔒 ${licenseResult.modifiedCount} vet licence(s) expired.`);

      // ── 2. Expire active subscriptions ──────────────────────────────────────
      const subResult = await Subscription.updateMany(
        { status: 'active', endDate: { $lte: today } },
        { $set: { status: 'expired' } },
      );

      console.log(`  📋 ${subResult.modifiedCount} subscription(s) expired.`);

      // ── 3. Unverify professionals with no remaining active subscription ─────
      // Strategy:
      //   a) Find user IDs that still have at least one active subscription.
      //   b) Unverify all professionals whose ID is NOT in that set.
      //
      // This replaces the original (broken) arrayFilters approach, which used
      // $arrayFilters on a top-level field — arrayFilters only works for
      // updates targeting elements inside embedded arrays, not a separate
      // Subscription collection. As written, the original query was unverifying
      // ALL verified vets/kennel owners on every run.

      const activeSubscriptions = await Subscription.find(
        { status: 'active' },
        { user: 1, _id: 0 },
      ).lean();

      const userIdsWithActiveSub = activeSubscriptions.map((s) =>
        s.user.toString(),
      );

      const deactivateResult = await User.updateMany(
        {
          role:       { $in: ['vet', 'kennel_owner'] },
          isVerified: true,
          // Only deactivate if they have NO active subscription
          _id:        { $nin: userIdsWithActiveSub },
        },
        { $set: { isVerified: false } },
      );

      console.log(
        `  🚫 ${deactivateResult.modifiedCount} professional(s) unverified due to expired/missing subscription.`,
      );

      console.log(
        `✅ Daily job complete: ${licenseResult.modifiedCount} licence(s), ` +
        `${subResult.modifiedCount} subscription(s), ` +
        `${deactivateResult.modifiedCount} user(s) deactivated.`,
      );
    } catch (error) {
      console.error('❌ Cron Job Error:', error);
    }
  });

  console.log('⏰ Daily licence & subscription check scheduled (23:00 UTC / 00:00 WAT).');
};

export default startLicenseCheckJob;