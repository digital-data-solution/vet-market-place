/**
 * Email Service — supports Resend and Brevo (Sendinblue)
 *
 * Configure via environment variables:
 *   RESEND_API_KEY  → uses Resend (resend.com)
 *   BREVO_API_KEY   → uses Brevo (brevo.com)
 *   EMAIL_FROM      → sender address, e.g. "Xpress Vet <noreply@xpressvetmarketplace.com>"
 *
 * Both can be set at once. sendEmail() doesn't send synchronously — it
 * writes a row to EmailQueue (models/EmailQueue.js) and jobs/
 * emailQueueWorker.js drains it every minute, trying every configured
 * provider in order before giving up on that pass. That gives two things
 * for free: (1) automatic failover — if Resend is down or rate-limited,
 * Brevo picks up the send within the same minute, and vice versa; (2) a
 * durable retry — a row survives a dyno restart mid-send, unlike an
 * in-memory queue, because Mongo (not Redis, which has been unreliable on
 * this project — see the known-gotchas memory note) backs it.
 *
 * A call-site can pin a preferred provider via the 4th-arg options:
 * sendEmail(to, subject, html, text, { provider: 'brevo' }) — the worker
 * still falls back to the other provider if the preferred one fails, this
 * only sets *order*, not an exclusive choice. Xpress Market/Pet Mart
 * listing mail is pinned to Brevo deliberately (2026-08-20) to keep that
 * higher-volume traffic off the Resend domain the lower-volume
 * cold-outreach work depends on for its sender reputation — see the
 * Xpress Vet clinic outreach memory note for the full reasoning.
 *
 * If neither key is set, sends are logged as 'skipped' immediately (no
 * queue row created) so the app works correctly in dev without credentials.
 *
 * Delivery/open/click tracking (Resend only) lives in routes/webhooks.routes.js
 * — it correlates back to EmailLog via the resendEmailId captured here.
 */

import fetch from 'node-fetch';
import crypto from 'crypto';
import logger from '../lib/logger.js';
import EmailLog from '../models/EmailLog.js';
import EmailQueue from '../models/EmailQueue.js';

const FROM    = process.env.EMAIL_FROM    || 'Xpress Vet <noreply@xpressvetmarketplace.com>';
const RESEND  = process.env.RESEND_API_KEY;
const BREVO   = process.env.BREVO_API_KEY;
const APP_URL = process.env.BACKEND_URL    || 'https://vet-market-place-jsj5.onrender.com';
const UNSUB_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-env';

// ─────────────────────────────────────────────────────────────────────────────
// UNSUBSCRIBE — signed, stateless one-click link. No token stored on the
// user; the signature is an HMAC of the user id, so any marketing email can
// generate a working unsubscribe link without a DB write or lookup table.
// ─────────────────────────────────────────────────────────────────────────────
export function unsubscribeUrl(userId) {
  if (!userId) return null;
  const uid = userId.toString();
  const sig = crypto.createHmac('sha256', UNSUB_SECRET).update(uid).digest('hex').slice(0, 32);
  return `${APP_URL}/api/email/unsubscribe?uid=${uid}&sig=${sig}`;
}

export function verifyUnsubscribeSig(uid, sig) {
  if (!uid || !sig) return false;
  const expected = crypto.createHmac('sha256', UNSUB_SECRET).update(uid.toString()).digest('hex').slice(0, 32);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false; // length mismatch etc.
  }
}

// Same pattern, separate namespace ('client:' prefix) so a Client._id and a
// User._id can never produce a colliding signature.
export function clientReminderUnsubscribeUrl(clientId) {
  if (!clientId) return null;
  const cid = clientId.toString();
  const sig = crypto.createHmac('sha256', UNSUB_SECRET).update(`client:${cid}`).digest('hex').slice(0, 32);
  return `${APP_URL}/api/email/client-unsubscribe?cid=${cid}&sig=${sig}`;
}

export function verifyClientReminderSig(cid, sig) {
  if (!cid || !sig) return false;
  const expected = crypto.createHmac('sha256', UNSUB_SECRET).update(`client:${cid.toString()}`).digest('hex').slice(0, 32);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE SEND — enqueue here, jobs/emailQueueWorker.js does the actual sending.
//
// sendEmail() no longer calls a provider directly. It writes a row to
// EmailQueue and returns immediately (still async/non-throwing, so every
// existing call site — 60+ of them — keeps working unchanged). The worker
// polls every minute, and for each due row tries EVERY configured provider
// in preference order before giving up on that pass — so a Resend outage or
// exhausted quota fails over to Brevo (and vice versa) automatically, within
// the same minute, not after a human notices. Only once every configured
// provider has failed on a pass does the row back off and wait for the next
// one; it's marked permanently 'failed' only after maxAttempts full passes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sendEmail — provider-agnostic, queued send.
 * @param {string}   to       Recipient address
 * @param {string}   subject  Email subject
 * @param {string}   html     HTML body
 * @param {string}   [text]   Plain-text fallback (auto-generated if omitted)
 * @param {object}   [opts]
 * @param {string}   [opts.provider] 'resend' | 'brevo' — preferred provider;
 *   the worker still falls back to the other one if this fails. Omit for no
 *   preference (worker tries Resend first, matching the pre-queue default).
 */
export async function sendEmail(to, subject, html, text, { provider } = {}) {
  if (!to || !subject || !html) {
    logger.warn('sendEmail called with missing args', { to, subject });
    return;
  }

  if (!RESEND && !BREVO) {
    // Nothing could ever send this — log it as skipped now rather than
    // queue a row that would just sit there forever.
    logger.info(`[EMAIL SKIP] To: ${to} | Subject: ${subject} (no provider key set)`);
    EmailLog.create({ to, subject, status: 'skipped' }).catch(() => {});
    return;
  }

  const plainText = text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  try {
    await EmailQueue.create({ to, subject, html, text: plainText, preferredProvider: provider || null });
  } catch (err) {
    // Enqueue failure (e.g. DB hiccup) — never throw into the caller.
    logger.error('Email enqueue failed', { to, subject, error: err.message });
  }
}

// Backoff between full passes (each pass already tried every configured
// provider) — attempt 1 fails → retry in 2 min, then 10 min, 30 min, 2 hr,
// and the 5th failure (maxAttempts) marks the row permanently failed.
const BACKOFF_MINUTES = [2, 10, 30, 120];

// One row's worth of work: try every configured provider, in preference
// order, until one succeeds. Exported for jobs/emailQueueWorker.js — kept
// here rather than in the job file so the provider dispatch/error-shaping
// logic lives next to sendViaResend/sendViaBrevo instead of being
// duplicated or reached into from outside the module.
export async function processQueuedEmail(doc) {
  const order = (doc.preferredProvider === 'brevo' ? ['brevo', 'resend'] : ['resend', 'brevo'])
    .filter((p) => (p === 'resend' ? RESEND : BREVO));

  const attemptErrors = { resend: null, brevo: null };
  for (const providerName of order) {
    try {
      const result = providerName === 'resend'
        ? await sendViaResend(doc.to, doc.subject, doc.html, doc.text)
        : await sendViaBrevo(doc.to, doc.subject, doc.html, doc.text);
      logger.info('Email sent', { to: doc.to, subject: doc.subject, provider: providerName, afterFallback: providerName !== order[0] });
      return { ok: true, providerUsed: providerName, resendEmailId: providerName === 'resend' ? result : null };
    } catch (err) {
      attemptErrors[providerName] = err.message;
      logger.warn('Email provider attempt failed, trying next', {
        to: doc.to, subject: doc.subject, provider: providerName,
        status: err.status || null, error: err.message,
      });
    }
  }

  return { ok: false, attemptErrors };
}

export function nextBackoffAt(attempts) {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] || BACKOFF_MINUTES.at(-1);
  return new Date(Date.now() + minutes * 60 * 1000);
}

// Returns Resend's message id (used later to correlate delivery/open/click
// webhook events back to this send — see routes/webhooks.routes.js).
async function sendViaResend(to, subject, html, text) {
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${RESEND}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Resend error ${res.status}: ${body}`);
    err.status = res.status; // 429 = rate-limited/quota-exhausted — worth telling apart from a hard failure
    throw err;
  }
  const body = await res.json().catch(() => null);
  return body?.id || null;
}

async function sendViaBrevo(to, subject, html, text) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method:  'POST',
    headers: {
      'api-key':      BREVO,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender:      { name: 'Xpress Vet', email: FROM.match(/<(.+)>/)?.[1] || FROM },
      to:          [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Brevo error ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED LAYOUT
// ─────────────────────────────────────────────────────────────────────────────

function layout(title, body, unsubLink) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  body{margin:0;padding:0;background:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}
  .wrap{max-width:560px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);}
  .header{background:#2563EB;padding:28px 32px;text-align:center;}
  .header-logo{font-size:36px;margin-bottom:6px;}
  .header-name{color:#fff;font-size:22px;font-weight:800;letter-spacing:-.3px;}
  .header-tagline{color:#BFDBFE;font-size:13px;margin-top:4px;}
  .body{padding:32px;}
  h1{font-size:20px;font-weight:800;color:#0F172A;margin:0 0 8px;}
  p{font-size:15px;color:#475569;line-height:1.6;margin:0 0 16px;}
  .highlight{background:#EFF6FF;border-left:4px solid #2563EB;border-radius:0 8px 8px 0;padding:14px 18px;margin:18px 0;}
  .highlight p{margin:0;color:#1E40AF;font-weight:600;}
  .btn{display:inline-block;background:#2563EB;color:#fff!important;text-decoration:none;font-weight:700;font-size:15px;padding:13px 28px;border-radius:10px;margin:8px 0 18px;}
  .footer{border-top:1px solid #F1F5F9;padding:20px 32px;text-align:center;}
  .footer p{font-size:12px;color:#94A3B8;margin:0;line-height:1.6;}
  .paw{font-size:18px;}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="header-logo">🐾</div>
    <div class="header-name">Xpress Vet</div>
    <div class="header-tagline">Nigeria's Pet Care Marketplace</div>
  </div>
  <div class="body">${body}</div>
  <div class="footer">
    <p>© ${new Date().getFullYear()} Xpress Vet &nbsp;•&nbsp; Lagos, Nigeria<br/>
    You're receiving this because you have an account on Xpress Vet.<br/>
    <a href="https://xpressvetmarketplace.com/privacy-policy" style="color:#94A3B8;text-decoration:none;">Privacy Policy</a>
    &nbsp;·&nbsp;
    <a href="https://xpressvetmarketplace.com/terms-and-conditions" style="color:#94A3B8;text-decoration:none;">Terms of Service</a><br/>
    Questions? Reply to this email — we're happy to help.${unsubLink ? `<br/>
    <a href="${unsubLink}" style="color:#94A3B8;text-decoration:underline;">Stop receiving these emails</a>` : ''}</p>
  </div>
</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

/** Welcome email sent right after a new user registers */
export async function sendWelcomeEmail(name, email) {
  const firstName = name?.split(' ')[0] || 'there';
  const html = layout('Welcome to Xpress Vet', `
    <h1>Welcome aboard, ${firstName}! 🎉</h1>
    <p>You're now part of Nigeria's growing pet care community. With Xpress Vet you can:</p>
    <ul style="font-size:15px;color:#475569;line-height:2;padding-left:20px;">
      <li>Find verified vets near you in seconds</li>
      <li>Discover trusted kennels for boarding</li>
      <li>Browse pet shops for supplies & food</li>
    </ul>
    <div class="highlight"><p>🆓 Your free account is active right now — no credit card needed.</p></div>
    <p>Upgrade to <strong>Premium (₦1,500/month)</strong> to unlock full contact details, GPS search, and direct access to every professional on the platform.</p>
    <p>We're excited to have you. If you have any questions, just reply to this email.</p>
    <p style="margin-top:24px;">With care,<br/><strong>The Xpress Vet Team</strong> 🐾</p>
  `);
  await sendEmail(email, 'Welcome to Xpress Vet 🐾', html);
}

/** Sent to a pet owner after their subscription payment is confirmed */
export async function sendUserSubscriptionConfirmed(name, email, plan, amount, expiryDate) {
  const firstName  = name?.split(' ')[0] || 'there';
  const planLabel  = 'Premium';
  const expiry     = new Date(expiryDate).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
  const html = layout('Subscription Confirmed', `
    <h1>You're all set, ${firstName}! ✅</h1>
    <p>Your <strong>${planLabel}</strong> subscription is now active. You have full access to all vets, kennels, and pet shops on Xpress Vet.</p>
    <div class="highlight">
      <p>Plan: ${planLabel} &nbsp;|&nbsp; ₦${Number(amount).toLocaleString()}/month<br/>
      Renews on: ${expiry}</p>
    </div>
    <p>You can now:</p>
    <ul style="font-size:15px;color:#475569;line-height:2;padding-left:20px;">
      <li>View full contact details (phone & email)</li>
      <li>Use GPS to find professionals near you</li>
      <li>See exact addresses for every listing</li>
    </ul>
    <p>To manage or cancel your subscription, open the app and go to <strong>Profile → Subscription</strong>.</p>
    <p style="margin-top:24px;">Thank you for supporting Nigerian pet care,<br/><strong>The Xpress Vet Team</strong> 🐾</p>
  `);
  await sendEmail(email, `Your Xpress Vet ${planLabel} subscription is active ✅`, html);
}

/** Sent to a professional after their subscription payment is confirmed */
export async function sendProfessionalSubscriptionConfirmed(name, email, plan, amount, expiryDate) {
  const firstName  = name?.split(' ')[0] || 'there';
  const planLabel  = plan === 'pro' ? 'Pro' : 'Starter';
  const expiry     = new Date(expiryDate).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
  const proNote    = plan === 'pro'
    ? '<li>You appear at the <strong>top of all search results</strong> with a featured badge</li>'
    : '';
  const html = layout('Your Listing is Active', `
    <h1>Your listing is live, ${firstName}! 🏥</h1>
    <p>Your <strong>${planLabel}</strong> plan is active. Pet owners can now find and contact you through Xpress Vet.</p>
    <div class="highlight">
      <p>Plan: ${planLabel} &nbsp;|&nbsp; ₦${Number(amount).toLocaleString()}/month<br/>
      Renews on: ${expiry}</p>
    </div>
    <p>What this means for you:</p>
    <ul style="font-size:15px;color:#475569;line-height:2;padding-left:20px;">
      <li>Your profile is visible to all pet owners in your area</li>
      <li>Premium subscribers can call and email you directly</li>
      <li>You appear in GPS nearby searches</li>
      ${proNote}
    </ul>
    <p>To update your profile or manage your subscription, open the Xpress Vet app and go to <strong>Profile</strong>.</p>
    <p style="margin-top:24px;">Here's to growing your practice,<br/><strong>The Xpress Vet Team</strong> 🐾</p>
  `);
  await sendEmail(email, `Your Xpress Vet ${planLabel} listing is now live 🏥`, html);
}

/** Subscription expiry reminder — sent at 7, 3, and 1 day(s) before expiry */
export async function sendSubscriptionExpiryReminder(name, email, plan, daysLeft, expiryDate, isProfessional) {
  const firstName  = name?.split(' ')[0] || 'there';
  const planLabel  = isProfessional ? (plan === 'pro' ? 'Pro' : 'Starter') : 'Premium';
  const expiry     = new Date(expiryDate).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
  const urgency    = daysLeft === 1 ? '⚠️ Last day!' : daysLeft <= 3 ? '⏰ Expiring soon' : 'Heads up';
  const consequence = isProfessional
    ? 'Your listing will be hidden from search results and pet owners will no longer be able to find you.'
    : 'You will lose access to contact details and GPS search for professionals.';

  const html = layout(`${urgency} — Subscription Expiring`, `
    <h1>${urgency} — Your subscription expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}</h1>
    <p>Hi ${firstName}, your <strong>${planLabel}</strong> subscription expires on <strong>${expiry}</strong>.</p>
    <div class="highlight"><p>⚠️ ${consequence}</p></div>
    <p>Renewing takes less than a minute. Open the app and go to <strong>Profile → Subscription</strong> to renew.</p>
    <p style="margin-top:24px;">See you on the other side,<br/><strong>The Xpress Vet Team</strong> 🐾</p>
  `);
  await sendEmail(email, `${urgency}: Your Xpress Vet ${planLabel} plan expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`, html);
}

/** Sent the day a subscription expires */
export async function sendSubscriptionExpired(name, email, plan, isProfessional) {
  const firstName  = name?.split(' ')[0] || 'there';
  const planLabel  = isProfessional ? (plan === 'pro' ? 'Pro' : 'Starter') : 'Premium';
  const consequence = isProfessional
    ? 'Your listing is now hidden from pet owners.'
    : 'You no longer have access to contact details or GPS search.';

  const html = layout('Subscription Expired', `
    <h1>Your ${planLabel} subscription has expired</h1>
    <p>Hi ${firstName}, your <strong>${planLabel}</strong> plan has ended. ${consequence}</p>
    <p>Renew anytime to restore full access. Your profile and history are saved — nothing is lost.</p>
    <div class="highlight"><p>💡 Renew now and be back live in under a minute.</p></div>
    <p>Open the Xpress Vet app and go to <strong>Profile → Subscription</strong> to renew.</p>
    <p style="margin-top:24px;">We hope to have you back soon,<br/><strong>The Xpress Vet Team</strong> 🐾</p>
  `);
  await sendEmail(email, `Your Xpress Vet ${planLabel} plan has expired`, html);
}

/** Sent when auto-renew successfully charges the saved card */
export async function sendAutoRenewSucceeded(name, email, plan, amount, expiryDate, isProfessional) {
  const firstName = name?.split(' ')[0] || 'there';
  const planLabel = isProfessional ? (plan === 'pro' ? 'Pro' : 'Starter') : (plan === 'user_plus' ? 'Premium Plus' : 'Premium');
  const expiry    = new Date(expiryDate).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
  const html = layout('Subscription Auto-Renewed', `
    <h1>You're covered for another month, ${firstName} 🔄</h1>
    <p>Your <strong>${planLabel}</strong> subscription auto-renewed using your saved card — no action needed.</p>
    <div class="highlight">
      <p>Plan: ${planLabel} &nbsp;|&nbsp; ₦${Number(amount).toLocaleString()}/month<br/>
      Next renewal: ${expiry}</p>
    </div>
    <p>To turn off auto-renew or update your card, open the app and go to <strong>Profile → Subscription</strong>.</p>
    <p style="margin-top:24px;">Thank you for staying with us,<br/><strong>The Xpress Vet Team</strong> 🐾</p>
  `);
  await sendEmail(email, `Auto-renewed: your Xpress Vet ${planLabel} plan`, html);
}

/** Sent when an auto-renew charge attempt fails — auto-renew is switched off so it won't retry silently */
export async function sendAutoRenewFailed(name, email, plan, isProfessional) {
  const firstName  = name?.split(' ')[0] || 'there';
  const planLabel  = isProfessional ? (plan === 'pro' ? 'Pro' : 'Starter') : (plan === 'user_plus' ? 'Premium Plus' : 'Premium');
  const consequence = isProfessional
    ? 'Your listing will be hidden from search results if you don\'t renew today.'
    : 'You will lose access to contact details and GPS search if you don\'t renew today.';

  const html = layout('Auto-Renewal Failed', `
    <h1>We couldn't renew your ${planLabel} plan</h1>
    <p>Hi ${firstName}, your saved card was declined, so your <strong>${planLabel}</strong> subscription did not auto-renew today. We've turned off auto-renew for now so it won't keep retrying.</p>
    <div class="highlight"><p>⚠️ ${consequence}</p></div>
    <p>Open the app and go to <strong>Profile → Subscription</strong> to renew manually — it takes less than a minute.</p>
    <p style="margin-top:24px;">The Xpress Vet Team 🐾</p>
  `);
  await sendEmail(email, `Action needed: your Xpress Vet ${planLabel} plan didn't auto-renew`, html);
}

/**
 * Warns a lapsed member that their EXTRA gallery photos (beyond the free plan)
 * will be removed on `removalDate` unless they renew. Sent once by
 * jobs/mediaCleanup.js before any deletion happens.
 */
export async function sendMediaCleanupWarning(name, email, removeCount, keepCount, removalDate) {
  const firstName = name?.split(' ')[0] || 'there';
  const when = new Date(removalDate).toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });

  const html = layout('Action needed — your extra photos', `
    <h1>⏳ ${removeCount} of your photos will be removed on ${when}</h1>
    <p>Hi ${firstName}, your paid plan has ended, so your gallery is over the free limit.</p>
    <div class="highlight"><p>⚠️ To free up storage, <strong>${removeCount} extra photo${removeCount !== 1 ? 's' : ''}</strong> will be permanently deleted on <strong>${when}</strong>. Your first ${keepCount} photo${keepCount !== 1 ? 's' : ''} will be kept.</p></div>
    <p><strong>Renew before then to keep everything.</strong> Open the Xpress Vet app and go to <strong>Profile → Subscription</strong>.</p>
    <p>If you don't renew, deleted photos can't be recovered — but you can always re-upload after renewing.</p>
    <p style="margin-top:24px;">We'd love to keep you,<br/><strong>The Xpress Vet Team</strong> 🐾</p>
  `);
  await sendEmail(email, `Renew to keep your ${removeCount} extra photo${removeCount !== 1 ? 's' : ''} — removal on ${when}`, html);
}

/** Sent to a vet/professional when admin approves their verification */
export async function sendVerificationApproved(name, email) {
  const firstName = name?.split(' ')[0] || 'there';
  const html = layout('Verification Approved ✅', `
    <h1>Congratulations, ${firstName}! You're verified ✅</h1>
    <p>Your professional credentials have been reviewed and approved. Your profile now shows a <strong>Verified</strong> badge — building trust with every pet owner who sees your listing.</p>
    <div class="highlight"><p>✅ Verified badge is now showing on your public profile.</p></div>
    <p>Pet owners on Xpress Vet specifically look for verified professionals. Your verification helps you stand out and win more clients.</p>
    <p style="margin-top:24px;">Keep up the great work,<br/><strong>The Xpress Vet Team</strong> 🐾</p>
  `);
  await sendEmail(email, 'Your Xpress Vet verification is approved ✅', html);
}

/** Sent to a vet/professional when admin rejects their verification */
export async function sendVerificationRejected(name, email, reason) {
  const firstName = name?.split(' ')[0] || 'there';
  const html = layout('Verification Update', `
    <h1>Verification Update, ${firstName}</h1>
    <p>We reviewed your professional credentials and need a little more information before we can verify your account.</p>
    ${reason ? `<div class="highlight"><p>📋 Reason: ${reason}</p></div>` : ''}
    <p>You can re-submit your documents through the app: go to <strong>Profile → Verification Status</strong> and upload the required documents.</p>
    <p>If you have questions about what's needed, reply to this email and our team will help you.</p>
    <p style="margin-top:24px;">We look forward to getting you verified,<br/><strong>The Xpress Vet Team</strong> 🐾</p>
  `);
  await sendEmail(email, 'Action needed: Xpress Vet verification update', html);
}

/** Sent to admin when a new professional submits for verification */
export async function sendNewVerificationRequest(adminEmail, professionalName, professionalEmail, role) {
  const html = layout('New Verification Request', `
    <h1>New Verification Request 📋</h1>
    <p>A professional has submitted credentials for review:</p>
    <div class="highlight">
      <p>Name: <strong>${professionalName}</strong><br/>
      Email: ${professionalEmail}<br/>
      Role: ${role}</p>
    </div>
    <p>Log in to the admin dashboard to review and approve or reject this request.</p>
  `);
  await sendEmail(adminEmail, `New verification request from ${professionalName}`, html);
}

/**
 * Sent to a service provider immediately after they register and submit documents.
 * Confirms receipt and tells them what happens next.
 */
export async function sendDocumentSubmissionReceived(name, email, role) {
  const firstName = name?.split(' ')[0] || 'there';
  const roleLabel = role?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Professional';
  const html = layout('Documents Received — We\'re Reviewing Your Profile', `
    <h1>We've received your submission, ${firstName}! 📄</h1>
    <p>Thank you for registering as a <strong>${roleLabel}</strong> on Xpress Vet. Your profile and identity documents have been received and are now in our review queue.</p>
    <div class="highlight">
      <p>⏱️ <strong>What happens next?</strong><br/>
      Our admin team will review your submitted details — including your government ID and any business registration documents. This typically takes <strong>24–48 hours</strong> on business days.</p>
    </div>
    <p>You will receive another email as soon as a decision is made. If your profile is approved, you will immediately appear in Xpress Vet listings. If we need more information, we will explain exactly what is required.</p>
    <p><strong>Why do we ask for these documents?</strong><br/>
    Xpress Vet is committed to protecting pet owners. Verifying the identity of every service provider builds the trust that makes our platform valuable — for you and for the clients you will reach.</p>
    <p>If you have any questions in the meantime, simply reply to this email.</p>
    <p style="margin-top:24px;">Thank you for joining Xpress Vet,<br/><strong>The Xpress Vet Team</strong> 🐾</p>
  `);
  await sendEmail(email, 'Xpress Vet: Your profile is under review', html);
}

/**
 * Sent to admin when a new professional with documents needs review.
 * Includes a summary of submitted documents so admin can act quickly.
 */
export async function sendAdminDocumentReviewAlert(adminEmail, professional) {
  const { name, email, role, verificationDocuments: d, businessName } = professional;
  const roleLabel = role?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || role;

  let docsHtml = '';
  if (role === 'vet') {
    docsHtml = `<p>VCN Number: <strong>${professional.vcnNumber || 'Not provided'}</strong></p>`;
  } else if (d) {
    if (d.governmentIdNumber) docsHtml += `<p>${d.governmentIdType || 'Gov ID'}: <strong>${d.governmentIdNumber}</strong></p>`;
    if (d.cacNumber)           docsHtml += `<p>CAC Number: <strong>${d.cacNumber}</strong></p>`;
    if (d.professionalCertNumber) docsHtml += `<p>Prof. Cert: <strong>${d.professionalCertNumber}</strong></p>`;
  }
  if (!docsHtml) docsHtml = '<p style="color:#92400E">⚠️ No identity documents submitted</p>';

  const html = layout('New Professional Awaiting Review', `
    <h1>New ${roleLabel} Needs Review 🔍</h1>
    <div class="highlight">
      <p>Name: <strong>${name}</strong>${businessName ? ` (${businessName})` : ''}<br/>
      Email: ${email}<br/>
      Role: ${roleLabel}</p>
    </div>
    <p><strong>Submitted Documents:</strong></p>
    ${docsHtml}
    <p>Please log in to the <a href="https://vet-market-place-jsj5.onrender.com/admin">admin dashboard</a> to review and approve or reject this request.</p>
    <p style="color:#64748B;font-size:13px">This professional is currently hidden from all listings until you approve them.</p>
  `);
  await sendEmail(adminEmail, `Action needed: ${name} (${roleLabel}) awaiting review`, html);
}

/**
 * Sent to admin as a morning digest: pending count, new signups, revenue snapshot.
 */
export async function sendAdminMorningDigest(adminEmail, { pendingCount, newSignups24h, activeSubscriptions, pendingList }) {
  const pendingRows = (pendingList || []).slice(0, 10).map(p => {
    const role = p.role?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || p.role;
    const age  = p.createdAt ? Math.round((Date.now() - new Date(p.createdAt)) / 3600000) : '?';
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #F1F5F9">${p.name || '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #F1F5F9">${role}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #F1F5F9">${age}h ago</td>
    </tr>`;
  }).join('');

  const html = layout('Xpress Vet — Daily Admin Digest', `
    <h1>Good morning! Here's your daily snapshot ☀️</h1>
    <div class="highlight">
      <p>🕐 <strong>Pending Reviews:</strong> ${pendingCount}<br/>
      👥 <strong>New Sign-ups (24h):</strong> ${newSignups24h}<br/>
      ✅ <strong>Active Subscriptions:</strong> ${activeSubscriptions}</p>
    </div>
    ${pendingCount > 0 ? `
    <p><strong>Professionals awaiting your review:</strong></p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#F8FAFC">
        <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #E2E8F0">Name</th>
        <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #E2E8F0">Role</th>
        <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #E2E8F0">Waiting</th>
      </tr></thead>
      <tbody>${pendingRows}</tbody>
    </table>
    <p style="margin-top:12px"><a href="https://vet-market-place-jsj5.onrender.com/admin">→ Open Admin Dashboard</a></p>
    ` : '<p style="color:#059669">✅ No professionals awaiting review — you\'re all caught up!</p>'}
    <p style="color:#64748B;font-size:13px">This digest is sent every morning at 8:00 AM WAT.</p>
  `);
  await sendEmail(adminEmail, `Xpress Vet Daily Digest — ${pendingCount} pending, ${newSignups24h} new sign-ups`, html);
}

/**
 * Sent to a professional when they receive a new review.
 */
export async function sendNewReviewNotification(name, email, reviewerName, rating, comment, role) {
  const firstName = name?.split(' ')[0] || 'there';
  const stars = '⭐'.repeat(Math.min(Math.round(rating), 5));
  const roleLabel = role?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Professional';
  const html = layout('You have a new review!', `
    <h1>New review on your ${roleLabel} profile, ${firstName}! ${stars}</h1>
    <p><strong>${reviewerName || 'A pet owner'}</strong> just left you a review:</p>
    <div class="highlight">
      <p style="font-size:18px;font-weight:700;color:#F59E0B">${stars} ${rating}/5</p>
      ${comment ? `<p style="font-style:italic;color:#374151">"${comment}"</p>` : ''}
    </div>
    <p>Reviews help you build trust and attract more clients. Keep up the great service!</p>
    <p style="margin-top:24px;">The Xpress Vet Team 🐾</p>
  `);
  await sendEmail(email, `You have a new ${rating}-star review on Xpress Vet!`, html);
}

/**
 * Sent to admin when professionals have been stuck in pending > 48h.
 */
export async function sendAdminStaleReviewAlert(adminEmail, staleList) {
  const rows = staleList.slice(0, 20).map(p => {
    const role = p.role?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || p.role;
    const hours = Math.round((Date.now() - new Date(p.createdAt)) / 3600000);
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #F1F5F9">${p.name || '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #F1F5F9">${role}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #F1F5F9;color:#E8610A"><strong>${hours}h</strong></td>
    </tr>`;
  }).join('');

  const html = layout('Stale Review Queue Alert', `
    <h1>⚠️ ${staleList.length} Professional${staleList.length !== 1 ? 's' : ''} Waiting Over 48 Hours</h1>
    <p>The following professionals have been pending review for more than 48 hours. They cannot appear in listings until approved:</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#FEF2F2">
        <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #FECACA">Name</th>
        <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #FECACA">Role</th>
        <th style="padding:8px 10px;text-align:left;border-bottom:2px solid #FECACA">Waiting</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:14px"><a href="https://vet-market-place-jsj5.onrender.com/admin">→ Review now in Admin Dashboard</a></p>
  `);
  await sendEmail(adminEmail, `⚠️ Action needed: ${staleList.length} professionals waiting 48h+ for review`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT MESSAGE ALERT — sent to admin when a user sends a support message
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} adminEmail
 * @param {{ userName: string, userEmail: string, userRole: string, text: string, threadId: string }} msg
 */
export async function sendSupportMessageAlert(adminEmail, { userName, userEmail, userRole, text, threadId }) {
  const roleLabel = userRole?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'User';
  const preview   = text.length > 200 ? text.slice(0, 200) + '...' : text;
  const dashboardUrl = 'https://vet-market-place-jsj5.onrender.com/admin';

  const html = `
    <div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">
      <h2 style="font-size:20px;font-weight:800;color:#1A56DB;margin-bottom:4px">💬 New Support Message</h2>
      <p style="color:#6B7280;font-size:14px;margin-top:0">A user needs help — please respond promptly from the admin panel.</p>

      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:16px;margin:20px 0">
        <p style="margin:0 0 6px 0"><strong>From:</strong> ${userName} (${roleLabel})</p>
        <p style="margin:0 0 6px 0"><strong>Email:</strong> ${userEmail || 'not provided'}</p>
        <p style="margin:0"><strong>Thread ID:</strong> <code style="font-size:12px">${threadId}</code></p>
      </div>

      <div style="background:#EFF6FF;border-left:4px solid #2563EB;border-radius:0 8px 8px 0;padding:16px;margin-bottom:24px">
        <p style="margin:0;font-style:italic;color:#1E40AF">"${preview}"</p>
      </div>

      <a href="${dashboardUrl}" style="display:inline-block;background:#1A56DB;color:#fff;text-decoration:none;
         padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px">
        Open Support Panel &rarr;
      </a>

      <p style="margin-top:24px;font-size:12px;color:#9CA3AF">
        This alert was triggered automatically. Reply from the admin dashboard so the user sees your response in the app.
      </p>
    </div>`;

  await sendEmail(adminEmail, `💬 Support message from ${userName} — action needed`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// RE-ENGAGEMENT — sent to users who haven't logged in for 7 days
// ─────────────────────────────────────────────────────────────────────────────

export async function sendReEngagementEmail(name, email) {
  const firstName = name?.split(' ')[0] || 'there';
  const html = layout('We miss you on Xpress Vet 🐾', `
    <h1>Hey ${firstName}, we miss you! 🐾</h1>
    <p>It's been a little while since you last visited Xpress Vet. Nigeria's pet care community is growing — here's what you might have missed:</p>
    <ul style="font-size:15px;color:#475569;line-height:2;padding-left:20px;">
      <li>New verified vets and kennels listed across Lagos, Abuja, and Port Harcourt</li>
      <li>Faster GPS search to find care near you in seconds</li>
      <li>Direct WhatsApp contact for premium members</li>
    </ul>
    <div class="highlight">
      <p>🎯 <strong>Your pets deserve the best care.</strong><br/>
      Log in now to find trusted professionals in your area.</p>
    </div>
    <p style="text-align:center;margin:24px 0">
      <a href="https://xpressvetmarketplace.com" class="btn">Open Xpress Vet →</a>
    </p>
    <p style="color:#94A3B8;font-size:13px">
      If you no longer want these occasional updates, you can manage your notification preferences in <strong>Profile → Settings</strong>.
    </p>
  `);
  await sendEmail(email, `${firstName}, we miss you on Xpress Vet 🐾`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// ABANDONED SUBSCRIPTION — sent 30–90 min after checkout is started but not completed
// ─────────────────────────────────────────────────────────────────────────────

export async function sendAbandonedSubEmail(name, email, plan, amount) {
  const firstName = name?.split(' ')[0] || 'there';
  const planLabel = plan === 'pro' ? 'Professional Pro' : plan === 'starter' ? 'Professional Starter' : 'Premium';
  const html = layout('You left something behind', `
    <h1>Hey ${firstName} — you left something behind 🛒</h1>
    <p>You started subscribing to <strong>${planLabel}</strong> on Xpress Vet but didn't quite finish. Your cart is still saved!</p>
    <div class="highlight">
      <p>📦 <strong>${planLabel}</strong> — ₦${Number(amount).toLocaleString()}/month<br/>
      Tap below to complete your subscription in under a minute.</p>
    </div>
    <p>With ${planLabel} you get:</p>
    <ul style="font-size:15px;color:#475569;line-height:2;padding-left:20px;">
      ${plan === 'user_premium' || plan === 'user_monthly'
        ? `<li>Full contact details for every vet, kennel &amp; shop</li>
           <li>GPS search — find care providers near you</li>
           <li>Exact addresses for every listing</li>`
        : `<li>Your listing visible to all pet owners in your area</li>
           <li>Direct calls and messages from premium users</li>
           ${plan === 'pro' ? '<li>Featured badge + sorted first in search results</li>' : ''}`
      }
    </ul>
    <p style="text-align:center;margin:24px 0">
      <a href="https://xpressvetmarketplace.com" class="btn">Complete My Subscription →</a>
    </p>
    <p style="color:#94A3B8;font-size:13px">
      If you changed your mind, no worries — your free account is still active and nothing was charged.
    </p>
  `);
  await sendEmail(email, `${firstName}, complete your Xpress Vet subscription`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// PENDING SUB REMINDER — sent when 48h cleanup resets a stuck pending subscription
// ─────────────────────────────────────────────────────────────────────────────

export async function sendPendingSubReminderEmail(name, email, isProfessional) {
  const firstName = name?.split(' ')[0] || 'there';
  const context = isProfessional
    ? "Your listing wasn't activated — complete your subscription to appear in Xpress Vet search results and be found by pet owners."
    : "Your Premium subscription wasn't completed — finish it to unlock full contact details and GPS search for professionals.";
  const html = layout('Complete Your Subscription', `
    <h1>Hey ${firstName} — your subscription wasn't completed 🛒</h1>
    <p>${context}</p>
    <div class="highlight">
      <p>💡 It only takes a minute to finish. Tap below to try again — nothing was charged.</p>
    </div>
    <p style="text-align:center;margin:24px 0">
      <a href="https://xpressvetmarketplace.com" class="btn">Complete My Subscription →</a>
    </p>
    <p style="color:#94A3B8;font-size:13px">
      Your free account is still active. You can subscribe whenever you're ready — your profile and history are saved.
    </p>
  `);
  await sendEmail(email, `${firstName}, complete your Xpress Vet subscription`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// REFERRAL REWARD — sent to referrer when their referred user subscribes
// ─────────────────────────────────────────────────────────────────────────────

export async function sendReferralRewardEmail(name, email, bonusDays) {
  const firstName = name?.split(' ')[0] || 'there';
  const html = layout('You earned a referral reward! 🎉', `
    <h1>Hey ${firstName}, your referral paid off! 🎁</h1>
    <p>Someone you referred just subscribed to Xpress Vet — and you've earned a reward!</p>
    <div class="highlight">
      <p>✅ <strong>${bonusDays} days</strong> have been added to your subscription as a thank-you.</p>
      <p>Keep sharing your referral code — every subscription earns you more free time.</p>
    </div>
    <p style="text-align:center;margin:24px 0">
      <a href="https://xpressvetmarketplace.com" class="btn">Open Xpress Vet →</a>
    </p>
    <p style="color:#94A3B8;font-size:13px">
      You can find your referral code and rewards on your Profile screen. Thank you for growing the Xpress Vet community!
    </p>
  `);
  await sendEmail(email, `${firstName}, you earned a referral reward on Xpress Vet!`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE-ADOPTION PROMOS — one-time-ever emails introducing the two revenue
// features (Boost Listing, Wallet) to users who haven't tried them. Sent by
// jobs/marketingCampaigns.js, gated on marketingOptOut and each user's own
// promo-sent timestamp so nobody gets either message twice.
// ─────────────────────────────────────────────────────────────────────────────

/** Sent once to a professional/shop who has never bought a listing boost. */
export async function sendBoostListingPromo(name, email, userId, listingLabel) {
  const firstName = name?.split(' ')[0] || 'there';
  const unsub = unsubscribeUrl(userId);
  const html = layout('Get seen first on Xpress Vet', `
    <h1>Hey ${firstName}, want more clients finding ${listingLabel || 'your listing'}? 🚀</h1>
    <p>Right now, search results are sorted with the most active listings first. A <strong>Boost</strong> puts you at the very top for everyone browsing your area — and adds a ⭐ Featured badge that stands out.</p>
    <div class="highlight">
      <p>📈 <strong>7 days for ₦1,500</strong> · 14 days for ₦2,500 · 30 days for ₦4,000<br/>
      One tap, instant activation — no subscription commitment.</p>
    </div>
    <p>Boosted listings consistently get more profile views and more contacts. It's the fastest way to stand out this week.</p>
    <p style="text-align:center;margin:24px 0">
      <a href="https://xpressvetmarketplace.com" class="btn">Boost My Listing →</a>
    </p>
    <p style="color:#94A3B8;font-size:13px">
      Find it anytime under Profile → 🚀 Boost Your Listing.
    </p>
  `, unsub);
  await sendEmail(email, `${firstName}, get seen first with a Boost on Xpress Vet`, html);
}

/** Sent once to a user who has never funded/used the escrow Wallet. */
export async function sendWalletPromo(name, email, userId) {
  const firstName = name?.split(' ')[0] || 'there';
  const unsub = unsubscribeUrl(userId);
  const html = layout('Pay safely on Xpress Vet', `
    <h1>Hey ${firstName}, pay safely with the Xpress Vet Wallet 🔒</h1>
    <p>Instead of sending money directly, you can now pay any vet, kennel, groomer or shop through your in-app Wallet — funds are held in escrow and only released to them once you confirm the service was done right.</p>
    <div class="highlight">
      <p>🔒 <strong>Your money is protected.</strong><br/>
      If something goes wrong, you can report it and get a refund — no more paying upfront and hoping for the best.</p>
    </div>
    <p>Top up anytime with your card or bank transfer, then pay providers straight from their profile.</p>
    <p style="text-align:center;margin:24px 0">
      <a href="https://xpressvetmarketplace.com" class="btn">Set Up My Wallet →</a>
    </p>
    <p style="color:#94A3B8;font-size:13px">
      Find it anytime under Profile → Wallet.
    </p>
  `, unsub);
  await sendEmail(email, `${firstName}, a safer way to pay on Xpress Vet`, html);
}

/** Sent once to a vet who has never activated the Practice Records add-on. */
export async function sendPracticeAddonPromo(name, email, userId) {
  const firstName = name?.split(' ')[0] || 'Doc';
  const unsub = unsubscribeUrl(userId);
  const html = layout('Run your clinic from Xpress Vet', `
    <h1>Hey ${firstName}, keep your patients' records in one place 📋</h1>
    <p>Xpress Vet now includes <strong>Practice Records</strong> — a simple clinic tool built into the app. Add your clients and their pets, log every treatment and vaccination, and let the app remind you (and the pet owner) when the next dose or follow-up is due.</p>
    <div class="highlight">
      <p>🐾 <strong>Free for your first 5 patients.</strong><br/>
      Automatic vaccination &amp; follow-up reminders — to you, and optionally straight to your client's email.</p>
    </div>
    <p>No spreadsheets, no paper cards. Your clients see that you're on top of their pet's care — and they come back to you.</p>
    <p style="text-align:center;margin:24px 0">
      <a href="https://xpressvetmarketplace.com" class="btn">Open Practice Records →</a>
    </p>
    <p style="color:#94A3B8;font-size:13px">
      Find it anytime under Profile → 📋 Practice Records.
    </p>
  `, unsub);
  await sendEmail(email, `${firstName}, track your patients right inside Xpress Vet`, html);
}

/** Sent once to a shop/vet/kennel owner who hasn't started using the Business Suite. */
export async function sendBusinessSuitePromo(name, email, userId) {
  const firstName = name?.split(' ')[0] || 'there';
  const unsub = unsubscribeUrl(userId);
  const html = layout('Run your whole shop from Xpress Vet', `
    <h1>Hey ${firstName}, stop guessing what's in stock 🏪</h1>
    <p>The new <strong>Business Suite</strong> turns Xpress Vet into your shop's control room — inventory, sales, staff and reports, all in one place.</p>
    <div class="highlight">
      <p>📦 <strong>Know exactly what you have.</strong> Every sale updates your stock automatically, and you get an alert before anything runs out.<br/><br/>
      👥 <strong>Add your sales reps.</strong> Each gets their own PIN, and every sale and stock change is logged under their name.<br/><br/>
      🔎 <strong>Stop shrinkage.</strong> A tamper-proof audit trail shows who moved every single unit, and when — so nothing goes missing quietly.<br/><br/>
      🔐 <strong>Every team member accountable.</strong> Give each staff or vet their own secure login — every sale and stock change is tracked to them by name. Perfect for clinics with several vets.</p>
    </div>
    <p>Free to start with your first 15 products. Upgrade when you're ready for unlimited stock and sales reps.</p>
    <p style="text-align:center;margin:24px 0">
      <a href="https://xpressvetmarketplace.com" class="btn">Open the Business Suite →</a>
    </p>
    <p style="color:#94A3B8;font-size:13px">
      Find it anytime under Profile → 🏪 Business Suite.
    </p>
  `, unsub);
  await sendEmail(email, `${firstName}, take control of your shop's stock and sales`, html);
}

// XPRESS MARKET — launch/adoption announcement (jobs/marketingCampaigns.js).
// Sent once to any user who hasn't posted a listing yet. Applies to everyone —
// vets, shops, kennels and pet owners can all buy and sell.
export async function sendMarketLaunchPromo(name, email, userId) {
  const firstName = name?.split(' ')[0] || 'there';
  const unsub = unsubscribeUrl(userId);
  const html = layout('Buy & sell on Xpress Market', `
    <h1>Hey ${firstName}, you can now buy & sell on Xpress Vet 🛒</h1>
    <p>Introducing <strong>Xpress Market</strong> — a place to sell pets and pet products, and find them near you.</p>
    <div class="highlight">
      <p>🐾 <strong>Sell pets</strong> — dogs, cats, birds, poultry, livestock. Add breed, age, health details, price and photos.<br/><br/>
      🛍️ <strong>Sell products</strong> in the Pet Mart — feed, accessories, medicine, equipment and more.<br/><br/>
      📲 <strong>Share to WhatsApp</strong> — every listing has a Share button, so buyers find you fast.<br/><br/>
      🛡️ <strong>Get paid safely</strong> — buyers can pay with Buyer Protection (escrow); the money is held until they confirm.</p>
    </div>
    <p>It's <strong>free to list</strong>. You only pay if you choose to boost a listing to the top.</p>
    <p style="text-align:center;margin:24px 0">
      <a href="https://xpressvetmarketplace.com" class="btn">Start selling now →</a>
    </p>
    <p style="color:#94A3B8;font-size:13px">
      Find it anytime on your Home screen → 🛒 Xpress Market — Buy & Sell.
    </p>
  `, unsub);
  await sendEmail(email, `${firstName}, you can now buy & sell on Xpress Vet`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// XPRESS MARKET — transactional alerts (operational, NOT marketing, so no
// unsubscribe link / opt-out gating). Fired as buyers and sellers transact.
// ─────────────────────────────────────────────────────────────────────────────
export async function sendListingLiveEmail(name, email, title) {
  const firstName = name?.split(' ')[0] || 'there';
  const html = layout('Your listing is live', `
    <h1>Your listing is live, ${firstName} ✅</h1>
    <p><strong>${title}</strong> is now showing on Xpress Market — we've also posted it straight to our Telegram channel, so it's already in front of everyone following new listings there.</p>
    <p>Tip: open it and tap <strong>Share</strong> to send it to WhatsApp — that's the fastest way to find a buyer. You can also boost it to the top for more views.</p>
    <p style="text-align:center;margin:24px 0"><a href="https://xpressvetmarketplace.com" class="btn">View my listings →</a></p>
    <p style="color:#94A3B8;font-size:13px">📢 Want to see every new listing yourself, the moment it goes live? Join our Telegram channel: <a href="https://t.me/XpressVetListings">t.me/XpressVetListings</a></p>
  `);
  await sendEmail(email, `Your listing "${title}" is live on Xpress Market`, html, null, { provider: 'brevo' });
}

export async function sendEscrowSellerEmail(name, email, buyerName, title, amount) {
  const firstName = name?.split(' ')[0] || 'there';
  const html = layout('A buyer paid into escrow', `
    <h1>💰 ${buyerName || 'A buyer'} paid for "${title}"</h1>
    <p>₦${Number(amount).toLocaleString()} is being held safely in escrow. Arrange delivery/pickup with the buyer — the money is released to you once they confirm they received it.</p>
    <div class="highlight"><p>Do not hand over the item until you've agreed delivery. If anything goes wrong, the buyer can open a dispute and our team will help.</p></div>
    <p style="text-align:center;margin:24px 0"><a href="https://xpressvetmarketplace.com" class="btn">Open my Wallet →</a></p>
  `);
  await sendEmail(email, `You have a buyer for "${title}" — ₦${Number(amount).toLocaleString()} in escrow`, html);
}

export async function sendEscrowBuyerEmail(name, email, title, amount) {
  const firstName = name?.split(' ')[0] || 'there';
  const html = layout('Your payment is protected', `
    <h1>Your payment is protected, ${firstName} 🛡️</h1>
    <p>₦${Number(amount).toLocaleString()} for <strong>${title}</strong> is held safely in escrow — the seller does not get it yet.</p>
    <div class="highlight"><p>Arrange delivery or pickup with the seller. When you've received exactly what was described, open your Wallet and tap <strong>Release</strong>. If there's a problem, tap <strong>Dispute</strong> instead.</p></div>
    <p style="color:#94A3B8;font-size:13px">Never release payment before you've received and checked the item.</p>
    <p style="text-align:center;margin:24px 0"><a href="https://xpressvetmarketplace.com" class="btn">Open my Wallet →</a></p>
  `);
  await sendEmail(email, `Payment held safely for "${title}" — release when you receive it`, html);
}

export async function sendPaymentReleasedEmail(name, email, amount, title, auto) {
  const firstName = name?.split(' ')[0] || 'there';
  const html = layout('Payment released to you', `
    <h1>🎉 You've been paid, ${firstName}</h1>
    <p>₦${Number(amount).toLocaleString()} for <strong>${title || 'your item'}</strong> has been released to your wallet balance${auto ? ' (auto-released after the confirmation window)' : ''}. You can withdraw it to your bank anytime.</p>
    <p style="text-align:center;margin:24px 0"><a href="https://xpressvetmarketplace.com" class="btn">Withdraw from Wallet →</a></p>
  `);
  await sendEmail(email, `You've been paid ₦${Number(amount).toLocaleString()} on Xpress Vet`, html);
}

export async function sendPaymentRefundedEmail(name, email, amount, title) {
  const firstName = name?.split(' ')[0] || 'there';
  const html = layout('Payment refunded', `
    <h1>💸 You've been refunded, ${firstName}</h1>
    <p>₦${Number(amount).toLocaleString()} for <strong>${title || 'your purchase'}</strong> has been returned to your wallet balance.</p>
    <p style="text-align:center;margin:24px 0"><a href="https://xpressvetmarketplace.com" class="btn">Open my Wallet →</a></p>
  `);
  await sendEmail(email, `Refund of ₦${Number(amount).toLocaleString()} — Xpress Vet`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRACTICE RECORDS — vaccination/follow-up reminders (jobs/practiceReminders.js)
// ─────────────────────────────────────────────────────────────────────────────

/** Daily digest to the vet: everything due across all their patients. One email, not one per item. */
export async function sendPracticeReminderDigest(vetName, vetEmail, items) {
  const firstName = vetName?.split(' ')[0] || 'Doc';
  const rows = items.map(i =>
    `<li><strong>${i.patientName}</strong> — ${i.label} <span style="color:#94A3B8">(due ${i.dueDateStr})</span></li>`,
  ).join('');
  const html = layout(`${items.length} item(s) due soon`, `
    <h1>Hey ${firstName}, ${items.length} patient item${items.length === 1 ? ' is' : 's are'} coming due 📋</h1>
    <p>Here's what's due in the next 14 days across your patients:</p>
    <ul style="font-size:15px;color:#475569;line-height:2;padding-left:20px;">${rows}</ul>
    <p style="text-align:center;margin:24px 0">
      <a href="https://xpressvetmarketplace.com" class="btn">Open Practice Records →</a>
    </p>
    <p style="color:#94A3B8;font-size:13px">
      We've also emailed your clients directly for items where you've saved their email address.
    </p>
  `);
  await sendEmail(vetEmail, `${items.length} patient item${items.length === 1 ? '' : 's'} due soon — Xpress Vet Practice Records`, html);
}

/**
 * Sent to a vet's CLIENT directly (may not be an Xpress Vet user at all) —
 * this is the vet relaying their own patient's care to their own client, so
 * framed as coming from the vet, with a light, honest "sent via Xpress Vet"
 * mention rather than a sales pitch. Only ever sent because the vet
 * explicitly opted this client in (Client.emailRemindersEnabled) — Xpress
 * Vet doesn't decide this on its own. One email per client per day even if
 * multiple pets/items are due — see groupBy in the job.
 */
export async function sendClientReminderEmail(clientName, clientEmail, vetName, items, unsubUrl) {
  const firstName = clientName?.split(' ')[0] || 'there';
  const rows = items.map(i =>
    `<li><strong>${i.patientName}</strong> — ${i.label} <span style="color:#94A3B8">(due ${i.dueDateStr})</span></li>`,
  ).join('');
  const html = layout('A reminder for your pet', `
    <h1>Hi ${firstName}, a reminder from ${vetName || 'your vet'} 🐾</h1>
    <p>${vetName || 'Your vet'} uses Xpress Vet to keep track of your pet's care, and wanted you to know:</p>
    <ul style="font-size:15px;color:#475569;line-height:2;padding-left:20px;">${rows}</ul>
    <div class="highlight">
      <p>📅 Reach out to ${vetName || 'your vet'} to book this in.</p>
    </div>
    <p style="color:#94A3B8;font-size:13px">
      Curious what else Xpress Vet can do for your pets? <a href="https://xpressvetmarketplace.com" style="color:#2563EB">Take a look</a> — no pressure, this is just a courtesy reminder.
    </p>
  `, unsubUrl);
  await sendEmail(clientEmail, `Reminder for your pet, from ${vetName || 'your vet'}`, html);
}

// ─────────────────────────────────────────────────────────────────────────────
// WEEKLY DIGEST — internal "chief of staff" briefing sent every Monday 7am WAT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} adminEmail
 * @param {{
 *   weekLabel: string, narrative: string,
 *   observations: string[], recommendations: string[],
 *   newSignups: number, totalUsers: number,
 *   mrr: number, totalActiveSubs: number,
 *   newSubsThisWeek: number, cancelledThisWeek: number,
 *   searchBreakdown: {_id:string,count:number}[],
 *   contactBreakdown: {_id:string,count:number}[],
 *   topReferrers: {name:string,referralCode:string,referralRewardsEarned:number}[],
 *   pendingVerifications: number, conversionRate: number|null, dormantCount: number
 * }} data
 */
export async function sendWeeklyDigestEmail(adminEmail, {
  weekLabel,
  narrative,
  observations = [],
  recommendations = [],
  newSignups,
  totalUsers,
  mrr,
  totalActiveSubs,
  newSubsThisWeek,
  cancelledThisWeek,
  searchBreakdown = [],
  contactBreakdown = [],
  topReferrers = [],
  pendingVerifications,
  conversionRate,
  dormantCount,
}) {
  const cancelled_color = cancelledThisWeek > 3 ? '#F87171' : '#94A3B8';

  const kpiCell = (value, label, color) => `
    <td width="33%" style="padding:4px">
      <div style="background:#0F172A;border-radius:10px;padding:16px 10px;text-align:center">
        <div style="font-size:22px;font-weight:800;color:${color};line-height:1">${value}</div>
        <div style="font-size:10px;color:#64748B;margin-top:6px;text-transform:uppercase;letter-spacing:.5px">${label}</div>
      </div>
    </td>`;

  const observationItems = observations.map(o =>
    `<li style="margin-bottom:10px;line-height:1.65;color:#374151;font-size:14px">${o}</li>`
  ).join('');

  const recommendationItems = recommendations.map(r =>
    `<li style="margin-bottom:10px;line-height:1.65;color:#1E40AF;font-size:14px">${r}</li>`
  ).join('');

  const searchRows = searchBreakdown.length
    ? searchBreakdown.map(r => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;font-size:13px;text-transform:capitalize;color:#374151">
            ${(r._id || '—').replace(/_/g, ' ')}
          </td>
          <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;text-align:right;font-size:13px;font-weight:700;color:#2563EB">
            ${r.count}
          </td>
        </tr>`).join('')
    : `<tr><td colspan="2" style="padding:10px;color:#94A3B8;font-size:12px;font-style:italic;text-align:center">No search data yet</td></tr>`;

  const contactRows = contactBreakdown.length
    ? contactBreakdown.map(r => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;font-size:13px;text-transform:capitalize;color:#374151">
            ${r._id || '—'}
          </td>
          <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;text-align:right;font-size:13px;font-weight:700;color:#059669">
            ${r.count}
          </td>
        </tr>`).join('')
    : `<tr><td colspan="2" style="padding:10px;color:#94A3B8;font-size:12px;font-style:italic;text-align:center">No contact taps yet</td></tr>`;

  const conversionBadge = conversionRate !== null
    ? `<div style="margin-top:10px;display:inline-block;background:#F0FDF4;border:1px solid #86EFAC;border-radius:6px;padding:3px 10px;font-size:12px;color:#15803D;font-weight:700">
        ${conversionRate}% conversion rate
       </div>`
    : '';

  const referrerRows = topReferrers.length
    ? topReferrers.map((r, i) => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;font-size:13px;color:#374151">#${i + 1} ${r.name || '—'}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;text-align:right;font-size:13px;font-weight:700;color:#F59E0B">
            ₦${Number(r.referralRewardsEarned).toLocaleString()}
          </td>
        </tr>`).join('')
    : `<tr><td colspan="2" style="padding:10px;color:#94A3B8;font-size:12px;font-style:italic;text-align:center">No referral earnings yet</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Xpress Vet Weekly Briefing</title>
</head>
<body style="margin:0;padding:0;background:#0F172A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="padding:24px 16px;">
<table width="620" cellpadding="0" cellspacing="0" border="0" style="max-width:620px">

  <!-- Header -->
  <tr>
    <td style="background:#1E293B;border-radius:12px 12px 0 0;padding:24px 28px;border-bottom:1px solid #334155">
      <div style="font-size:12px;color:#64748B;font-weight:600;letter-spacing:.6px;text-transform:uppercase">Weekly Briefing</div>
      <div style="font-size:24px;font-weight:800;color:#F1F5F9;margin:4px 0 2px">Xpress Vet 🐾</div>
      <div style="font-size:13px;color:#64748B">${weekLabel}</div>
    </td>
  </tr>

  <!-- KPI grid row 1 -->
  <tr>
    <td style="background:#1E293B;padding:16px 24px 6px">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          ${kpiCell(newSignups, 'New Users', '#38BDF8')}
          ${kpiCell('₦' + mrr.toLocaleString(), 'Est. MRR', '#34D399')}
          ${kpiCell(totalActiveSubs, 'Active Subs', '#A78BFA')}
        </tr>
      </table>
    </td>
  </tr>

  <!-- KPI grid row 2 -->
  <tr>
    <td style="background:#1E293B;padding:6px 24px 20px">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          ${kpiCell(newSubsThisWeek, 'New Subs', '#F59E0B')}
          ${kpiCell(cancelledThisWeek, 'Cancellations', cancelled_color)}
          ${kpiCell(pendingVerifications, 'Pending Vrf.', '#CBD5E1')}
        </tr>
      </table>
    </td>
  </tr>

  <!-- White card -->
  <tr>
    <td style="background:#FFFFFF;padding:28px;border-radius:0 0 12px 12px">

      <!-- Narrative -->
      <div style="background:#F8FAFC;border-radius:10px;padding:16px 18px;margin-bottom:24px">
        <p style="font-size:14px;color:#374151;line-height:1.7;margin:0">${narrative}</p>
      </div>

      <!-- Observations -->
      ${observations.length ? `
      <div style="margin-bottom:24px">
        <div style="font-size:13px;font-weight:700;color:#0F172A;text-transform:uppercase;letter-spacing:.5px;
                    padding-bottom:8px;border-bottom:2px solid #F1F5F9;margin-bottom:12px">
          What happened this week
        </div>
        <ul style="padding-left:18px;margin:0">
          ${observationItems}
        </ul>
      </div>` : ''}

      <!-- Recommendations -->
      ${recommendations.length ? `
      <div style="background:#EFF6FF;border-left:4px solid #2563EB;border-radius:0 10px 10px 0;
                  padding:16px 20px;margin-bottom:24px">
        <div style="font-size:12px;font-weight:700;color:#1E40AF;text-transform:uppercase;
                    letter-spacing:.5px;margin-bottom:10px">
          Recommended Actions
        </div>
        <ul style="padding-left:18px;margin:0">
          ${recommendationItems}
        </ul>
      </div>` : ''}

      <!-- Data tables -->
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px">
        <tr valign="top">

          <!-- Top Searches -->
          <td width="32%" style="padding-right:8px">
            <div style="font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;
                        letter-spacing:.4px;margin-bottom:8px">Top Searches</div>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tbody>${searchRows}</tbody>
            </table>
          </td>

          <td width="4%"></td>

          <!-- Contact Methods -->
          <td width="32%" style="padding-right:8px">
            <div style="font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;
                        letter-spacing:.4px;margin-bottom:8px">Contact Taps</div>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tbody>${contactRows}</tbody>
            </table>
            ${conversionBadge}
          </td>

          <td width="4%"></td>

          <!-- Top Referrers -->
          <td width="28%">
            <div style="font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;
                        letter-spacing:.4px;margin-bottom:8px">Top Referrers</div>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tbody>${referrerRows}</tbody>
            </table>
          </td>

        </tr>
      </table>

      <!-- CTA -->
      <div style="text-align:center;padding-top:16px;border-top:1px solid #F1F5F9">
        <a href="https://vet-market-place-jsj5.onrender.com/admin"
           style="display:inline-block;background:#2563EB;color:#ffffff;text-decoration:none;
                  font-weight:700;font-size:14px;padding:12px 28px;border-radius:10px">
          Open Admin Dashboard →
        </a>
        <p style="font-size:11px;color:#94A3B8;margin:12px 0 0;line-height:1.6">
          This briefing is sent every Monday at 7:00 AM WAT.<br/>
          Platform total: ${totalUsers.toLocaleString()} users · ${dormantCount} inactive 30+ days.
        </p>
      </div>

    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  await sendEmail(
    adminEmail,
    `Xpress Vet Weekly — ${newSignups} new users · ₦${mrr.toLocaleString()} MRR · ${cancelledThisWeek} cancellations`,
    html,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UNANSWERED SUPPORT ALERT — cron reminder for threads with no admin reply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} adminEmail
 * @param {{ userName: string, userEmail: string, userRole: string, waitMinutes: number }[]} threads
 */
export async function sendUnansweredSupportAlert(adminEmail, threads) {
  const rows = threads.map(t => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6">${t.userName}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6">${t.userEmail || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6">${t.userRole?.replace(/_/g, ' ') || '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #F3F4F6;color:#DC2626;font-weight:600">${t.waitMinutes} min</td>
    </tr>`).join('');

  const html = `
    <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827">
      <h2 style="font-size:20px;font-weight:800;color:#DC2626">⚠️ Unanswered Support Messages</h2>
      <p>The following users have been waiting more than 30 minutes for a reply:</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <thead>
          <tr style="background:#F9FAFB">
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6B7280">Name</th>
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6B7280">Email</th>
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6B7280">Role</th>
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6B7280">Waiting</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <a href="https://vet-market-place-jsj5.onrender.com/admin" style="display:inline-block;background:#DC2626;color:#fff;
         text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px">
        Reply Now &rarr;
      </a>
    </div>`;

  await sendEmail(adminEmail, `⚠️ ${threads.length} unanswered support message(s) — please reply`, html);
}
