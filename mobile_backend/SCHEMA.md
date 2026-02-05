# Xpress Pet & Vet - Database Schema Documentation

## Overview
This document outlines the complete database schema for the Xpress Pet & Vet application, a location-based directory connecting pet owners with verified veterinarians and kennels in Nigeria.

## Core Models

### 1. User Model
**File:** `src/models/User.js`

```javascript
{
  name: String (required),
  email: String (required, unique),
  password: String (required, hashed),
  role: Enum ['pet_owner', 'vet', 'kennel_owner', 'admin'] (default: 'pet_owner'),
  location: {
    type: 'Point',
    coordinates: [longitude, latitude] // 2dsphere indexed
  },
  isVerified: Boolean (default: false),
  vetDetails: {
    vcnNumber: String, // Veterinary Council of Nigeria ID
    licenseExpiry: Date,
    specialization: [String]
  },
  kennelDetails: {
    cacNumber: String, // Corporate Affairs Commission Number
    capacity: Number
  },
  timestamps: true
}
```

**Relationships:**
- One-to-Many with Subscription
- Referenced in Review, Appointment models

### 2. Subscription Model
**File:** `src/models/Subscription.js`

```javascript
{
  user: ObjectId (ref: 'User', required),
  plan: Enum ['basic', 'premium'] (default: 'basic'),
  amount: Number (₦5,000 basic, ₦10,000 premium),
  status: Enum ['active', 'inactive', 'expired'] (default: 'active'),
  startDate: Date (default: now),
  endDate: Date (required),
  paymentReference: String, // Paystack reference
  timestamps: true
}
```

**Relationships:**
- Belongs to User

## Proposed Additional Models (Future Features)

### 3. Review Model
```javascript
{
  reviewer: ObjectId (ref: 'User', required), // pet_owner
  professional: ObjectId (ref: 'User', required), // vet or kennel_owner
  rating: Number (1-5, required),
  comment: String,
  serviceType: Enum ['consultation', 'surgery', 'boarding', 'grooming'],
  isVerified: Boolean (default: false), // verified booking
  timestamps: true
}
```

### 4. Appointment Model
```javascript
{
  petOwner: ObjectId (ref: 'User', required),
  professional: ObjectId (ref: 'User', required),
  serviceType: Enum ['consultation', 'vaccination', 'surgery', 'boarding'],
  scheduledDate: Date (required),
  status: Enum ['pending', 'confirmed', 'completed', 'cancelled'],
  notes: String,
  paymentStatus: Enum ['pending', 'paid', 'refunded'],
  paymentAmount: Number,
  timestamps: true
}
```

### 5. Pet Model
```javascript
{
  owner: ObjectId (ref: 'User', required),
  name: String (required),
  species: Enum ['dog', 'cat', 'bird', 'other'],
  breed: String,
  age: Number,
  weight: Number,
  medicalHistory: [{
    date: Date,
    condition: String,
    treatment: String,
    vet: ObjectId (ref: 'User')
  }],
  timestamps: true
}
```

### 6. Notification Model
```javascript
{
  recipient: ObjectId (ref: 'User', required),
  type: Enum ['appointment_reminder', 'subscription_expiry', 'review_request', 'promotion'],
  title: String (required),
  message: String (required),
  isRead: Boolean (default: false),
  data: Object, // additional context
  timestamps: true
}
```

## API Controllers Structure

### Auth Controller (`src/api/auth.controller.js`)
- `register()` - User registration with OTP
- `verifyOTP()` - Phone verification
- `login()` - JWT authentication

### Vet Controller (`src/api/vet.controller.js`)
- `getNearbyProfessionals()` - Location-based search

### Subscription Controller (`src/api/subscription.controller.js`)
- `getSubscription()` - Get user's subscription
- `createSubscription()` - Create new subscription
- `activateSubscription()` - Activate after payment

## Services Layer

### OneSignal Service (`src/services/onesignal.service.js`)
- `sendSMSOTP()` - Send verification SMS
- `verifySMSOTP()` - Verify OTP codes

### Paystack Service (Future)
- `initiatePayment()` - Start subscription payment
- `verifyPayment()` - Confirm payment completion

## Database Indexes
- `User.location`: 2dsphere index for geospatial queries
- `User.email`: unique index
- `Subscription.user`: index for user subscriptions
- `Review.professional`: index for professional reviews

## Environment Variables
```env
PORT=5000
NODE_ENV=development
MONGODB_URI=mongodb+srv://...
JWT_SECRET=xpress_super_secret_2026
ONESIGNAL_APP_ID=...
ONESIGNAL_REST_API_KEY=...
REDIS_URL=redis://localhost:6379 (optional)
```

## Migration Strategy
For future schema changes:
1. Use mongoose schema versioning
2. Implement migration scripts in `src/utils/migrations/`
3. Update seed data accordingly

Would you like me to implement any of these additional models or features?