/**
 * Auto-renew job — runs alongside subscriptionReminders.js and licenseCron.js
 *
 * Charges the saved Paystack card (authorization_code) for any subscription
 * that opted into auto-renew and expires today, BEFORE licenseCron.js's
 * 23:00 UTC sweep would otherwise flip it to 'expired'.
 *
 * On success: extends endDate by 1 month from the OLD endDate (keeps the
 * billing anchor date stable instead of drifting to "now").
 * On failure: disables autoRenew (no silent retries) and falls back to the
 * existing manual-renewal email/push flow.
 */

import cron    from 'node-cron';
import axios   from 'axios';
import User         from '../models/User.js';
import Subscription from '../models/Subscription.js';
import {
  sendAutoRenewSucceeded,
  sendAutoRenewFailed,
} from '../services/email.service.js';
import { sendPushToUser } from '../services/pushNotification.service.js';
import { logActivity }    from '../lib/activityLogger.js';
import logger from '../lib/logger.js';

const PAYSTACK_BASE   = process.env.PAYSTACK_BASE       || 'https://api.paystack.co';
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';

/** End of "today" in UTC — matches the dayWindow(0) pattern used elsewhere for expiry jobs */
function endOfToday() {
  const d = new Date();
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

async function chargeAuthorization({ authorizationCode, email, amount }) {
  const res = await axios.post(
    `${PAYSTACK_BASE}/transaction/charge_authorization`,
    { authorization_code: authorizationCode, email, amount: amount * 100, currency: 'NGN' },
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' } },
  );
  const { data } = res;
  if (!data?.status || data?.data?.status !== 'success') {
    throw new Error(data?.data?.gateway_response || data?.message || 'Charge declined');
  }
  return data.data; // { reference, authorization: {...}, ... }
}

async function runAutoRenewProfessional() {
  const due = await Subscription.find({
    status:    'active',
    autoRenew: true,
    authorizationCode: { $ne: null },
    endDate:   { $lte: endOfToday() },
  }).populate('user', 'name email role');

  let renewed = 0, failed = 0;

  for (const sub of due) {
    if (!sub.user?.email) continue;
    try {
      const chargeData = await chargeAuthorization({
        authorizationCode: sub.authorizationCode,
        email:  sub.user.email,
        amount: sub.amount,
      });

      const newEnd = new Date(sub.endDate);
      newEnd.setMonth(newEnd.getMonth() + 1);

      sub.status                 = 'active';
      sub.endDate                = newEnd;
      sub.paymentReference       = chargeData.reference;
      sub.autoRenewFailCount     = 0;
      sub.lastAutoRenewAttemptAt = new Date();
      if (chargeData.authorization?.reusable && chargeData.authorization?.authorization_code) {
        sub.authorizationCode = chargeData.authorization.authorization_code;
        sub.cardLast4         = chargeData.authorization.last4;
        sub.cardBrand         = chargeData.authorization.card_type;
      }
      await sub.save();

      logActivity(sub.user._id, sub.user.role, 'subscription.auto_renewed', { plan: sub.plan, amount: sub.amount, userType: 'professional' });
      sendAutoRenewSucceeded(sub.user.name, sub.user.email, sub.plan, sub.amount, newEnd, true).catch(() => {});
      sendPushToUser(sub.user._id, 'Subscription renewed 🔄', `Your ${sub.plan} plan auto-renewed for another month.`, { type: 'subscription_auto_renewed' }).catch(() => {});
      renewed++;
    } catch (err) {
      sub.autoRenew              = false;
      sub.autoRenewFailCount     = (sub.autoRenewFailCount || 0) + 1;
      sub.lastAutoRenewAttemptAt = new Date();
      await sub.save();

      logger.error('Auto-renew charge failed (professional)', { subscriptionId: sub._id, error: err.message });
      sendAutoRenewFailed(sub.user.name, sub.user.email, sub.plan, true).catch(() => {});
      sendPushToUser(sub.user._id, 'Auto-renewal failed ⚠️', `We couldn't renew your ${sub.plan} plan. Renew manually to stay listed.`, { type: 'subscription_auto_renew_failed' }).catch(() => {});
      failed++;
    }
  }

  return { renewed, failed };
}

async function runAutoRenewUsers() {
  const due = await User.find({
    'subscription.status':             'active',
    'subscription.autoRenew':          true,
    'subscription.authorizationCode':  { $ne: null },
    'subscription.endDate':            { $lte: endOfToday() },
  });

  let renewed = 0, failed = 0;

  for (const user of due) {
    if (!user.email) continue;
    const sub = user.subscription;
    try {
      const chargeData = await chargeAuthorization({
        authorizationCode: sub.authorizationCode,
        email:  user.email,
        amount: sub.amount,
      });

      const newEnd = new Date(sub.endDate);
      newEnd.setMonth(newEnd.getMonth() + 1);

      user.subscription.status                 = 'active';
      user.subscription.endDate                = newEnd;
      user.subscription.paymentReference       = chargeData.reference;
      user.subscription.autoRenewFailCount     = 0;
      user.subscription.lastAutoRenewAttemptAt = new Date();
      if (chargeData.authorization?.reusable && chargeData.authorization?.authorization_code) {
        user.subscription.authorizationCode = chargeData.authorization.authorization_code;
        user.subscription.cardLast4         = chargeData.authorization.last4;
        user.subscription.cardBrand         = chargeData.authorization.card_type;
      }
      await user.save();

      logActivity(user._id, user.role, 'subscription.auto_renewed', { plan: sub.plan, amount: sub.amount, userType: 'user' });
      sendAutoRenewSucceeded(user.name, user.email, sub.plan, sub.amount, newEnd, false).catch(() => {});
      sendPushToUser(user._id, 'Subscription renewed 🔄', `Your ${sub.plan} plan auto-renewed for another month.`, { type: 'subscription_auto_renewed' }).catch(() => {});
      renewed++;
    } catch (err) {
      user.subscription.autoRenew              = false;
      user.subscription.autoRenewFailCount     = (sub.autoRenewFailCount || 0) + 1;
      user.subscription.lastAutoRenewAttemptAt = new Date();
      await user.save();

      logger.error('Auto-renew charge failed (pet owner)', { userId: user._id, error: err.message });
      sendAutoRenewFailed(user.name, user.email, sub.plan, false).catch(() => {});
      sendPushToUser(user._id, 'Auto-renewal failed ⚠️', `We couldn't renew your subscription. Renew manually to keep full access.`, { type: 'subscription_auto_renew_failed' }).catch(() => {});
      failed++;
    }
  }

  return { renewed, failed };
}

export default function startAutoRenewJob() {
  if (!PAYSTACK_SECRET) {
    logger.warn('Auto-renew job not scheduled — PAYSTACK_SECRET_KEY not set.');
    return;
  }

  // 22:00 UTC (23:00 WAT) — one hour before licenseCron.js flips expired
  // subscriptions, so a successful auto-renew always wins the race.
  cron.schedule('0 22 * * *', async () => {
    logger.info('--- Running Auto-Renew Subscriptions ---');
    try {
      const [pro, users] = await Promise.all([runAutoRenewProfessional(), runAutoRenewUsers()]);
      logger.info(`Auto-renew complete: professional ${pro.renewed} renewed / ${pro.failed} failed, pet owner ${users.renewed} renewed / ${users.failed} failed.`);
    } catch (err) {
      logger.error('Auto-renew cron error', { error: err.message });
    }
  });

  logger.info('⏰ Auto-renew subscriptions job scheduled (22:00 UTC / 23:00 WAT).');
}
