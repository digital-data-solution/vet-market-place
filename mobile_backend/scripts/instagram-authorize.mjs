/**
 * instagram-authorize.mjs — ONE-TIME setup script. Run this yourself, on
 * your own machine, logged into the Instagram account @xpressvet. Claude
 * cannot and will not run this for you — only you can complete the actual
 * Instagram login + "Allow" click in the browser.
 *
 * NOTE ON ACCURACY: Meta's own developer docs site (developers.facebook.com)
 * was unreachable from the environment this script was built in (network
 * block, confirmed via two different tools) — the endpoints below are
 * built from converged third-party documentation, not verified against
 * Meta's primary docs directly. If a step errors, the error message from
 * Instagram itself is the most reliable next signal — send it back and
 * we'll adjust the exact endpoint/param together rather than guessing
 * twice.
 *
 * BEFORE running this, one-time setup at developers.facebook.com:
 *   1. Log in with your own Facebook account (create one free if needed —
 *      this is just for developer access, doesn't need to be your
 *      business's public presence).
 *   2. My Apps -> Create App -> choose "Other" -> "Business" type -> name
 *      it "Xpress Vet Automation" or similar.
 *   3. In the app dashboard, find "Instagram" under Products -> Add ->
 *      set up "Instagram API with Instagram Login" (NOT the older
 *      Facebook-Login-for-Business variant — this one shouldn't need a
 *      linked Facebook Page, though we may discover otherwise once we
 *      actually try posting a Reel).
 *   4. App dashboard -> Roles (or "Instagram Tester" under the Instagram
 *      product settings) -> add @xpressvet as an Instagram Tester. Then
 *      log into Instagram (app or web) as @xpressvet -> Settings ->
 *      Apps and Websites -> Tester Invites -> Accept the invite from your
 *      app. This is what lets your app act on @xpressvet WITHOUT ever
 *      submitting for Meta's App Review.
 *   5. App dashboard -> Instagram product settings -> note your app's
 *      Instagram App ID and Instagram App Secret (these may differ from
 *      the top-level Facebook App ID/Secret — use the Instagram-specific
 *      ones if the product settings show separate values).
 *   6. Add a redirect URI in the Instagram product's OAuth settings:
 *      http://localhost:53683/callback
 *   7. Put the Instagram App ID/Secret in mobile_backend/.env as:
 *        INSTAGRAM_APP_ID=...
 *        INSTAGRAM_APP_SECRET=...
 *
 * Then run: node scripts/instagram-authorize.mjs
 * It opens/prints a login URL, waits for you to log in as @xpressvet and
 * approve, catches the redirect on localhost, exchanges the code for a
 * long-lived (~60 day) access token, and prints everything you need to
 * add to Render's env vars and GitHub Actions secrets:
 *   INSTAGRAM_ACCOUNT_ID
 *   INSTAGRAM_ACCESS_TOKEN
 *   INSTAGRAM_TOKEN_ISSUED_AT
 *
 * TO RENEW LATER (the token expires ~60 days from issue — the pipeline
 * will log a warning in its own output starting 10 days before that):
 * just run this script again from scratch. It's simpler than trying to
 * silently auto-refresh a token nobody's watching.
 */
import dotenv from 'dotenv';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const APP_ID = process.env.INSTAGRAM_APP_ID;
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET;
const PORT = 53683;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

if (!APP_ID || !APP_SECRET) {
  console.error('Missing INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET in mobile_backend/.env — see the setup steps in this script\'s docstring.');
  process.exit(1);
}

const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'].join(',');
const authUrl = `https://www.instagram.com/oauth/authorize?` + new URLSearchParams({
  client_id: APP_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPES,
});

console.log('\n1. Open this URL in a browser where you are logged into Instagram as @xpressvet:\n');
console.log(authUrl);
console.log('\n2. Click Allow. This script will catch the redirect automatically.\n');
console.log(`Waiting on http://localhost:${PORT} ...`);

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/callback')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error_description') || url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Authorization failed: ${error}. You can close this tab.`);
    console.error('Authorization failed:', error);
    server.close();
    process.exit(1);
  }

  try {
    // Step 1: exchange the authorization code for a short-lived token.
    const tokenForm = new URLSearchParams({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code,
    });
    const shortLivedRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: tokenForm,
    });
    const shortLived = await shortLivedRes.json();
    if (!shortLivedRes.ok || shortLived.error_message) {
      throw new Error(shortLived.error_message || `HTTP ${shortLivedRes.status} exchanging code for a short-lived token`);
    }
    const shortLivedToken = shortLived.access_token;

    // Step 2: exchange the short-lived token for a long-lived one (~60 days).
    const longLivedUrl = 'https://graph.instagram.com/access_token?' + new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: APP_SECRET,
      access_token: shortLivedToken,
    });
    const longLivedRes = await fetch(longLivedUrl);
    const longLived = await longLivedRes.json();
    if (!longLivedRes.ok || longLived.error) {
      throw new Error(longLived.error?.message || `HTTP ${longLivedRes.status} exchanging for a long-lived token`);
    }
    const longLivedToken = longLived.access_token;

    // Step 3: fetch the Instagram account id for this token.
    const meRes = await fetch(`https://graph.instagram.com/me?fields=user_id,username&access_token=${longLivedToken}`);
    const me = await meRes.json();
    if (!meRes.ok || me.error) {
      throw new Error(me.error?.message || `HTTP ${meRes.status} fetching account info`);
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Authorized! You can close this tab and go back to the terminal.');

    console.log(`\n✅ Success. Authenticated as @${me.username}.\n`);
    console.log('Add these to both Render\'s env vars and GitHub Actions repo secrets:\n');
    console.log(`INSTAGRAM_ACCOUNT_ID=${me.user_id}`);
    console.log(`INSTAGRAM_ACCESS_TOKEN=${longLivedToken}`);
    console.log(`INSTAGRAM_TOKEN_ISSUED_AT=${new Date().toISOString()}`);
    console.log('\nAlso keep INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET in both places — needed for any future re-authorization.\n');
  } catch (err) {
    console.error('\nSetup failed:', err.message);
    console.error('If this names a specific missing permission or product, that\'s Meta telling us exactly what to fix in the app dashboard — share the message and we\'ll adjust.');
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT);
