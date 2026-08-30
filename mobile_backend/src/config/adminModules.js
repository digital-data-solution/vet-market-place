// Single source of truth for every grantable admin-dashboard module. Both
// AdminStaffAccount's `modules` enum and every route's requireModule(Read)
// gate import MODULE_KEYS from here — adding a module is a one-file change.
//
// Staff-management itself (this file's consumers: admin.staff.*) is
// deliberately NOT a module here — it's owner-only, always. A staff account
// must never be able to grant itself (or anyone else) more access; see
// requireOwner in middlewares/adminAuthMiddleware.js.
export const MODULES = [
  { key: 'analytics',      label: 'Analytics & Reports',        description: 'Overview, revenue, growth, geographic, referrals, practice, content, messaging, email and system-health dashboards — all read-only.' },
  { key: 'verifications',  label: 'Professional Verifications', description: 'Review, approve, reject and manage vet/kennel/shop professional profiles.' },
  { key: 'users',          label: 'Users',                      description: 'View users, change roles, delete accounts, grant subscriptions.' },
  { key: 'shops',          label: 'Shops',                      description: 'View and remove shop listings.' },
  { key: 'subscriptions',  label: 'Subscriptions',               description: 'View and cancel user/professional subscriptions.' },
  { key: 'wallet',         label: 'Wallet & Disputes',           description: 'Escrow transactions and dispute resolution — real money.' },
  { key: 'support',        label: 'Support Inbox',               description: 'Read and reply to user support threads.' },
  { key: 'marketplace',    label: 'Xpress Market',               description: 'Moderate listings and reports on the buy/sell marketplace.' },
  { key: 'jobs',           label: 'Job Board',                   description: 'Moderate job postings.' },
  { key: 'notifications',  label: 'Push Notifications',          description: 'Compose and send push notifications to users.' },
  { key: 'emailcampaigns', label: 'Email Campaigns',             description: 'Compose and send marketing emails to users.' },
  { key: 'academy',        label: 'Academy Courses',             description: 'Review Xpress Digital Academy course-publish drafts.' },
  { key: 'blog',           label: 'Blog',                        description: 'Write, publish and email out blog posts.' },
  { key: 'exports',        label: 'Data Exports',                description: 'Download raw CSV exports of users/subscriptions/professionals — contains PII, kept separate from Analytics deliberately.' },
];

export const MODULE_KEYS = MODULES.map((m) => m.key);
