/**
 * youtube-authorize.mjs — ONE-TIME setup script. Run this yourself, on your
 * own machine, logged into the Google account that owns/manages the Xpress
 * Vet YouTube channel. Claude cannot and will not run this for you — only
 * you can complete the actual Google login + "Allow" click in the browser.
 *
 * What this does: exchanges a one-time authorization from your Google
 * account for a long-lived REFRESH TOKEN, which is what lets the automated
 * worker upload videos on the channel's behalf without you logging in
 * again. Prints that refresh token once at the end — copy it straight into
 * Render's env vars and a GitHub Actions repo secret (both named
 * YOUTUBE_REFRESH_TOKEN), then close this terminal. Treat it like a
 * password: it grants upload access to the channel for as long as it's
 * valid.
 *
 * BEFORE running this, one-time setup in Google Cloud Console
 * (console.cloud.google.com) — you likely already have a usable project:
 * the same one behind Firebase project "xpress-vet-market-place" is a real
 * Google Cloud project too, so you can reuse it instead of creating a new
 * one:
 *   1. Select (or create) that project in the top project-picker.
 *   2. APIs & Services -> Library -> search "YouTube Data API v3" -> Enable.
 *   3. APIs & Services -> OAuth consent screen -> External -> fill the
 *      required fields (app name "Xpress Vet", your email) -> Save. Leave
 *      Publishing status as "Testing" (no Google review needed for this).
 *   4. OAuth consent screen -> Test users -> Add your own Google account
 *      email (the one that owns the Xpress Vet YouTube channel).
 *   5. APIs & Services -> Credentials -> Create Credentials -> OAuth
 *      client ID -> Application type: "Desktop app" -> name it anything ->
 *      Create. Copy the Client ID and Client Secret it shows you.
 *   6. Put those two values in THIS machine's local mobile_backend/.env as
 *      YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET (local-only, just for
 *      running this script once — the deployed worker reads them from
 *      Render/GitHub secrets instead, same two values).
 *
 * Then run: node scripts/youtube-authorize.mjs
 * It opens/prints a Google login URL, waits for you to approve access in
 * the browser, catches the redirect automatically on localhost, and prints
 * the refresh token. No manual code copy-pasting (Google killed that
 * "out-of-band" flow in 2023) — this uses the current loopback-redirect
 * flow instead, which a "Desktop app" OAuth client supports without any
 * extra redirect-URI configuration.
 */
import dotenv from 'dotenv';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in mobile_backend/.env — see the setup steps in this script\'s docstring.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline', // required to get a refresh_token back, not just a short-lived access token
  prompt: 'consent',      // forces Google to re-issue a refresh_token even if you've authorized this app before
  scope: ['https://www.googleapis.com/auth/youtube.upload'],
});

console.log('\n1. Open this URL in a browser where you are logged into the Google account that owns the Xpress Vet YouTube channel:\n');
console.log(authUrl);
console.log('\n2. Click Allow. This script will catch the redirect automatically and print your refresh token.\n');
console.log(`Waiting on http://localhost:${PORT} ...`);

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Authorization was denied or failed: ${error}. You can close this tab.`);
    console.error('Authorization failed:', error);
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Authorized! You can close this tab and go back to the terminal.');

    if (!tokens.refresh_token) {
      console.error('\nNo refresh_token came back. This usually means you\'ve authorized this app before and Google is reusing an old grant. Go to https://myaccount.google.com/permissions, remove access for this app, and run this script again.');
      server.close();
      process.exit(1);
    }

    console.log('\n✅ Success. Add this as YOUTUBE_REFRESH_TOKEN in both Render\'s env vars and a GitHub Actions repo secret:\n');
    console.log(tokens.refresh_token);
    console.log('\nAlso add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET (the same two values from your local .env) to both places — all 3 are required.\n');
  } catch (err) {
    console.error('Token exchange failed:', err.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT);
