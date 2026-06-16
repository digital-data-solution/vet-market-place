# Xpress Vet Marketplace

Nigeria's pet care marketplace — connecting pet owners with verified vets, kennels, and pet shops.

Backend API: `https://vet-market-place-jsj5.onrender.com` · Website: `https://xpressvetmarketplace.com`

---

## Repos & Deployments

| Repo | Render service | Purpose |
|---|---|---|
| `vet-market-place` | Web Service (`vet-market-place-jsj5`) | Express backend API only |
| `Vet-mobile-app` | Static Site (custom domain `xpressvetmarketplace.com`) | Built directly from this repo — see below |

`mobile_app/` is also a git **submodule** inside the `vet-market-place` backend repo (kept in sync for reference), but the **live website is no longer served from `mobile_backend/public/`** — it's a standalone Render Static Site that builds straight from `Vet-mobile-app`.

**Static Site settings (Render dashboard):**
- Build command: `npm install && npm run export`
- Publish directory: `dist`
- Redirects/Rewrites: Source `/*` → Destination `/index.html` → Action **Rewrite** (required for SPA routing on refresh/deep links — Render static sites do **not** read a `_redirects` file, only this dashboard rule)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Expo React Native 54 (web + iOS + Android), TypeScript |
| Navigation | React Navigation v7 (Stack + Bottom Tabs) |
| Backend | Node.js + Express 5, ES Modules |
| Database | MongoDB Atlas 7 (Mongoose 9) + 2dsphere geolocation |
| Auth | Supabase (JWT — verified server-side via `supabaseAdmin.auth.getUser`) |
| Real-time | Supabase Realtime (chat) |
| Images | Cloudinary |
| Payments | Paystack (card, bank transfer, USSD, mobile money, QR) |
| Email | Resend (`noreply@xpressvetmarketplace.com`) |
| Cache | Redis (RedisLabs) |
| Rate limiting | express-rate-limit |
| Cron | node-cron |

---

## User Roles

| Role | Assigned when |
|---|---|
| `pet_owner` | Default on register |
| `vet` / `kennel_owner` | After completing ProfessionalOnboardingScreen |
| `shop_owner` | After completing ShopOnboardingScreen |
| `admin` | Set manually in DB |

Role is a single string field `User.role` — not an array.

---

## Subscription Plans

### Pet Owners
| Plan | Price | Access |
|---|---|---|
| Free | ₦0 | Browse listings (redacted contact info) |
| Premium (`user_premium`) | ₦1,500/mo | Full contacts, GPS search, messaging |

### Professionals / Shops
| Plan | Price | Perks |
|---|---|---|
| Basic | ₦1,500/mo | Listed in search, full profile |
| Starter | ₦2,500/mo | Higher placement |
| Pro | ₦5,000/mo | Featured badge + sorted to top |

**Messaging is bundled into Premium** — no separate messaging add-on exists.

### Freemium model (vets list only)
`GET /api/v1/professionals/list` and `/nearby` use `attachSubscription` (soft — never blocks). Unsubscribed users receive redacted teaser results plus one free full search. Kennels and shops use `enforceSubscription` (hard 402 gate).

---

## Key API Routes

```
# Auth
GET   /api/auth/me                          current user (protect)
GET   /api/auth/referral-info               get / generate referral code (protect)
GET   /api/auth/public-profile/:supabaseId  public profile (protect, no sub gate)
PUT   /api/auth/update-profile              update profile

# Professionals
POST  /api/v1/professionals/onboard         create profile
PUT   /api/v1/professionals/profile         update profile (must own)
GET   /api/v1/professionals/me              my profile
GET   /api/v1/professionals/list            list — protect + attachSubscription (freemium)
GET   /api/v1/professionals/nearby          nearby — protect + attachSubscription (freemium)
GET   /api/v1/professionals/:id             full profile — protect + enforceSubscription

# Kennels
GET   /api/v1/kennels/list                  protect + enforceSubscription
GET   /api/v1/kennels/nearby                protect + enforceSubscription
GET   /api/v1/kennels/:id                   protect + enforceSubscription

# Shops
GET   /api/v1/shops/list                    protect + enforceSubscription
GET   /api/v1/shops/nearby                  protect + enforceSubscription
GET   /api/v1/shops/:id                     protect + enforceSubscription

# Messaging (server-side only — client never writes directly to Supabase)
POST  /api/messages/send                    protect + enforceSubscription + 30 req/min

# Subscriptions
GET   /api/subscriptions/pricing            public
GET   /api/subscriptions/me                 current subscription
POST  /api/subscriptions/user               pet owner payment init
POST  /api/subscriptions/professional       professional payment init
GET   /api/subscriptions/verify             manual payment fallback
DELETE /api/subscriptions/cancel            soft cancel
POST  /api/subscriptions/webhook            Paystack webhook (HMAC-SHA512)

# Upload
POST  /api/upload/media                     Cloudinary → saves to User.mediaImages
DELETE /api/upload/delete                   delete from Cloudinary
```

---

## Messaging Architecture

1. `ChatScreen` calls `POST /api/messages/send` via `apiFetch`
2. Backend runs `protect` → `enforceSubscription` → inserts via `supabaseAdmin` (service role, bypasses RLS)
3. Rate limiter: 30 req/min keyed by MongoDB user ID
4. Supabase Realtime delivers the message to the recipient's open channel

This means subscription is always enforced server-side — the mobile client never writes directly to Supabase.

---

## Media / Gallery

Uploaded images go to **Cloudinary** and are stored in `User.mediaImages` as `{ url, publicId }[]` objects.

`Professional.images` is a separate legacy field (plain string URLs). The gallery on `ProfessionalOnboardingScreen` reads from `User.mediaImages` (exposed at the top level of `GET /api/v1/professionals/me`).

---

## Cron Jobs

| Job | Schedule (UTC) | Action |
|---|---|---|
| Licence check | 23:00 daily | Expire vet licences past expiry date |
| Expiry reminders | 08:00 daily | Email at 7, 3, 1 day before sub expires |
| Expired notices | 08:05 daily | Email on the day subscription expires |
| Pending cleanup | 00:00 daily | Cancel pending payments older than 48h |

---

## Local Development

```bash
# Backend
cd mobile_backend
npm install
# fill in .env (see Environment Variables below)
npm run dev          # nodemon — restarts on file change

# Frontend
cd mobile_app
npm install
npx expo start --lan # scan QR with Expo Go, or press w for web
```

> MongoDB Atlas: your local IP must be whitelisted in Atlas → Network Access. On Render this is not needed (Render IPs are pre-whitelisted).

---

## Environment Variables

### Backend (`mobile_backend/.env`)
```
MONGODB_URI
REDIS_URL
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
PAYSTACK_SECRET_KEY
PAYSTACK_CALLBACK_URL
RESEND_API_KEY
JWT_SECRET
NODE_ENV
PORT
```

### Frontend (`mobile_app/.env.local`)
```
EXPO_PUBLIC_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_ANON_KEY
EXPO_SUPABASE_SERVICE_ROLE_KEY
EXPO_PUBLIC_BACKEND_URL
EXPO_PUBLIC_DEBUG_MODE
EXPO_PUBLIC_API_TIMEOUT
```

---

## Deploy Workflow

Render auto-deploys from **both** `main` and `master` — always push to both.

```bash
# Backend push
git push origin main
git checkout master && git merge main --no-edit && git push origin master && git checkout main

# After mobile_app commits — update submodule pointer in backend repo
cd mobile_app && git push origin main && cd ..
git add mobile_app
git commit -m "chore: advance mobile_app submodule"
git push origin main
git checkout master && git merge main --no-edit && git push origin master && git checkout main
```

### Web build (updates xpressvetmarketplace.com)
The Render Static Site builds and deploys automatically on every push to `Vet-mobile-app` main — no manual export/commit of build output needed. Just commit source changes in `mobile_app/` and push:
```bash
cd mobile_app
git add -A && git commit -m "..." && git push origin main
```
Render runs `npm install && npm run export` (= `expo export --platform web --clear`) and publishes `dist/` automatically.

---

## Supabase Auth Configuration

Dashboard → Authentication → URL Configuration:
- **Site URL**: `https://xpressvetmarketplace.com`
- **Redirect URLs**:
  - `https://xpressvetmarketplace.com/auth/callback`
  - `xpressvet://auth/callback`
  - `http://localhost:8081/auth/callback`

---

## Admin

- Dashboard: `https://vet-market-place-jsj5.onrender.com/admin`
- HTML: `mobile_backend/src/admin-dashboard.html`
- Login: `omalesamuel4god@gmail.com` / `XpressVet@Admin2026`

---

## Known Issues / Tech Debt

| Issue | Severity | Fix |
|---|---|---|
| Geocoding 429s (Nominatim rate limit) | Medium | Upgrade to Mapbox or Google Maps — only the axios URL needs changing |
| Mongoose duplicate `supabaseId` index warning | Low | Remove either `index: true` from field or the separate `schema.index()` call |
| Native deep links need `eas build` | Low | `scheme: "xpressvet"` set in `app.json`; web links work already |

---

## Changelog

### Sessions 1–4 (2026-06-10 to 2026-06-11)
- Fixed `ProfessionalOnboardingScreen` import, typing, and role bugs
- Fixed shop owner update/delete routes (`/me/shop` pattern)
- Fixed trailing space in `.env.local` breaking Supabase auth on dev
- Fixed CSP `connectSrc` missing Supabase + `blob:` domains
- Fixed `syncUser` to sync `isVerified` on every login (not only on insert)
- Fixed `TouchableOpacity` → `Pressable` for web click events
- Fixed email verify + password reset deep links and `EmailVerifiedScreen` flow
- Fixed `Alert.alert` multi-button → `window.confirm()` on web
- Fixed `Professional.js` pre-save hook `next is not a function` crash
- Fixed SPA catch-all route for `/auth/callback` returning 404
- Fixed `bcrypt` dynamic import in ESM context
- Fixed subscription screen — added Free + Basic to professional plan list
- Fixed Render deploy — now pushes to both `main` and `master`
- Added referral system + real-time chat

### Session 5 (2026-06-12 to 2026-06-13)

**Security**
- `GET /api/v1/professionals/:id` — added missing `protect`; was returning 401 for all requests because `enforceSubscription` ran without a user on the request
- `GET /api/v1/kennels/:id` — added `protect` + `enforceSubscription`; route was fully open to unauthenticated callers

**Messaging pricing revert**
- Removed `createMessagingSubscription`, `getMessagingSubscription`, `activateMessagingSubscription` handlers
- Removed `enforceMessagingSubscription` middleware
- Removed `POST /subscriptions/messaging` and `GET /subscriptions/messaging/me` routes
- Removed messaging branches from Paystack webhook handler and `verifyPayment`
- Removed messaging cron job blocks from all three subscription reminder jobs
- Removed messaging UI from `SubscriptionScreen`
- Messaging is now bundled into the existing ₦1,500 Premium plan — no separate add-on

**Referral fix**
- `getReferralInfo` generates a referral code on-demand for users who registered before the feature existed
- Uses `findByIdAndUpdate` (not `.save()`) to avoid triggering the password-hashing pre-save hook

**Gallery fix**
- `getMyProfessionalProfile` now populates `mediaImages` from `userId` and exposes it at the top level
- `ProfessionalOnboardingScreen` reads `p.mediaImages` instead of `p.images` — fixes the mismatch where uploads went to `User.mediaImages` but the screen read from `Professional.images`

**Secure messaging send endpoint**
- New `POST /api/messages/send`: `protect` → `enforceSubscription` → `supabaseAdmin` insert (service role)
- `ChatScreen` updated to call this endpoint via `apiFetch` instead of writing directly to Supabase client
- Rate limiter: 30 req/min keyed by MongoDB user ID (not IP, to avoid false positives on shared IPs)

**SubscriptionPrompt rollout**
- `SubscriptionPrompt` gains `customMessage?` and `requiredPlan?` props for per-screen copy
- List screens (`ProfessionalsScreen`, `KennelsScreen`, `ShopsScreen`): Alert-based gates replaced with full-screen `SubscriptionPrompt` + loading spinner while check resolves
- Profile screens (`VetProfileScreen`, `KennelProfileScreen`, `ShopProfileScreen`): 402 from detail fetch now shows `SubscriptionPrompt` instead of generic "Profile Unavailable" error
- Removed dead `goToSubscription` helpers from `KennelsScreen` and `ShopsScreen`

### Session 8 (2026-06-16) — website refresh/blank-page + redirect loop

Settled the website's serving architecture (after trying: backend-served `public/`, then a pre-built-files static site, then back to building from `mobile_app`) as a **Render Static Site building directly from `Vet-mobile-app`**, publish dir `dist`. Fixes along the way:
- `navigation/index.tsx`: `class NavigationErrorBoundary extends Component` was missing its opening `<` for generic type params — broke the TSX parse, blocked every build
- Added `export` npm script (`expo export --platform web --clear`) so Render's build command can be `npm install && npm run export`
- Confirmed Render static sites **do not support a `_redirects` file** at all (despite docs/community posts implying otherwise) — removed the dead file; SPA fallback routing only works via the dashboard Redirects/Rewrites rule (`/* → /index.html`, Action **Rewrite**)
- That dashboard rule had two successive typos that broke it: a stray ` 200` appended to the Destination (copied from Netlify `_redirects` syntax, which Render doesn't use) caused an actual redirect loop (`ERR_TOO_MANY_REDIRECTS`, browser URL literally became `/index.html%20200`); after fixing that, a leftover **trailing space** in the Destination still caused every non-root path to return `200 OK` with an empty body (Render forces 200 on a matched Rewrite rule even when the destination path fails to resolve — it doesn't 404)
- `getInitialURL`'s async `supabase.auth.getSession()` call was blocking React Navigation from rendering anything on deep-link refresh (blank screen) — fixed with a module-level `_bootstrapSession` cache set synchronously by `bootstrap()` before `setLoading(false)`
- Post-login redirect now uses `window.history.replaceState` instead of `window.location.href` (avoids a full page reload that re-triggered the redirect-saving logic in `getInitialURL`, which was causing `ERR_TOO_MANY_REDIRECTS`); `getInitialURL` now only persists non-root paths to `sessionStorage` as redirect targets

All deep-link routes verified server-side post-fix (curl, cache-busted): `/`, `/home`, `/professionals`, `/kennels`, `/shops`, `/profile`, `/services`, `/messages`, `/subscription`, `/network`, `/verify`, `/VetProfile`, `/ShopProfile`, `/KennelProfile`, `/ServiceProfile`, `/ExploreOptions`, `/VerifyProfessional`, `/auth/callback`, `/auth/login`, `/auth/register`, `/privacy-policy`, `/terms-and-conditions`, `/support` — all return `200` with the correct 1319-byte `index.html`. Backend `/health` and the JS bundle itself also verified serving correctly.

---

## License

Private — all rights reserved.
