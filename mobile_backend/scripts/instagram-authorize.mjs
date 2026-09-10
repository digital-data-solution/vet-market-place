/**
 * instagram-authorize.mjs — ONE-TIME setup helper.
 *
 * SIMPLER than the original version of this script (rewritten 2026-09-10
 * after confirming against Meta's own docs, which were unreachable when
 * this pipeline was first built): Meta's App Dashboard has a built-in
 * "Generate token" button that does the whole OAuth exchange for you when
 * your app only needs Standard Access to an account you own — no local
 * redirect server needed at all. This script just does the one remaining
 * step: turns that token into the exact env vars this pipeline needs.
 *
 * BEFORE running this:
 *   1. developers.facebook.com -> your app -> left sidebar -> Instagram ->
 *      "API setup with Instagram login".
 *   2. Under step "3. Set up Instagram business login", find your
 *      Instagram account (add it first if it's not listed — there should
 *      be an "Add account" option) and click "Generate token" next to it.
 *   3. Log into Instagram as @xpressvet when prompted, approve.
 *   4. Copy the token it shows you (long-lived, valid 60 days already —
 *      no separate long-lived exchange step needed for this path).
 *   5. Paste it into mobile_backend/.env as:
 *        INSTAGRAM_ACCESS_TOKEN=<the token>
 *
 * Then run: node scripts/instagram-authorize.mjs
 * It fetches your account's numeric ID using that token and prints the
 * final 3 values to add to Render's env vars and GitHub Actions secrets.
 *
 * TO RENEW LATER (~every 60 days, before it expires): use
 * scripts/instagram-refresh-token.mjs instead — a lightweight refresh
 * call, not a full re-login.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const token = process.env.INSTAGRAM_ACCESS_TOKEN;
if (!token) {
  console.error('Missing INSTAGRAM_ACCESS_TOKEN in mobile_backend/.env — paste in the token from the App Dashboard\'s "Generate token" button first. See this script\'s docstring.');
  process.exit(1);
}

try {
  const res = await fetch(`https://graph.instagram.com/v21.0/me?fields=user_id,username,account_type&access_token=${token}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `HTTP ${res.status}`);
  }

  console.log(`\n✅ Success. Authenticated as @${data.username} (account_type: ${data.account_type}).\n`);
  console.log('Add these 3 to both Render\'s env vars and GitHub Actions repo secrets:\n');
  console.log(`INSTAGRAM_ACCOUNT_ID=${data.user_id}`);
  console.log(`INSTAGRAM_ACCESS_TOKEN=${token}`);
  console.log(`INSTAGRAM_TOKEN_ISSUED_AT=${new Date().toISOString()}`);
  console.log('\nDone — no INSTAGRAM_APP_ID/APP_SECRET needed at runtime, only for generating/refreshing tokens.\n');
} catch (err) {
  console.error('\nFailed to verify the token:', err.message);
  console.error('If this names a specific permission or scope problem, that\'s Instagram telling us exactly what\'s missing in the app\'s permission request — share the message and we\'ll fix it together.');
  process.exit(1);
}
