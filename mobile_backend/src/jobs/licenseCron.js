import cron from 'node-cron';
import User from '../models/User.js';
import Subscription from '../models/Subscription.js';

// Scheduled to run every day at 00:00 (Midnight WAT)
const startLicenseCheckJob = () => {
  cron.schedule('0 0 * * *', async () => {
    console.log('--- Running Daily License & Subscription Expiry Check ---');

    try {
      const today = new Date();

      // Check vet licenses
      const licenseResult = await User.updateMany(
        {
          role: 'vet',
          isVerified: true,
          'vetDetails.licenseExpiry': { $lte: today }
        },
        {
          $set: { isVerified: false }
        }
      );

      // Check subscriptions
      const subResult = await Subscription.updateMany(
        {
          status: 'active',
          endDate: { $lte: today }
        },
        {
          $set: { status: 'expired' }
        }
      );

      // Deactivate users with expired subscriptions
      await User.updateMany(
        {
          role: { $in: ['vet', 'kennel_owner'] },
          isVerified: true
        },
        {
          $set: { isVerified: false }
        },
        {
          arrayFilters: [
            {
              'subscriptions.status': 'expired'
            }
          ]
        }
      );

      console.log(`✅ Job Complete: ${licenseResult.modifiedCount} licenses expired, ${subResult.modifiedCount} subscriptions expired.`);
    } catch (error) {
      console.error('❌ Cron Job Error:', error);
    }
  });
};

export default startLicenseCheckJob;