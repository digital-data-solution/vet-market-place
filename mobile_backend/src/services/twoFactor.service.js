/**
 * twoFactor.service.js — TOTP 2FA helpers shared by both admin tiers (User
 * owner accounts and AdminStaffAccount staff accounts). Works against
 * either document type duck-typed: anything with twoFactorEnabled/
 * twoFactorSecret/twoFactorPendingSecret/twoFactorBackupCodes fields and a
 * .save(). Mirrors the CRM/HR admin's own landed 2FA design (same speakeasy
 * + qrcode stack, same setup/confirm/verify shape) so all of Samuel's admin
 * logins feel identical from a user's perspective.
 *
 * Login flow this supports (see admin.auth.controller.js):
 *   1. POST /admin/login — password check as normal. If twoFactorEnabled,
 *      does NOT issue a real session token — issues a short-lived
 *      "pending_2fa" token instead (see generatePendingToken there).
 *   2. POST /admin/login/2fa — { pendingToken, code } — verifies the code
 *      against the TOTP secret OR a backup code, then issues the real token.
 *   3. POST /admin/2fa/setup, /2fa/confirm, /2fa/disable — self-service,
 *      always behind a real (already-authenticated) session — see below.
 */
import crypto from 'crypto';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';
import bcrypt from 'bcryptjs';

const ISSUER = 'Xpress Vet Admin';

/**
 * Step 1 of setup — generate a new secret, store it as PENDING (not yet
 * trusted/active) on the account, and return a QR code + manual-entry key
 * for an authenticator app. Nothing is enforced until confirmSetup() below
 * verifies the user actually has it working.
 */
export async function beginSetup(account, label) {
  const secret = speakeasy.generateSecret({
    length: 20,
    name: `${ISSUER} (${label})`,
    issuer: ISSUER,
  });
  account.twoFactorPendingSecret = secret.base32;
  await account.save();

  const qrDataUrl = await qrcode.toDataURL(secret.otpauth_url);
  return { qrDataUrl, manualKey: secret.base32 };
}

function verifyTotpCode(secret, code) {
  if (!secret || !code) return false;
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token: String(code).replace(/\s/g, ''),
    window: 1, // ±30s clock drift tolerance
  });
}

/**
 * Step 2 of setup — the user enters a code from the app they just scanned
 * the QR into. Only on a real match does the pending secret get promoted to
 * active + a fresh set of one-time backup codes get generated (shown once,
 * in plaintext, by the caller — never stored or retrievable again).
 */
export async function confirmSetup(account, code) {
  if (!account.twoFactorPendingSecret) {
    return { ok: false, message: 'No 2FA setup in progress — call setup first.' };
  }
  if (!verifyTotpCode(account.twoFactorPendingSecret, code)) {
    return { ok: false, message: 'Incorrect code. Check your authenticator app and try again.' };
  }

  const backupCodes = generateBackupCodes();
  account.twoFactorSecret = account.twoFactorPendingSecret;
  account.twoFactorPendingSecret = null;
  account.twoFactorEnabled = true;
  account.twoFactorBackupCodes = await Promise.all(backupCodes.map((c) => bcrypt.hash(c, 10)));
  await account.save();

  return { ok: true, backupCodes };
}

/**
 * Disable — always requires the current password (checked by the caller
 * before this runs), not just an authenticated session, since a stolen
 * session token shouldn't be enough to turn 2FA back off.
 */
export async function disable(account) {
  account.twoFactorEnabled = false;
  account.twoFactorSecret = null;
  account.twoFactorPendingSecret = null;
  account.twoFactorBackupCodes = [];
  await account.save();
}

/**
 * Verify a login-time code against either the TOTP secret or a backup
 * code — tries TOTP first (the common case), falls back to backup codes.
 * A matched backup code is spliced out immediately (one-time use) and the
 * account saved, so the same recovery code can never be reused.
 */
export async function verifyLoginCode(account, code) {
  if (verifyTotpCode(account.twoFactorSecret, code)) return true;

  const clean = String(code || '').trim();
  for (let i = 0; i < (account.twoFactorBackupCodes || []).length; i++) {
    if (await bcrypt.compare(clean, account.twoFactorBackupCodes[i])) {
      account.twoFactorBackupCodes.splice(i, 1);
      await account.save();
      return true;
    }
  }
  return false;
}

// 8 codes, human-typeable (XXXX-XXXX, uppercase hex-ish alphabet minus
// visually-ambiguous chars).
function generateBackupCodes() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0, I/1
  const one = () => Array.from({ length: 8 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return Array.from({ length: 8 }, () => {
    const s = one();
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export default { beginSetup, confirmSetup, disable, verifyLoginCode };
