// ─────────────────────────────────────────────────────────────────────────────
// PLAN TIERS — usage-capped pricing so the product scales from a one-person vet
// to a 100-staff hospital, and big "whales" pay accordingly (everywhere).
//
// Caps are enforced when creating records (patients, products, staff seats). When
// an account would exceed its tier, the API returns 402 UPGRADE_REQUIRED naming
// the next tier — usage self-escalates pricing. Small clinics stay on cheap tiers.
//
// Backward compatible: existing paying customers (legacy businessAddon /
// practiceAddon active) with no explicit tier are treated as 'clinic' so nothing
// they rely on suddenly caps. Enterprise = unlimited, proposal-priced.
// ─────────────────────────────────────────────────────────────────────────────
const INF = Number.POSITIVE_INFINITY;

export const PLAN_TIERS = {
  free: {
    key: 'free', label: 'Free', order: 0,
    maxPatients: 5, maxProducts: 15, maxSeats: 2,
    priceNGN: 0, priceUSD: 0,
  },
  starter: {
    key: 'starter', label: 'Starter', order: 1,
    maxPatients: 50, maxProducts: 150, maxSeats: 3,
    priceNGN: 5000, priceUSD: 49,
  },
  clinic: {
    key: 'clinic', label: 'Clinic', order: 2,
    maxPatients: 300, maxProducts: 600, maxSeats: 8,
    priceNGN: 15000, priceUSD: 149,
  },
  hospital: {
    key: 'hospital', label: 'Hospital', order: 3,
    maxPatients: 3000, maxProducts: 5000, maxSeats: 40,
    priceNGN: 60000, priceUSD: 499,
  },
  enterprise: {
    key: 'enterprise', label: 'Enterprise', order: 4,
    maxPatients: INF, maxProducts: INF, maxSeats: INF,
    priceNGN: null, priceUSD: null, // custom / proposal
  },
};

export const TIER_ORDER = ['free', 'starter', 'clinic', 'hospital', 'enterprise'];

/** Is an explicit paid tier currently active? (free is always "active".) */
function tierActive(plan) {
  if (!plan?.tier || plan.tier === 'free') return plan?.tier === 'free';
  return !!(plan.activeUntil && new Date(plan.activeUntil) > new Date());
}

/**
 * Resolve the effective tier for a User, honouring explicit tiers first and
 * falling back to legacy add-ons for backward compatibility.
 * @param {object} user            User doc (plan, businessAddon)
 * @param {boolean} legacyAddonActive  practiceAddon/businessAddon currently active
 */
export function resolveTier(user, legacyAddonActive = false) {
  const plan = user?.plan;
  if (plan?.tier && tierActive(plan)) return PLAN_TIERS[plan.tier] || PLAN_TIERS.free;
  if (legacyAddonActive) return PLAN_TIERS.clinic; // legacy paid → treat as Clinic
  return PLAN_TIERS.free;
}

/** The next tier up from a given tier key (for upgrade prompts). */
export function nextTier(tierKey) {
  const i = TIER_ORDER.indexOf(tierKey);
  return i >= 0 && i < TIER_ORDER.length - 1 ? PLAN_TIERS[TIER_ORDER[i + 1]] : PLAN_TIERS.enterprise;
}

/** Public-safe tier list for pricing screens. */
export function publicTiers() {
  return TIER_ORDER.map((k) => {
    const t = PLAN_TIERS[k];
    return {
      key: t.key, label: t.label,
      maxPatients: t.maxPatients === INF ? null : t.maxPatients,
      maxProducts: t.maxProducts === INF ? null : t.maxProducts,
      maxSeats: t.maxSeats === INF ? null : t.maxSeats,
      priceNGN: t.priceNGN, priceUSD: t.priceUSD,
    };
  });
}
