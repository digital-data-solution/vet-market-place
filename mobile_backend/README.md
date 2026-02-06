# Mobile Backend - Vet Service

Quick start and secure configuration notes.

Required environment variables (see `.env.example`).

Run locally:

```bash
npm install
cp .env.example .env
# Edit .env and fill secrets
npm run dev
```

Paystack webhook setup:
- Configure your Paystack webhook URL to `https://<your-host>/api/subscription/activate`
- Ensure `PAYSTACK_SECRET` is set and the webhook uses the secret for signature verification.

Security notes:
- OTPs are stored in Redis with TTL; fallback to in-memory only if Redis unavailable.
- Auth endpoints are rate-limited.
- Webhooks verify HMAC signatures.
