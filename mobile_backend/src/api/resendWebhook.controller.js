/**
 * resendWebhook.controller.js
 *
 * Delivery/open/click/bounce tracking for outbound email — the "who is
 * clicking" counterpart to push notifications, but for email (see
 * services/email.service.js, which captures the resendEmailId this
 * correlates back to on send).
 *
 * Mounted with express.raw() BEFORE express.json() in app.js (same pattern
 * as the Paystack webhook) — signature verification needs the exact raw
 * bytes Resend signed, not a re-serialized JSON.parse() round-trip.
 *
 * Setup (one-time, in Resend's dashboard): Settings → Webhooks → Add
 * Endpoint → https://<backend host>/api/webhooks/resend, select the
 * email.* events. Resend then generates a signing secret (starts
 * "whsec_") — set that as RESEND_WEBHOOK_SECRET on Render. Until that's
 * set, this endpoint just 200s and logs a warning, so a misconfigured
 * webhook can't pile up retries.
 */

import { Webhook } from 'svix';
import EmailLog from '../models/EmailLog.js';
import logger from '../lib/logger.js';

const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

export const handleResendWebhook = async (req, res) => {
  if (!RESEND_WEBHOOK_SECRET) {
    logger.warn('Resend webhook received but RESEND_WEBHOOK_SECRET is not set — ignoring.');
    return res.status(200).send('ok'); // 200 so Resend doesn't retry forever
  }

  let event;
  try {
    const wh = new Webhook(RESEND_WEBHOOK_SECRET);
    event = wh.verify(req.body, {
      'svix-id':        req.headers['svix-id'],
      'svix-timestamp': req.headers['svix-timestamp'],
      'svix-signature': req.headers['svix-signature'],
    });
  } catch (err) {
    logger.error('Resend webhook signature verification failed', { error: err.message });
    return res.status(400).json({ success: false, message: 'Invalid signature.' });
  }

  try {
    const emailId = event?.data?.email_id;
    if (!emailId) return res.status(200).send('ok');

    const now = new Date();

    switch (event.type) {
      case 'email.delivered':
        await EmailLog.updateOne({ resendEmailId: emailId }, { $set: { deliveredAt: now } });
        break;

      case 'email.opened':
        await Promise.all([
          EmailLog.updateOne({ resendEmailId: emailId }, { $inc: { openCount: 1 } }),
          // Guarded by openedAt:null in the filter itself, so only the
          // first open sets it — later opens just bump openCount above.
          EmailLog.updateOne({ resendEmailId: emailId, openedAt: null }, { $set: { openedAt: now } }),
        ]);
        break;

      case 'email.clicked': {
        const link = event.data?.click?.link || null;
        await Promise.all([
          EmailLog.updateOne({ resendEmailId: emailId }, { $inc: { clickCount: 1 }, $set: { lastClickUrl: link } }),
          EmailLog.updateOne({ resendEmailId: emailId, clickedAt: null }, { $set: { clickedAt: now } }),
        ]);
        break;
      }

      case 'email.bounced':
        await EmailLog.updateOne(
          { resendEmailId: emailId },
          { $set: { bouncedAt: now, bounceReason: event.data?.bounce?.message || event.data?.bounce?.type || null } },
        );
        break;

      case 'email.complained':
        await EmailLog.updateOne({ resendEmailId: emailId }, { $set: { complainedAt: now } });
        break;

      default:
        // email.sent, email.delivery_delayed, etc. — nothing to record beyond
        // the initial EmailLog row already written at send time.
        break;
    }

    return res.status(200).send('ok');
  } catch (err) {
    logger.error('Resend webhook processing error', { error: err.message });
    // Still 200 — a processing bug on our end shouldn't make Resend hammer
    // retries for an event we've already durably received.
    return res.status(200).send('ok');
  }
};
