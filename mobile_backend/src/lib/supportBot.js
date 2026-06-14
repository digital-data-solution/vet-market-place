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
      `• Profile and listing updates\n\n` +
      `Just describe your issue and I'll respond right away — or escalate to our team if I can't help!`,
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
