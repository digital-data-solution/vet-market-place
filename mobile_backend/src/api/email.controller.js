// Public (unauthenticated) email endpoints — must work from a raw link click
// inside an email client, so no auth header is available.

import User from '../models/User.js';
import logger from '../lib/logger.js';
import { verifyUnsubscribeSig } from '../services/email.service.js';

function page(title, message, ok) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>
  body{margin:0;padding:0;background:#F1F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
       min-height:100vh;display:flex;align-items:center;justify-content:center;}
  .card{max-width:420px;margin:24px;background:#fff;border-radius:16px;padding:36px 32px;text-align:center;
        box-shadow:0 4px 24px rgba(0,0,0,.08);}
  .icon{font-size:44px;margin-bottom:12px;}
  h1{font-size:19px;color:#0F172A;margin:0 0 10px;}
  p{font-size:14px;color:#64748B;line-height:1.6;margin:0;}
  a{color:#2563EB;font-weight:600;text-decoration:none;}
</style></head>
<body><div class="card">
  <div class="icon">${ok ? '✅' : '⚠️'}</div>
  <h1>${title}</h1>
  <p>${message}</p>
</div></body></html>`;
}

export const unsubscribe = async (req, res) => {
  const { uid, sig } = req.query;

  if (!verifyUnsubscribeSig(uid, sig)) {
    return res.status(400).send(page('Link expired or invalid', 'This unsubscribe link is not valid. If you\'d like to stop receiving marketing emails, reply to any Xpress Vet email and we\'ll take care of it.', false));
  }

  try {
    const user = await User.findByIdAndUpdate(uid, { $set: { marketingOptOut: true } }, { new: true }).select('email');
    if (!user) {
      return res.status(404).send(page('Account not found', 'We could not find an account matching this link.', false));
    }
    logger.info('User unsubscribed from marketing emails', { userId: uid });
    return res.send(page(
      "You're unsubscribed",
      `${user.email} will no longer receive marketing emails from Xpress Vet. You'll still get essential emails about your account, subscription, and payments.`,
      true,
    ));
  } catch (error) {
    logger.error('Unsubscribe error', { error: error.message, uid });
    return res.status(500).send(page('Something went wrong', 'Please try again in a moment, or reply to any Xpress Vet email to be unsubscribed manually.', false));
  }
};
