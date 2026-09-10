/**
 * instagram-authorize.mjs — ONE-TIME setup helper.
 *
 * REWRITTEN 2026-09-10 to match the Business Portfolio + System User
 * pattern (same one XDDS already has running in production for
 * @xpress_digital_ng — confirmed via cross-session message, not guessed).
 * Switched to this after getting stuck on Instagram's own "Tester Invite"
 * acceptance screen, which is apparently a known, common pain point with
 * no guaranteed path forward — this path avoids that screen entirely.
 *
 * IMPORTANT, also confirmed via that same cross-session check: Business
 * Verification is NOT required for this. XDDS's own portfolio is still
 * unverified and their identical System User + instagram_content_publish
 * pattern has been posting successfully since 2026-07-11 anyway — Standard
 * Access covers content publishing. Verification only gates inbound
 * DM/comment webhooks (real-time Social Inbox traffic), which this
 * pipeline doesn't use. Don't go verify the business portfolio for this —
 * it's unnecessary extra work.
 *
 * This script itself is now just a verifier + account-ID lookup — the
 * actual token comes from Meta's Business Settings UI, not from running
 * any OAuth flow here.
 *
 * BEFORE running this, setup in Meta Business Settings
 * (business.facebook.com/settings):
 *   1. Create (or link, if it doesn't exist yet) a Facebook Page for
 *      Xpress Vet — Business Settings -> Accounts -> Pages -> Add ->
 *      Create a new Page. Simple/free, just needs a name+category.
 *   2. Connect @xpress_vet to that Page: on Instagram, Settings ->
 *      Linked accounts -> Facebook -> connect the Xpress Vet Page (or do
 *      it from the Page's own settings -> Linked accounts).
 *   3. Business Settings -> Accounts -> Instagram accounts -> Add ->
 *      connect @xpress_vet under the Business Portfolio ("Xpress Digital
 *      and Data Solutions" or a new one for Xpress Vet specifically).
 *   4. Business Settings -> Users -> System Users -> Add (or reuse an
 *      existing one) -> assign it the Xpress Vet Page AND the @xpress_vet
 *      Instagram account with Full control.
 *   5. On that System User -> Generate New Token -> select the Xpress Vet
 *      app -> check instagram_basic + instagram_content_publish (+
 *      pages_show_list, pages_read_engagement if offered) -> Generate
 *      Token. System User tokens generated this way typically don't carry
 *      the same 60-day expiry as a regular user token (worth confirming
 *      what Meta's UI actually shows at generation time rather than
 *      assuming) — copy it either way.
 *   6. Note the Facebook Page's numeric ID too (Page -> About, or Business
 *      Settings -> Accounts -> Pages -> click the Page).
 *   7. Paste into mobile_backend/.env:
 *        INSTAGRAM_ACCESS_TOKEN=<the System User token>
 *        FACEBOOK_PAGE_ID=<the Page's numeric ID>
 *
 * Then run: node scripts/instagram-authorize.mjs
 * It looks up the Instagram Business Account ID connected to that Page
 * and prints the final env vars to add to Render + GitHub Actions secrets.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const token = process.env.INSTAGRAM_ACCESS_TOKEN;
const pageId = process.env.FACEBOOK_PAGE_ID;

if (!token || !pageId) {
  console.error('Missing INSTAGRAM_ACCESS_TOKEN and/or FACEBOOK_PAGE_ID in mobile_backend/.env — see the setup steps in this script\'s docstring.');
  process.exit(1);
}

try {
  const res = await fetch(`https://graph.facebook.com/v21.0/${pageId}?fields=instagram_business_account{id,username}&access_token=${token}`);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `HTTP ${res.status}`);
  }
  const igAccount = data.instagram_business_account;
  if (!igAccount) {
    throw new Error('This Page has no linked Instagram Business Account — double check step 2 (connecting @xpress_vet to the Page) actually completed.');
  }

  console.log(`\n✅ Success. Found @${igAccount.username} linked to this Page.\n`);
  console.log('Add these to both Render\'s env vars and GitHub Actions repo secrets:\n');
  console.log(`INSTAGRAM_ACCOUNT_ID=${igAccount.id}`);
  console.log(`INSTAGRAM_ACCESS_TOKEN=${token}`);
  console.log(`INSTAGRAM_TOKEN_ISSUED_AT=${new Date().toISOString()}`);
  console.log('\nCheck what expiry (if any) Meta\'s System User token screen showed you when you generated it — if it said "Never expires," the checkTokenAge() warning in this pipeline will never fire, which is fine; if it gave a date, note it and refresh before then.\n');
} catch (err) {
  console.error('\nFailed:', err.message);
  console.error('If this names a specific permission or scope problem, that\'s Meta telling us exactly what\'s missing on the System User\'s token — share the message and we\'ll fix it together.');
  process.exit(1);
}
