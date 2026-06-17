/**
 * supportBot.js — rule-based FAQ responder for the Xpress Vet support inbox.
 *
 * getBotReply(text) → string | null
 *   Returns a canned response if the message matches a known pattern.
 *   Returns null when no pattern matches — caller should escalate to human.
 *
 * Add new FAQ entries freely. Order matters: first match wins.
 */

const FAQS = [
  // ── Subscription / pricing ──────────────────────────────────────────────────
  {
    patterns: [
      'subscrib', 'how much', 'price', 'pricing', 'cost', 'plan', 'premium',
      '1500', '2500', '5000', 'fee', 'payment plan', 'upgrade',
    ],
    response:
      `Here are the current Xpress Vet plans:\n\n` +
      `• **Pet Owner Premium** — ₦1,500/month: Full contact details, GPS search, and exact addresses for every vet, kennel, and shop.\n` +
      `• **Professional Starter** — ₦2,500/month: Your listing appears in search results so pet owners can find you.\n` +
      `• **Professional Pro** — ₦5,000/month: Featured badge + sorted first in all search results.\n\n` +
      `To subscribe: open the app → **Profile → Subscription**. 🐾`,
  },

  // ── Vet verification ────────────────────────────────────────────────────────
  {
    patterns: ['verify', 'vcn', 'credential', 'badge', 'approv', 'verification', 'not verified'],
    response:
      `Vet verification on Xpress Vet:\n\n` +
      `1. Go to **Profile → Verification Status** in the app\n` +
      `2. Enter your VCN number and upload supporting documents\n` +
      `3. Our admin team reviews within 24–48 business hours\n` +
      `4. Once approved, a **Verified ✅** badge appears on your profile — building trust with every pet owner who finds you.\n\n` +
      `If you've been waiting more than 3 business days, reply with your registered email and we'll check the status immediately.`,
  },

  // ── Cancellation / refund ───────────────────────────────────────────────────
  {
    patterns: ['cancel', 'unsubscrib', 'stop paying', 'stop subscription', 'refund', 'money back'],
    response:
      `To cancel your subscription:\n\n` +
      `Open the app → **Profile → Subscription → Cancel**.\n\n` +
      `Your access continues until the end of the current billing period — no further charges after cancellation. ` +
      `Your account data is preserved if you ever reactivate.\n\n` +
      `We don't offer refunds for partial months. If you believe there's a billing error, reply here with details and we'll review it.`,
  },

  // ── Listing not visible ─────────────────────────────────────────────────────
  {
    patterns: [
      'listing', 'not show', 'not appear', 'not visible', 'cannot find',
      "can't find", 'not found', 'hidden', 'profile not', 'not in search',
    ],
    response:
      `If your listing isn't visible in search results, it's usually one of these:\n\n` +
      `1. **Verification pending** — Profiles need admin approval before appearing (24–48 hours)\n` +
      `2. **No active subscription** — A Professional plan (Starter ₦2,500 or Pro ₦5,000/mo) is required for your listing to show\n` +
      `3. **Location not set** — Make sure your area/GPS coordinates are saved in your profile settings\n\n` +
      `Which applies to you? Reply with more details and we'll investigate directly.`,
  },

  // ── Payment / Paystack issues ───────────────────────────────────────────────
  {
    patterns: [
      'payment', 'paystack', 'transaction', 'not confirm', 'debit',
      'charged', 'failed', 'pending payment', 'not activated', 'still pending',
    ],
    response:
      `Payment issues on Xpress Vet go through Paystack. Here's what to check:\n\n` +
      `1. **Debited but subscription not active?** — Wait up to 5 minutes and force-refresh the app. Paystack confirmations can lag slightly.\n` +
      `2. **Payment failed?** — Ensure your card has sufficient balance and is enabled for online transactions.\n` +
      `3. **Still unresolved?** — Reply with the last 5 characters of your Paystack transaction reference and we'll trace it manually.`,
  },

  // ── Referral programme ──────────────────────────────────────────────────────
  {
    patterns: [
      'referral', 'refer', 'invite friend', 'promo code', 'discount',
      '20%', 'referral code', 'earn',
    ],
    response:
      `The Xpress Vet referral programme:\n\n` +
      `• Find your unique code under **Profile → Referral Code**\n` +
      `• When a friend signs up using your code, you both get **20% off** your next subscription\n` +
      `• Rewards are applied automatically — no manual claiming needed\n\n` +
      `There's no limit on referrals you can earn from. Share your code freely! 🐾`,
  },

  // ── Finding professionals ───────────────────────────────────────────────────
  {
    patterns: [
      'find vet', 'find kennel', 'find shop', 'search for', 'near me',
      'nearby', 'how to find', 'how to search', 'locate',
    ],
    response:
      `Finding pet care on Xpress Vet:\n\n` +
      `1. Open the **Search** tab in the app\n` +
      `2. Choose a category: Vet, Kennel, Groomer, Pet Shop, etc.\n` +
      `3. **Free users** see a preview list — upgrade to **Premium (₦1,500/mo)** to unlock full contact details and GPS distance search\n\n` +
      `If no results appear in your area, professionals there may not be listed yet — we're actively expanding across Nigeria!`,
  },

  // ── Profile / listing updates ───────────────────────────────────────────────
  {
    patterns: [
      'update profile', 'change name', 'change photo', 'edit profile',
      'update info', 'change email', 'update listing', 'edit listing',
    ],
    response:
      `To update your profile:\n\n` +
      `1. Open the app → **Profile** tab\n` +
      `2. Tap the edit icon next to your name or photo\n` +
      `3. Update your details and tap **Save**\n\n` +
      `For professionals updating a listing (services, address, hours): go to **Profile → My Listing → Edit Listing**.\n\n` +
      `Note: Your email address is tied to your login and cannot be changed from the profile editor. Reply here if you need to update it.`,
  },

  // ── Password / login issues ─────────────────────────────────────────────────
  {
    patterns: [
      'password', 'forgot password', 'reset password', 'can\'t login', 'cannot login',
      'login issue', 'sign in problem', 'locked out', 'can\'t sign in', 'forgot my',
    ],
    response:
      `To reset your password:\n\n` +
      `1. Open the app → tap **Sign In** → **Forgot Password?**\n` +
      `2. Enter your email address — we'll send a reset link immediately\n` +
      `3. Check your spam/junk folder if the email doesn't arrive within 2 minutes\n\n` +
      `If you signed up with Google, use Google Sign-In instead — there's no separate Xpress Vet password to reset.\n\n` +
      `Still locked out? Reply with your registered email address and we'll sort it manually.`,
  },

  // ── Account / registration ──────────────────────────────────────────────────
  {
    patterns: [
      'register', 'sign up', 'create account', 'new account', 'how to join',
      'join xpress', 'getting started', 'how do i start',
    ],
    response:
      `Welcome to Xpress Vet! 🐾 Getting started is easy:\n\n` +
      `1. Download the Xpress Vet app or visit **xpressvetmarketplace.com**\n` +
      `2. Tap **Create Account** — use your email or Google\n` +
      `3. Verify your email (check spam if you don't see it)\n` +
      `4. Browse vets, kennels, and pet shops — free!\n\n` +
      `To contact professionals, subscribe to **Premium (₦1,500/month)**. Professionals can list their business for free and get paying clients.`,
  },

  // ── Delete / close account ──────────────────────────────────────────────────
  {
    patterns: [
      'delete account', 'close account', 'remove account', 'deactivate', 'delete my data',
      'remove my profile', 'want to leave',
    ],
    response:
      `To delete your Xpress Vet account:\n\n` +
      `1. Open the app → **Profile → Settings → Delete Account**\n` +
      `2. Confirm the deletion — this is permanent and cannot be undone\n\n` +
      `All your data, messages, and listing information will be removed. If you have an active subscription, please cancel it first to avoid further charges.\n\n` +
      `If you can't find the option in-app, reply here with your email and we'll process the deletion for you within 24 hours.`,
  },

  // ── Upload photos / gallery ─────────────────────────────────────────────────
  {
    patterns: [
      'upload photo', 'upload image', 'upload picture', 'add photo', 'add image',
      'gallery', 'profile picture', 'profile photo', 'change photo',
    ],
    response:
      `Uploading photos on Xpress Vet:\n\n` +
      `**Profile photo:** Go to **Profile** → tap your avatar → choose from gallery or camera.\n\n` +
      `**Gallery/listing photos (professionals):** Open your profile → **Edit Listing** → tap the gallery section to upload multiple photos.\n\n` +
      `**Limits by plan:**\n` +
      `• Free: 3 photos\n` +
      `• Basic: 5 photos\n` +
      `• Starter: 10 photos\n` +
      `• Pro: 30 photos\n\n` +
      `Supported formats: JPG, PNG, WEBP (max 10 MB per image).`,
  },

  // ── Review / rating ─────────────────────────────────────────────────────────
  {
    patterns: [
      'review', 'rating', 'rate', 'leave a review', 'write a review',
      'feedback', 'star', 'stars', 'how to review',
    ],
    response:
      `How to leave a review on Xpress Vet:\n\n` +
      `1. You must have **messaged** the professional or shop at least once\n` +
      `2. Open their profile → scroll down → tap **Write a Review**\n` +
      `3. Choose a star rating (1–5) and write your experience\n\n` +
      `Reviews are public and help other pet owners make informed decisions. ` +
      `The professional can respond to your review on their end.\n\n` +
      `If you don't see the review button, make sure you've sent them a message first — that's the eligibility requirement.`,
  },

  // ── Notifications ───────────────────────────────────────────────────────────
  {
    patterns: [
      'notification', 'not receiving', 'no alert', 'push notification', 'email notification',
      'not getting', 'not notified', 'alert', 'missed message',
    ],
    response:
      `Notification troubleshooting:\n\n` +
      `**Push notifications:**\n` +
      `• iOS: Settings → Xpress Vet → Notifications → Allow\n` +
      `• Android: Settings → Apps → Xpress Vet → Notifications → Enable\n\n` +
      `**Email notifications:**\n` +
      `• Check your spam/junk folder and mark Xpress Vet as "Not Spam"\n` +
      `• Add **noreply@xpressvetmarketplace.com** to your contacts\n\n` +
      `**In-app messages:** Open the Messages tab — a red badge appears when you have unread messages.\n\n` +
      `If the issue persists after checking these, reply and we'll investigate your account directly.`,
  },

  // ── Pet health / emergency ──────────────────────────────────────────────────
  {
    patterns: [
      'emergency', 'my pet is sick', 'pet is sick', 'pet not eating', 'animal sick',
      'vet emergency', 'urgent vet', 'pet dying', 'poisoned', 'injured',
    ],
    response:
      `🚨 **If your pet needs emergency care right now:**\n\n` +
      `1. Open the app → **Home → Find a Vet Urgently** (red button at the top)\n` +
      `2. Filter by "Vet" and use your location to find the **nearest available vet**\n` +
      `3. Call them directly (Premium users get full contact details)\n\n` +
      `**Common emergency signs requiring immediate attention:**\n` +
      `• Difficulty breathing • Seizures • Unresponsiveness\n` +
      `• Severe bleeding • Suspected poisoning\n\n` +
      `We hope your pet recovers quickly 🐾 Please seek physical veterinary care immediately for life-threatening situations.`,
  },

  // ── Multiple listings / profiles ────────────────────────────────────────────
  {
    patterns: [
      'multiple listing', 'two profiles', 'two listings', 'second profile', 'another account',
      'multiple account', 'branch', 'second location',
    ],
    response:
      `Currently, Xpress Vet supports **one listing per account** for professionals and shops.\n\n` +
      `If you have multiple branches or locations, we recommend:\n` +
      `• Listing your main/busiest location in your profile\n` +
      `• Including branch details in your business description or bio\n` +
      `• Mentioning other locations in your specialization field\n\n` +
      `Support for multiple listings per account is on our roadmap! Reply here to be notified when it's available, or if you'd like to discuss your specific use case.`,
  },

  // ── App crash / bug report ──────────────────────────────────────────────────
  {
    patterns: [
      'app crash', 'crash', 'not working', 'bug', 'error', 'broken', 'freezing',
      'app is slow', 'not loading', 'blank screen', 'white screen', 'something went wrong',
    ],
    response:
      `Sorry to hear the app isn't working! Let's fix it:\n\n` +
      `**Quick fixes (try in order):**\n` +
      `1. Force-close the app and reopen it\n` +
      `2. Check your internet connection\n` +
      `3. Update the app to the latest version\n` +
      `4. Clear app cache (Android: Settings → Apps → Xpress Vet → Clear Cache)\n` +
      `5. Uninstall and reinstall the app (your data is saved to your account)\n\n` +
      `**To report a bug:** Reply here with:\n` +
      `• What you were doing when it happened\n` +
      `• Your device model and OS version\n` +
      `• A screenshot if possible\n\n` +
      `We take bug reports seriously and aim to fix issues within 48 hours. 🙏`,
  },

  // ── Generic greeting / opener ───────────────────────────────────────────────
  {
    patterns: [
      'hello', 'hi ', ' hi', '^hi$', 'hey', 'good morning', 'good afternoon',
      'good evening', 'how are', 'help me', 'i need help', 'support', 'question', 'issue', 'problem',
    ],
    response:
      `Hi! I'm the Xpress Vet support assistant 🐾\n\n` +
      `I can help with:\n` +
      `• Subscriptions & pricing\n` +
      `• Vet/professional verification\n` +
      `• Finding pet care professionals\n` +
      `• Payment issues\n` +
      `• Referral programme\n` +
      `• Password reset & account issues\n` +
      `• Uploading photos & gallery\n` +
      `• App bugs & notifications\n\n` +
      `Just describe your issue and I'll respond right away — or type **"talk to a person"** to reach our team directly!`,
  },
];

/**
 * Try to match the user's message against FAQ patterns.
 * Returns the canned response string, or null if no match.
 */
export function getBotReply(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  for (const faq of FAQS) {
    if (faq.patterns.some(p => lower.includes(p))) {
      return faq.response;
    }
  }
  return null;
}
