/**
 * instagram-refresh-token.mjs — renews the long-lived Instagram access
 * token for another 60 days WITHOUT a full re-login, using Meta's
 * documented /refresh_access_token endpoint. Run this whenever the
 * pipeline's own log output starts warning the token is close to expiry
 * (see lib/instagramUpload.js's checkTokenAge()) — no need to redo the
 * whole App Dashboard "Generate token" flow each time.
 *
 * Requirement (per Meta's docs): the current token must be at least 24h
 * old and not yet expired — this won't work on a token generated minutes
 * ago, and won't work on one that's already expired (in that case, go
 * back to the "Generate token" button in the App Dashboard instead — see
 * scripts/instagram-authorize.mjs).
 *
 * Run: node scripts/instagram-refresh-token.mjs
 * Prints the renewed token — update INSTAGRAM_ACCESS_TOKEN and
 * INSTAGRAM_TOKEN_ISSUED_AT in Render's env vars and GitHub Actions
 * secrets with the new values it prints.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const currentToken = process.env.INSTAGRAM_ACCESS_TOKEN;
if (!currentToken) {
  console.error('Missing INSTAGRAM_ACCESS_TOKEN in mobile_backend/.env — put the current (about-to-expire) token there first.');
  process.exit(1);
}

try {
  const url = 'https://graph.instagram.com/refresh_access_token?' + new URLSearchParams({
    grant_type: 'ig_refresh_token',
    access_token: currentToken,
  });
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `HTTP ${res.status}`);
  }

  console.log(`\n✅ Refreshed — valid for another ~${Math.round(data.expires_in / 86400)} days.\n`);
  console.log('Update these 2 in both Render\'s env vars and GitHub Actions repo secrets (INSTAGRAM_ACCOUNT_ID stays the same, no need to touch it):\n');
  console.log(`INSTAGRAM_ACCESS_TOKEN=${data.access_token}`);
  console.log(`INSTAGRAM_TOKEN_ISSUED_AT=${new Date().toISOString()}`);
} catch (err) {
  console.error('\nRefresh failed:', err.message);
  console.error('If the token is already expired or under 24h old, use scripts/instagram-authorize.mjs (via the App Dashboard\'s "Generate token" button) instead.');
  process.exit(1);
}
