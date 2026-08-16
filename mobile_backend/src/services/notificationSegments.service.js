/**
 * notificationSegments.service.js
 *
 * Registry of "intelligent" audience segments for admin-sent push
 * notifications (see api/admin.notifications.controller.js). Each segment
 * resolves to a MongoDB filter on `User` — reachability (has a saved
 * pushToken) is applied on top by the caller, not baked in here, so counts
 * shown to the admin can also report the "but only N are reachable" gap.
 *
 * Several of these deliberately mirror the targeting already proven out in
 * jobs/marketingCampaigns.js (e.g. "never boosted", "never funded wallet")
 * so the same notion of a segment is consistent whether it's an automatic
 * weekly email or a one-off push the admin sends by hand.
 */

import User from '../models/User.js';
import Professional from '../models/Professional.js';
import Listing from '../models/Listing.js';
import Transaction from '../models/Transaction.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Each entry: { key, label, description, marketing (bool — respects
// marketingOptOut when true), getFilter: async () => MongoDB filter for User }
const SEGMENTS = [
  {
    key: 'all',
    label: 'Everyone',
    description: 'All users (respects marketing opt-out).',
    marketing: true,
    getFilter: async () => ({}),
  },
  {
    key: 'role_vet',
    label: 'Vets',
    description: 'Users with role = vet.',
    marketing: false,
    getFilter: async () => ({ role: 'vet' }),
  },
  {
    key: 'role_shop_owner',
    label: 'Shop owners',
    description: 'Users with role = shop_owner.',
    marketing: false,
    getFilter: async () => ({ role: 'shop_owner' }),
  },
  {
    key: 'role_kennel_owner',
    label: 'Kennel owners',
    description: 'Users with role = kennel_owner.',
    marketing: false,
    getFilter: async () => ({ role: 'kennel_owner' }),
  },
  {
    key: 'role_pet_owner',
    label: 'Pet owners',
    description: 'Users with role = pet_owner.',
    marketing: false,
    getFilter: async () => ({ role: 'pet_owner' }),
  },
  {
    key: 'inactive_14d',
    label: 'Inactive 14+ days',
    description: 'Last login (or signup, if never tracked) was 14+ days ago.',
    marketing: true,
    getFilter: async () => {
      const cutoff = new Date(Date.now() - 14 * DAY_MS);
      return {
        $or: [
          { lastLoginAt: { $lte: cutoff } },
          { lastLoginAt: null, createdAt: { $lte: cutoff } },
        ],
      };
    },
  },
  {
    key: 'inactive_30d',
    label: 'Inactive 30+ days',
    description: 'Last login (or signup, if never tracked) was 30+ days ago.',
    marketing: true,
    getFilter: async () => {
      const cutoff = new Date(Date.now() - 30 * DAY_MS);
      return {
        $or: [
          { lastLoginAt: { $lte: cutoff } },
          { lastLoginAt: null, createdAt: { $lte: cutoff } },
        ],
      };
    },
  },
  {
    key: 'subscription_expiring_3d',
    label: 'Subscription expiring within 3 days',
    description: 'Active subscription ending in the next 3 days — good candidates for a renewal nudge.',
    marketing: false,
    getFilter: async () => {
      const now = new Date();
      const soon = new Date(Date.now() + 3 * DAY_MS);
      return {
        'subscription.status': 'active',
        'subscription.endDate': { $gte: now, $lte: soon },
      };
    },
  },
  {
    key: 'subscription_expired',
    label: 'Subscription expired',
    description: 'Subscription status is expired — win-back candidates.',
    marketing: true,
    getFilter: async () => ({ 'subscription.status': 'expired' }),
  },
  {
    key: 'never_listed',
    label: 'Never posted a Market listing',
    description: 'Same targeting as the automatic Xpress Market launch email — anyone who could sell but never has.',
    marketing: true,
    getFilter: async () => {
      const sellerIds = await Listing.distinct('seller');
      return { _id: { $nin: sellerIds }, role: { $ne: 'admin' } };
    },
  },
  {
    key: 'never_used_wallet',
    label: 'Never used the Wallet',
    description: 'Same targeting as the automatic Wallet promo email — no Transaction on record.',
    marketing: true,
    getFilter: async () => {
      const usedWalletIds = await Transaction.distinct('user', { user: { $ne: null } });
      return { _id: { $nin: usedWalletIds }, role: { $ne: 'admin' } };
    },
  },
  {
    key: 'vets_unverified',
    label: 'Vets pending verification',
    description: 'Vet accounts whose Professional listing is not yet verified — a nudge to complete verification.',
    marketing: false,
    getFilter: async () => {
      const userIds = await Professional.distinct('userId', { role: 'vet', isVerified: false });
      return { _id: { $in: userIds } };
    },
  },
  {
    key: 'business_addon_none',
    label: 'No Business Suite add-on',
    description: 'Shop/vet/kennel owners with no active Business Suite add-on.',
    marketing: false,
    getFilter: async () => {
      const now = new Date();
      return {
        role: { $in: ['shop_owner', 'vet', 'kennel_owner'] },
        $or: [
          { 'businessAddon.activeUntil': null },
          { 'businessAddon.activeUntil': { $exists: false } },
          { 'businessAddon.activeUntil': { $lt: now } },
        ],
      };
    },
  },
];

const SEGMENT_MAP = new Map(SEGMENTS.map((s) => [s.key, s]));

export function listSegmentDefinitions() {
  return SEGMENTS.map(({ key, label, description, marketing }) => ({ key, label, description, marketing }));
}

export function getSegment(key) {
  return SEGMENT_MAP.get(key) || null;
}

/**
 * Resolves a segment key to a concrete User filter, layering in the
 * marketingOptOut exclusion when the segment is flagged `marketing`.
 */
export async function resolveSegmentFilter(key) {
  const segment = getSegment(key);
  if (!segment) return null;
  const filter = await segment.getFilter();
  if (segment.marketing) {
    filter.marketingOptOut = { $ne: true };
  }
  return filter;
}

/**
 * Wraps a User filter so it also requires a live push channel (Expo token OR
 * web subscription). Uses $and rather than spreading an `$or` key directly,
 * since several segment filters already have their own top-level `$or` —
 * spreading a second `$or` in the same object would silently clobber it.
 */
export function reachableFilter(filter) {
  return {
    $and: [
      filter,
      {
        $or: [
          { pushToken: { $nin: [null, ''] } },
          { 'webPushSubscription.endpoint': { $nin: [null, ''] } },
        ],
      },
    ],
  };
}

export default { listSegmentDefinitions, getSegment, resolveSegmentFilter, reachableFilter };
