import webpush from 'web-push';
import User from '../models/User.js';
import logger from '../lib/logger.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// ─────────────────────────────────────────────────────────────────────────────
// Native (iOS/Android) — via Expo's push relay, ExponentPushToken[...]
// ─────────────────────────────────────────────────────────────────────────────

export const sendPushNotification = async (expoPushToken, title, body, data = {}) => {
  if (!expoPushToken || !expoPushToken.startsWith('ExponentPushToken[')) return;

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to:    expoPushToken,
        sound: 'default',
        title,
        body,
        data,
        badge: 1,
      }),
    });
    const result = await response.json();
    if (result.data?.status === 'error') {
      console.error('[Push] Expo error:', result.data.message);
    }
  } catch (err) {
    console.error('[Push] Failed to send:', err.message);
  }
};

const EXPO_BATCH_LIMIT = 100; // Expo's push API accepts up to 100 messages per request

/**
 * Sends many Expo (native) notifications in one go — used for admin
 * segment/broadcast sends (see services/adminNotification.service.js), where
 * firing one HTTP request per recipient would be needlessly slow. Expo's
 * push endpoint accepts an array body natively, so this chunks into batches
 * of 100 and reports per-message success/failure back via Expo's delivery
 * "tickets".
 *
 * @param {{ to: string, title: string, body: string, data?: object }[]} messages
 * @returns {Promise<{ sent: number, errors: { to: string, message: string }[] }>}
 */
export const sendPushBatch = async (messages) => {
  const valid = messages.filter((m) => m.to?.startsWith('ExponentPushToken['));
  if (!valid.length) return { sent: 0, errors: [] };

  let sent = 0;
  const errors = [];

  for (let i = 0; i < valid.length; i += EXPO_BATCH_LIMIT) {
    const chunk = valid.slice(i, i + EXPO_BATCH_LIMIT);
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chunk.map((m) => ({
          to:    m.to,
          sound: 'default',
          title: m.title,
          body:  m.body,
          data:  m.data || {},
          badge: 1,
        }))),
      });
      const result = await response.json();
      const tickets = Array.isArray(result.data) ? result.data : [];
      // Expo returns one ticket per message, in the same order as sent.
      chunk.forEach((m, idx) => {
        const ticket = tickets[idx];
        if (ticket?.status === 'error') {
          errors.push({ to: m.to, message: ticket.message || 'Unknown Expo error' });
        } else {
          sent++;
        }
      });
    } catch (err) {
      chunk.forEach((m) => errors.push({ to: m.to, message: err.message }));
    }
  }

  return { sent, errors };
};

// ─────────────────────────────────────────────────────────────────────────────
// Web (browser) — standards-based Web Push, sent directly (NOT through Expo's
// relay — confirmed against the live API that it rejects type:"web" outright,
// only apns/fcm/gcm are accepted). Needs our own VAPID key pair, independent
// of the Firebase Web Push certificate (Firebase never exposes its private
// half for use outside its own FCM flow) — see docs/push-notifications or
// memory for how these were generated.
// ─────────────────────────────────────────────────────────────────────────────

const VAPID_PUBLIC_KEY  = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
const VAPID_CONTACT     = process.env.WEB_PUSH_CONTACT_EMAIL || 'mailto:support@xpressvetmarketplace.com';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[Push][Web] WEB_PUSH_VAPID_PUBLIC_KEY / WEB_PUSH_VAPID_PRIVATE_KEY not set — web push disabled.');
}

function isValidWebSubscription(sub) {
  return !!(sub?.endpoint && sub?.keys?.p256dh && sub?.keys?.auth);
}

/**
 * Sends one Web Push message directly to a browser's push subscription.
 * On 404/410 (subscription gone — user revoked permission, browser data
 * cleared, etc.) the caller should drop it; this reports that back via the
 * `expired` flag rather than throwing, since it's an expected steady-state
 * occurrence, not a real failure.
 */
export const sendWebPushNotification = async (subscription, title, body, data = {}) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { ok: false, expired: false };
  if (!isValidWebSubscription(subscription)) return { ok: false, expired: false };

  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body, data }));
    return { ok: true, expired: false };
  } catch (err) {
    const expired = err.statusCode === 404 || err.statusCode === 410;
    if (!expired) {
      logger.error('[Push][Web] send failed', { statusCode: err.statusCode, error: err.message });
    }
    return { ok: false, expired };
  }
};

/**
 * Batch counterpart to sendPushBatch, for the web channel. web-push has no
 * native batch endpoint (each subscription is its own destination push
 * service), so this just fans out sendWebPushNotification concurrently.
 * Returns expiredEndpoints too, so the caller (adminNotification.service.js)
 * can clear dead subscriptions off the affected User docs.
 *
 * @param {{ subscription: object, userId: string, title: string, body: string, data?: object }[]} items
 */
export const sendWebPushBatch = async (items) => {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { sent: 0, errors: [], expiredUserIds: [] };

  let sent = 0;
  const errors = [];
  const expiredUserIds = [];

  const results = await Promise.all(
    items.map((item) => sendWebPushNotification(item.subscription, item.title, item.body, item.data)),
  );

  results.forEach((result, idx) => {
    if (result.ok) {
      sent++;
    } else if (result.expired) {
      expiredUserIds.push(items[idx].userId);
    } else {
      errors.push({ to: items[idx].userId, message: 'Web push send failed' });
    }
  });

  return { sent, errors, expiredUserIds };
};

// ─────────────────────────────────────────────────────────────────────────────
// Unified single-user helper — used by every ad-hoc trigger point (messages,
// reviews, wallet, market, etc.). Sends over whichever channel(s) the user
// has registered; a user signed in on both a phone and a browser gets both.
// ─────────────────────────────────────────────────────────────────────────────

export const sendPushToUser = async (userId, title, body, data = {}) => {
  try {
    const user = await User.findById(userId).select('pushToken webPushSubscription').lean();
    if (!user) return;

    const jobs = [];
    if (user.pushToken) {
      jobs.push(sendPushNotification(user.pushToken, title, body, data));
    }
    if (isValidWebSubscription(user.webPushSubscription)) {
      jobs.push(
        sendWebPushNotification(user.webPushSubscription, title, body, data).then((result) => {
          if (result.expired) {
            return User.findByIdAndUpdate(userId, { $set: { webPushSubscription: { endpoint: null, keys: {} } } });
          }
        }),
      );
    }
    await Promise.all(jobs);
  } catch (err) {
    console.error('[Push] sendPushToUser error:', err.message);
  }
};
