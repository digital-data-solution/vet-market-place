// ─────────────────────────────────────────────────────────────────────────────
// ENTITLEMENTS — per-account module access ("what this business can use").
//
// The admin dashboard provisions an enterprise and ticks exactly which modules
// it may access (VIP / negotiated onboarding). The mobile app reads the resolved
// map (via /api/auth/me and /api/v1/business/reports/settings) to show or hide
// each module's entry tiles. Backend writes ALSO respect these flags where it
// matters, so a disabled module is truly off, not just hidden.
//
// BACKWARD COMPATIBILITY IS THE RULE: an account that was never provisioned
// (entitlements.provisioned !== true) gets EVERYTHING its role can use — exactly
// how the app behaved before this layer existed. Nobody gets locked out by the
// mere introduction of entitlements. Only an explicit provisioning takes effect.
// ─────────────────────────────────────────────────────────────────────────────

// The full module registry. `roles` lists which account roles the module is
// meaningful for (used to compute sensible defaults and to render the admin
// checkboxes). Order here is the order shown in the dashboard + settings.
export const MODULES = [
  { key: 'marketplace',      label: 'Vet Marketplace',   description: 'Appear in / browse the professional directory', roles: ['vet', 'kennel_owner', 'shop_owner', 'pet_owner'] },
  { key: 'xpressMarket',     label: 'Xpress Market',     description: 'Buy & sell pets and products (classifieds)',     roles: ['vet', 'kennel_owner', 'shop_owner', 'pet_owner'] },
  { key: 'wallet',           label: 'Wallet & Escrow',   description: 'In-app wallet, escrow payments, withdrawals',    roles: ['vet', 'kennel_owner', 'shop_owner', 'pet_owner'] },
  { key: 'boost',            label: 'Boost / Featured',  description: 'Pay to feature a listing at the top of search',  roles: ['vet', 'kennel_owner', 'shop_owner'] },
  { key: 'businessSuite',    label: 'Business Suite',    description: 'Inventory, POS/sales, staff reps, audit trail',  roles: ['vet', 'kennel_owner', 'shop_owner'] },
  { key: 'reports',          label: 'Reports & Receipts',description: 'Receipts, day-close, monthly balancing, CSV',    roles: ['vet', 'kennel_owner', 'shop_owner'] },
  { key: 'practiceRecords',  label: 'Practice Records',  description: 'Clients, patients, treatments, vaccinations',    roles: ['vet'] },
  { key: 'hospitalization',  label: 'Hospitalization',   description: 'Admit animals to wards, daily care, discharge',  roles: ['vet'] },
  { key: 'surgery',          label: 'Surgery',           description: 'Surgical procedure records',                     roles: ['vet'] },
  { key: 'grooming',         label: 'Grooming',          description: 'Grooming service records & appointments',        roles: ['vet', 'kennel_owner', 'shop_owner'] },
];

export const MODULE_KEYS = MODULES.map((m) => m.key);

/** Which modules a role can meaningfully use — the default "everything on" set. */
export function defaultModulesForRole(role) {
  const out = {};
  for (const m of MODULES) out[m.key] = m.roles.includes(role);
  return out;
}

/**
 * Resolve the effective entitlements map for a user.
 * @param {object} user  User doc (needs .role and .entitlements)
 * @returns {{provisioned:boolean, modules:Object<string,boolean>}}
 *
 * - Not provisioned  → all role-appropriate modules ON (legacy behaviour).
 * - Provisioned      → exactly the stored flags (missing keys read as false).
 */
export function resolveEntitlements(user) {
  const role = user?.role || 'pet_owner';
  const ent = user?.entitlements;
  const provisioned = !!ent?.provisioned;

  if (!provisioned) {
    return { provisioned: false, modules: defaultModulesForRole(role) };
  }

  // Stored map may be a Mongoose Map/subdoc or a plain object; normalise it.
  const stored = ent.modules?.toObject?.() || ent.modules || {};
  const modules = {};
  for (const key of MODULE_KEYS) modules[key] = !!stored[key];
  return { provisioned: true, modules };
}

/** True if a specific module is enabled for the user (server-side guard). */
export function hasModule(user, key) {
  return !!resolveEntitlements(user).modules[key];
}
