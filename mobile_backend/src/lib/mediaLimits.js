// ─────────────────────────────────────────────────────────────────────────────
// MEDIA LIMITS — single source of truth for how many gallery images (User.mediaImages)
// each role may keep on each plan. Used both when ENFORCING uploads (uploadRoutes)
// and when RECLAIMING storage after a plan lapses (jobs/mediaCleanup).
// plan keys match user.subscription.plan enum values + the 'free' default.
// ─────────────────────────────────────────────────────────────────────────────
export const MEDIA_LIMITS = {
  vet:                { free: 3,  basic: 5,  starter: 10, pro: 30 },
  kennel_owner:       { free: 5,  basic: 8,  starter: 15, pro: 50 },
  shop_owner:         { free: 5,  basic: 8,  starter: 20, pro: 75 },
  groomer:            { free: 4,  basic: 8,  starter: 15, pro: 40 },
  trainer:            { free: 4,  basic: 8,  starter: 15, pro: 40 },
  pet_sitter:         { free: 4,  basic: 8,  starter: 15, pro: 40 },
  pet_transport:      { free: 5,  basic: 10, starter: 20, pro: 50 },
  cremation_service:  { free: 5,  basic: 10, starter: 20, pro: 50 },
  agro_vet_supplier:  { free: 5,  basic: 10, starter: 25, pro: 75 },
  insurance_provider: { free: 3,  basic: 6,  starter: 12, pro: 30 },
  pet_pharmacy:       { free: 4,  basic: 8,  starter: 15, pro: 40 },
  rescue_center:      { free: 5,  basic: 10, starter: 20, pro: 50 },
  pet_hotel:          { free: 5,  basic: 8,  starter: 15, pro: 50 },
  farm:               { free: 5,  basic: 10, starter: 25, pro: 75 },
  pet_owner:          { free: 2,  user_premium: 8 },
};

// Legacy pet_owner plan names can end up on professional accounts (subscription created
// before plan renaming). Normalize them to the equivalent professional tier so limits
// resolve correctly instead of falling back to 'free'.
export const PROFESSIONAL_ROLES = new Set([
  'vet', 'kennel_owner', 'shop_owner',
  'groomer', 'trainer', 'pet_sitter',
  'pet_transport', 'cremation_service', 'agro_vet_supplier', 'insurance_provider',
  'pet_pharmacy', 'rescue_center', 'pet_hotel', 'farm',
]);

export function normalizePlan(role, plan) {
  if (PROFESSIONAL_ROLES.has(role) && (plan === 'user_monthly' || plan === 'user_premium')) {
    return 'basic';
  }
  if (role === 'pet_owner' && plan === 'user_monthly') {
    return 'user_premium';
  }
  return plan;
}

export function getLimitsForUser(role, plan) {
  const normalized = normalizePlan(role, plan);
  const roleLimits = MEDIA_LIMITS[role] ?? MEDIA_LIMITS.pet_owner;
  const maxImages  = roleLimits[normalized] ?? roleLimits.free;
  return { roleLimits, maxImages };
}

// The free-tier gallery allowance for a role — what a lapsed account is trimmed back to.
export function freeLimitFor(role) {
  const roleLimits = MEDIA_LIMITS[role] ?? MEDIA_LIMITS.pet_owner;
  return roleLimits.free ?? 1;
}
