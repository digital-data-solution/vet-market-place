# Vet Marketplace Backend API Documentation

## Authentication

### POST /api/auth/register
- Registers a new user in both Supabase and MongoDB.
- Body: `{ name, email, password, phone, role, location }`
- Response: `{ message }`

### POST /api/auth/login
- Logs in a user and returns a JWT.
- Body: `{ email, password }`
- Response: `{ token, user }`

---

## Professionals

### POST /api/v1/professional/onboard
- Onboards a new professional (vet or kennel).
- Auth required (Bearer token)
- Body (vet): `{ name, vcnNumber, role: 'vet', address, specialization, ... }`
- Body (kennel): `{ name, role: 'kennel', address, ... }`
- Response: `{ success, data }`

### GET /api/v1/professional/list
- Lists all verified professionals.
- Public
- Response: `{ data: [ ... ] }`

### GET /api/v1/professional/:id
- Gets a professional by ID.
- Public
- Response: `{ data }`

---

## Shops

### POST /api/v1/shops/create
- Registers a new shop (pet shop, pharmacy, etc).
- Auth required (Bearer token)
- Body: `{ name, address, contact, services }`
- Response: `{ message, shop }`

### GET /api/v1/shops
- Lists all shops.
- Public
- Response: `{ data: [ ... ] }`

---

## Subscriptions

### POST /api/subscription/create
- Creates a new subscription for a professional or shop owner.
- Auth required (Bearer token)
- Body: `{ plan }` (plan: 'basic', 'premium', 'enterprise')
- Response: `{ success, data }`

### GET /api/subscription/me
- Gets the current user's subscription.
- Auth required
- Response: `{ success, data }`

### POST /api/subscription/activate
- Paystack webhook endpoint (raw body, signature header required)
- Internal use

---

## Conventions
- All protected endpoints require `Authorization: Bearer <token>` header.
- Error responses: `{ success: false, message, [error] }`
- All dates are ISO8601 strings.

---

For more details, see the corresponding controller and route files in `src/api/` and `src/routes/`.
