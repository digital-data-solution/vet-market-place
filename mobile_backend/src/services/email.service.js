/**
 * Email Service — supports Resend and Brevo (Sendinblue)
 *
 * Configure one provider via environment variables:
 *   RESEND_API_KEY  → uses Resend (resend.com)
 *   BREVO_API_KEY   → uses Brevo (brevo.com)
 *   EMAIL_FROM      → sender address, e.g. "Xpress Vet <noreply@xpressvetmarketplace.com>"
 *
 * If neither key is set, all send calls are logged and skipped silently
 * so the app works correctly in dev without email credentials.
 */

import fetch from 'node-fetch';
import logger from '../lib/logger.js';

const FROM    = process.env.EMAIL_FROM    || 'Xpress Vet <noreply@xpressvetmarketplace.com>';
const RESEND  = process.env.RESEND_API_KEY;
const BREVO   = process.env.BREVO_API_KEY;

// ─────────────────────────────────────────────────────────────────────────────
// CORE SEND
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sendEmail — provider-agnostic send function.
 * @param {string}   to      Recipient address
 * @param {string}   subject Email subject
 * @param {string}   html    HTML body
 * @param {string}   [text]  Plain-text fallback (auto-generated if omitted)
 */
export async function sendEmail(to, subject, html, text) {
  if (!to || !subject || !html) {
    logger.warn('sendEmail called with missing args', { to, subject });
    return;
  }

  if (!RESEND && !BREVO) {
    logger.info(`[EMAIL SKIP] To: ${to} | Subject: ${subject} (no provider key set)`);
    return;
  }

  const plainText = text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  try {
    if (RESEND) {
      await sendViaResend(to, subject, html, plainText);
    } else {
      await sendViaBravo(to, subject, html, plainText);
    }
    logger.info('Email sent', { to, subject });
  } catch (err) {
    logger.error('Email send failed', { to, subject, error: err.message });
    // Never throw — email failure must not break API responses
  }
}

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
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}

async function sendViaBravo(to, subject, html, text) {
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
    throw new Error(`Brevo error ${res.status}: ${body}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED LAYOUT
// ─────────────────────────────────────────────────────────────────────────────

function layout(title, body) {
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
    Questions? Reply to this email — we're happy to help.</p>
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
