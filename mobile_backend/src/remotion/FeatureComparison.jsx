/**
 * FeatureComparison.jsx — animated pricing-tier comparison, vertical
 * (1080x1920) for Reels/Shorts. Real content, not placeholder: reads the
 * same PLAN_TIERS data as lib/pitchOnePager.js and the actual app's
 * pricing, so this never drifts out of sync with what Xpress Vet actually
 * charges.
 *
 * First real use of Remotion in this codebase — see
 * [[claude-code-media-capabilities]] for why this exists as a separate
 * animation tier above the plain ffmpeg text-card pipeline
 * (blogVideo.service.js): Remotion gives real spring-physics/timeline
 * control that ffmpeg's drawtext can't, at the cost of a much heavier
 * render (headless Chromium vs. a single ffmpeg process).
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Sequence } from 'remotion';

const BRAND_BLUE = '#2563EB';
const DARK = '#111827';
const WHITE = '#FFFFFF';
const LIGHT_BLUE = '#DBEAFE';

const TIER_DURATION_FRAMES = 60; // 2s per tier at 30fps

function formatPrice(priceNGN) {
  if (priceNGN === null || priceNGN === undefined) return 'Custom pricing';
  if (priceNGN === 0) return 'Free';
  return `NGN ${priceNGN.toLocaleString('en-NG')}/mo`;
}

function TierCard({ tier }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({ frame, fps, config: { damping: 14, mass: 0.6 } });
  const translateY = interpolate(entrance, [0, 1], [60, 0]);
  const opacity = interpolate(entrance, [0, 1], [0, 1]);

  return (
    <AbsoluteFill style={{ backgroundColor: BRAND_BLUE, justifyContent: 'center', alignItems: 'center' }}>
      <div style={{
        transform: `translateY(${translateY}px)`,
        opacity,
        backgroundColor: WHITE,
        borderRadius: 32,
        padding: '64px 56px',
        width: 820,
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
      }}
      >
        <div style={{ color: BRAND_BLUE, fontSize: 32, fontFamily: 'Arial', fontWeight: 700, letterSpacing: 1 }}>
          XPRESS VET
        </div>
        <div style={{ color: DARK, fontSize: 72, fontFamily: 'Arial', fontWeight: 900, marginTop: 12 }}>
          {tier.label}
        </div>
        <div style={{ color: BRAND_BLUE, fontSize: 56, fontFamily: 'Arial', fontWeight: 700, marginTop: 8 }}>
          {formatPrice(tier.priceNGN)}
        </div>
        <div style={{ height: 2, backgroundColor: '#E5E7EB', margin: '32px 0' }} />
        {[
          ['Patients', tier.maxPatients],
          ['Products', tier.maxProducts],
          ['Staff seats', tier.maxSeats],
        ].map(([label, value]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
            <div style={{ color: '#6B7280', fontSize: 34, fontFamily: 'Arial' }}>{label}</div>
            <div style={{ color: DARK, fontSize: 34, fontFamily: 'Arial', fontWeight: 700 }}>
              {value}
            </div>
          </div>
        ))}
      </div>
      <div style={{
        position: 'absolute', bottom: 140, color: LIGHT_BLUE, fontSize: 30, fontFamily: 'Arial', textAlign: 'center', width: 900,
      }}
      >
        xpressvetmarketplace.com — start free, upgrade when you outgrow it
      </div>
    </AbsoluteFill>
  );
}

export function FeatureComparison({ tiers }) {
  return (
    <AbsoluteFill>
      {tiers.map((tier, i) => (
        <Sequence key={tier.key} from={i * TIER_DURATION_FRAMES} durationInFrames={TIER_DURATION_FRAMES}>
          <TierCard tier={tier} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

export { TIER_DURATION_FRAMES };
