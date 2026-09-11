import React from 'react';
import { Composition } from 'remotion';
import { FeatureComparison, TIER_DURATION_FRAMES } from './FeatureComparison.jsx';
import { PLAN_TIERS, TIER_ORDER } from '../config/plans.js';

// Real bug found via frame-QA (2026-09-11): Remotion passes defaultProps
// through JSON serialization to reach the browser render context, and
// JSON.stringify(Infinity) === 'null' — so plans.js's Infinity caps
// (Enterprise tier) silently became `null` on the far side, and the
// component's `value === Infinity` check never matched, rendering nothing
// instead of "Unlimited". Converting to the string 'Unlimited' here,
// before it ever needs to survive serialization, instead of trying to
// special-case null downstream.
const tiers = TIER_ORDER.map((key) => {
  const t = PLAN_TIERS[key];
  return {
    ...t,
    maxPatients: t.maxPatients === Infinity ? 'Unlimited' : t.maxPatients,
    maxProducts: t.maxProducts === Infinity ? 'Unlimited' : t.maxProducts,
    maxSeats: t.maxSeats === Infinity ? 'Unlimited' : t.maxSeats,
  };
});

export const RemotionRoot = () => (
  <Composition
    id="FeatureComparison"
    component={FeatureComparison}
    durationInFrames={tiers.length * TIER_DURATION_FRAMES}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{ tiers }}
  />
);
