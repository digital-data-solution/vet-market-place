# Supabase Setup Instructions

## 1. Create Supabase Project
1. Go to https://supabase.com
2. Sign up/Login to your account
3. Click "New Project"
4. Fill in project details:
   - Name: `vet-marketplace`
   - Database Password: Choose a strong password
   - Region: Select closest to your users (e.g., EU West)

## 2. Get Project Credentials
After project creation, go to Settings > API:
- **Project URL**: Copy this
- **anon/public key**: Copy this

## 3. Configure SMS/OTP Authentication

### Option A: Use Supabase's Built-in SMS (Recommended for Testing)
1. In Supabase Dashboard, go to **Authentication > Settings**
2. Scroll down to **SMS Settings**
3. **Enable phone confirmations**: Turn ON
4. **SMS provider**: Select **Built-in** (for development/testing)
5. **Save changes**

**Note**: Supabase's built-in SMS works for development but has limitations:
- Limited SMS quota (100/month free)
- Only works with verified phone numbers initially
- For production, use a proper SMS provider

### Option B: Configure Twilio (Production Ready)
1. Sign up at https://twilio.com
2. Get your **Account SID**, **Auth Token**, and **Phone Number**
3. In Supabase Dashboard > Authentication > Settings:
   - **SMS provider**: Select **Twilio**
   - **Twilio Account SID**: Your Account SID
   - **Twilio Auth Token**: Your Auth Token
   - **Twilio Phone Number**: Your Twilio phone number
4. **Save changes**

### Option C: Other SMS Providers
Supabase supports:
- **Twilio** (recommended)
- **MessageBird**
- **TextLocal**
- **Vonage**

## 4. Test SMS Configuration
1. Go to **Authentication > Users** in Supabase
2. Click **Add user**
3. Enter a phone number (include country code, e.g., +2348012345678)
4. Click **Send magic link** or **Send invite**
5. Check if SMS is received

## 5. Update Your App Configuration

## 4. Update Environment Variables
Replace the placeholders in `src/api/supabase.ts`:
```typescript
const supabaseUrl = 'YOUR_SUPABASE_URL'; // Your project URL
const supabaseAnonKey = 'YOUR_SUPABASE_ANON_KEY'; // Your anon key
```

## 5. Backend Integration
For the backend to verify Supabase tokens, you'll need:
- Supabase service role key (keep secret!)
- JWT verification endpoint

## 6. Test Authentication
1. Run the app
2. Try registering with a phone number
3. Check Supabase dashboard for users