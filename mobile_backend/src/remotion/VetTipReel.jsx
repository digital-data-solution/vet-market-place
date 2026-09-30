import React from 'react';
import {
  AbsoluteFill, Sequence, Audio, OffthreadVideo, Img, Loop, staticFile,
  useCurrentFrame, useVideoConfig, interpolate, spring,
} from 'remotion';

// Vertical vet-tip Reel: b-roll per narrated segment, word-by-word captions
// timed from the narration's own word timestamps, branded end card.
// Props are produced by VETFRESH/instagram-videos/prepare.py and
// scripts/renderVetTipReels.mjs (which adds frame counts and media lengths).

export const FPS = 30;
export const SEGMENT_PAD_SECONDS = 0.25;
export const END_CARD_SECONDS = 4; // room to read the call to action
const BRAND = '#2563EB';
const HIGHLIGHT = '#FACC15';
const FONT = 'Arial Black, Arial, sans-serif';

export const segmentFrames = (seg) => Math.ceil((seg.duration + SEGMENT_PAD_SECONDS) * FPS);

export function calculateMetadata({ props }) {
  const total = props.segments.reduce((n, s) => n + segmentFrames(s), 0) + Math.round(END_CARD_SECONDS * FPS);
  return { durationInFrames: total, fps: FPS, width: 1080, height: 1920 };
}

// ─── Business Suite screens (2026-09-30) ─────────────────────────────────────
// Illustrations of real Business Suite features with SAMPLE data, labelled as
// such. The only existing recordings were desktop-size, empty (₦0) and showed
// a real client's name and phone number, so they can't be used publicly.
// Feature facts behind each screen: jobs/practiceReminders.js (due within 3
// days → vet alert; client email only when the vet switches it on),
// models/DayClose.js (expected vs counted cash → variance), config/plans.js.
const SUITE_INK = '#0f172a';
const SUITE_MUTED = '#64748b';
const SUITE_ACCENT = '#4338ca';

function useReveal(delayFrames) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delayFrames, fps, config: { damping: 16, stiffness: 120 }, durationInFrames: 14 });
  return { opacity: p, transform: `translateY(${(1 - p) * 30}px)` };
}

function Card({ delay, children, style }) {
  return (
    <div style={{ background: 'white', borderRadius: 22, padding: '22px 26px', boxShadow: '0 2px 10px rgba(15,23,42,0.08)', ...useReveal(delay), ...style }}>
      {children}
    </div>
  );
}

function RemindersScreen() {
  const row = (name, what, due, owner, emailOn, delay) => (
    <Card delay={delay}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 36, fontWeight: 800, color: SUITE_INK }}>{name}</div>
        <div style={{ fontSize: 24, fontWeight: 700, color: '#b45309', background: '#fef3c7', borderRadius: 30, padding: '6px 16px' }}>{due}</div>
      </div>
      <div style={{ fontSize: 28, color: SUITE_INK, marginTop: 8 }}>{what}</div>
      <div style={{ fontSize: 24, color: SUITE_MUTED, marginTop: 6 }}>Owner: {owner}</div>
      <div style={{ fontSize: 24, marginTop: 10, color: emailOn ? '#047857' : SUITE_MUTED, fontWeight: 700 }}>
        {emailOn ? '📧 Client email reminder: ON' : '📧 Client email reminder: off'}
      </div>
    </Card>
  );
  return (
    <>
      <Card delay={0} style={{ background: '#eef2ff' }}>
        <div style={{ fontSize: 30, fontWeight: 800, color: SUITE_ACCENT }}>🔔 Due in the next 3 days</div>
        <div style={{ fontSize: 24, color: SUITE_MUTED, marginTop: 6 }}>Alert sent to you by email and push</div>
      </Card>
      {row('Bingo · Dog', 'DHPPi booster (2nd dose)', 'in 3 days', 'Mrs. A. Bello', true, 10)}
      {/* Two rows only — a third was cut off by the phone frame (2026-09-30). */}
      {row('Nala · Cat', 'Rabies vaccine', 'tomorrow', 'Mr. T. Okafor', true, 22)}
    </>
  );
}

function DayCloseScreen() {
  const line = (label, value, color = SUITE_INK) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 32, marginTop: 14 }}>
      <span style={{ color: SUITE_MUTED }}>{label}</span><span style={{ color, fontWeight: 800 }}>{value}</span>
    </div>
  );
  return (
    <>
      <Card delay={0} style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: SUITE_INK }}>Today</div>
        <div style={{ fontSize: 76, fontWeight: 900, color: SUITE_INK, marginTop: 6 }}>₦48,500</div>
        <div style={{ fontSize: 26, color: SUITE_MUTED }}>23 sales · ₦12,300 profit</div>
      </Card>
      <Card delay={14}>
        <div style={{ fontSize: 32, fontWeight: 800, color: SUITE_INK }}>Close Day</div>
        {line('Expected cash in drawer', '₦31,000')}
        {line('You counted', '₦28,500')}
        <div style={{ height: 2, background: '#e2e8f0', marginTop: 18 }} />
        {line('Difference', '−₦2,500', '#dc2626')}
      </Card>
      <Card delay={30} style={{ background: SUITE_ACCENT, textAlign: 'center' }}>
        <div style={{ fontSize: 32, fontWeight: 800, color: 'white' }}>✔ Day closed · recorded</div>
      </Card>
    </>
  );
}

function PlansScreen() {
  const plan = (name, price, detail, highlight, delay) => (
    <Card delay={delay} style={highlight ? { border: `4px solid ${SUITE_ACCENT}` } : {}}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 38, fontWeight: 900, color: SUITE_INK }}>{name}</div>
        <div style={{ fontSize: 34, fontWeight: 900, color: highlight ? SUITE_ACCENT : SUITE_INK }}>{price}</div>
      </div>
      <div style={{ fontSize: 26, color: SUITE_MUTED, marginTop: 8 }}>{detail}</div>
      {highlight ? <div style={{ fontSize: 26, fontWeight: 800, color: SUITE_ACCENT, marginTop: 10 }}>← Start here</div> : null}
    </Card>
  );
  return (
    <>
      <Card delay={0} style={{ background: '#eef2ff' }}>
        <div style={{ fontSize: 30, fontWeight: 800, color: SUITE_ACCENT }}>📋 Records · 📦 Stock · 💵 Day Close</div>
        <div style={{ fontSize: 24, color: SUITE_MUTED, marginTop: 6 }}>All on your phone</div>
      </Card>
      {plan('Free', '₦0', '5 patients · 15 products · 2 staff', true, 12)}
      {plan('Paid plans', 'from ₦5,000', 'More patients, products and staff as you grow', false, 26)}
    </>
  );
}

const SUITE_SCREENS = {
  reminders: { title: 'Practice Records', body: RemindersScreen },
  dayclose: { title: 'Day Close & Reports', body: DayCloseScreen },
  plans: { title: 'Business Suite', body: PlansScreen },
};

function SuiteScreen({ screen }) {
  const s = SUITE_SCREENS[screen] || SUITE_SCREENS.plans;
  const Body = s.body;
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, #1e3a8a, ${BRAND})`, fontFamily: 'Arial, sans-serif' }}>
      <div style={{
        position: 'absolute', top: 300, left: 150, width: 780, height: 800, borderRadius: 48, overflow: 'hidden',
        background: '#f1f5f9', border: '10px solid #0f172a', boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
      }}>
        <div style={{ background: 'white', padding: '22px 30px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #e2e8f0' }}>
          <span style={{ fontSize: 32, fontWeight: 800, color: SUITE_INK }}>← {s.title}</span>
          <span style={{ fontSize: 20, color: SUITE_MUTED, border: '2px solid #cbd5e1', borderRadius: 20, padding: '4px 12px' }}>Sample data</span>
        </div>
        <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Body />
        </div>
      </div>
    </AbsoluteFill>
  );
}

function Background({ seg }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  if (seg.mediaKind === 'suite') return <SuiteScreen screen={seg.media} />;
  if (seg.mediaKind === 'image') {
    // Slow push-in; a blurred copy fills the frame behind non-portrait photos.
    const scale = interpolate(frame, [0, durationInFrames], [1.0, 1.12]);
    const src = staticFile(seg.media);
    return (
      <AbsoluteFill style={{ backgroundColor: 'black' }}>
        <Img src={src} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(40px) brightness(0.55)', transform: 'scale(1.2)' }} />
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', transform: `scale(${scale})` }}>
          <Img src={src} style={{ width: '100%', objectFit: 'contain' }} />
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }
  const video = (
    <OffthreadVideo src={staticFile(seg.media)} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  );
  // Loop clips shorter than their narration instead of freezing on the last frame.
  const clipFrames = Math.floor((seg.mediaDuration || 999) * FPS);
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {clipFrames < durationInFrames ? <Loop durationInFrames={clipFrames}>{video}</Loop> : video}
    </AbsoluteFill>
  );
}

// Group words into short caption "pages": at most 4 words, and a page always
// ends after sentence punctuation so captions never straddle two sentences.
function toPages(words) {
  const pages = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= 4 || /[.?!,:;]$/.test(w.text)) {
      pages.push(cur);
      cur = [];
    }
  }
  if (cur.length) pages.push(cur);
  return pages;
}

function Captions({ words }) {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const pages = toPages(words);
  const page = pages.find((p, i) => t < (pages[i + 1] ? pages[i + 1][0].start : Infinity) && t >= p[0].start - 0.15);
  if (!page) return null;
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-start', alignItems: 'center', top: 1140 }}>
      <div style={{ width: 960, textAlign: 'center', lineHeight: 1.18 }}>
        {page.map((w, i) => {
          const active = t >= w.start && t < w.end + 0.05;
          const pop = active ? spring({ frame: frame - Math.round(w.start * FPS), fps: FPS, config: { damping: 12, stiffness: 200 }, durationInFrames: 8 }) : 0;
          return (
            <span key={i} style={{
              // Wide gap + small pop: at 0.1 scale the active word grew into its neighbours.
              display: 'inline-block', margin: '0 20px', fontFamily: FONT, fontWeight: 900, fontSize: 84,
              color: active ? HIGHLIGHT : 'white', transform: `scale(${1 + 0.05 * pop})`,
              WebkitTextStroke: '3px black', paintOrder: 'stroke fill',
              textShadow: '0 6px 18px rgba(0,0,0,0.85)',
            }}>{w.text.toUpperCase()}</span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

function Header({ title, totalFrames }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14, stiffness: 140 }, durationInFrames: 14 });
  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', top: 0, left: 0, height: 10, width: `${(frame / totalFrames) * 100}%`, background: HIGHLIGHT }} />
      <div style={{ position: 'absolute', top: 70, left: 0, right: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, background: 'rgba(255,255,255,0.94)', borderRadius: 60, padding: '12px 28px 12px 14px' }}>
          <Img src={staticFile('_brand/logo.png')} style={{ height: 58 }} />
          <span style={{ fontFamily: 'Arial', fontWeight: 700, fontSize: 36, color: '#0f172a' }}>@xpress_vet</span>
        </div>
        <div style={{
          transform: `scale(${pop})`, maxWidth: 940, background: BRAND, color: 'white', fontFamily: FONT, fontWeight: 900,
          fontSize: 54, lineHeight: 1.15, textAlign: 'center', padding: '18px 34px', borderRadius: 22,
          boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
        }}>{title}</div>
      </div>
    </AbsoluteFill>
  );
}

// cta = { headline, action } — topic-matched ask (emergency / farm / pet care),
// set per video in scripts/renderVetTipReels.mjs. Added 2026-09-30: the old card
// only said "Full guide: link in bio", and bio clicks were 4 in 28 days.
function EndCard({ cta }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 13, stiffness: 120 }, durationInFrames: 16 });
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${BRAND}, #1e3a8a)`, justifyContent: 'center', alignItems: 'center', gap: 38 }}>
      <div style={{ transform: `scale(${pop})`, background: 'white', borderRadius: 40, padding: 28 }}>
        <Img src={staticFile('_brand/logo.png')} style={{ height: 150 }} />
      </div>
      <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 84, color: 'white', textAlign: 'center', lineHeight: 1.1, width: 960 }}>
        {cta?.headline || 'Need a vet?'}
      </div>
      <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 60, color: HIGHLIGHT, textAlign: 'center', lineHeight: 1.15, width: 960 }}>
        {cta?.action || 'Find one near you'}<br />👆 link in bio
      </div>
      <div style={{ fontFamily: 'Arial', fontWeight: 700, fontSize: 40, color: 'white', marginTop: 10 }}>Follow @xpress_vet for free tips</div>
      <div style={{
        fontFamily: 'Arial', fontWeight: 700, fontSize: 36, color: '#0f172a', background: 'white',
        borderRadius: 40, padding: '14px 32px', textAlign: 'center',
      }}>
        🩺 Vets: get listed free on Xpress Vet
      </div>
    </AbsoluteFill>
  );
}

export function VetTipReel({ title, segments, music, cta }) {
  const { durationInFrames } = useVideoConfig();
  let cursor = 0;
  const seqs = segments.map((seg, i) => {
    const from = cursor;
    const len = segmentFrames(seg);
    cursor += len;
    return (
      <Sequence key={i} from={from} durationInFrames={len}>
        <Background seg={seg} />
        <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 50%, rgba(0,0,0,0.7) 100%)' }} />
        <Captions words={seg.words} />
        {/* No on-screen credits (Sam, 2026-09-29): Pexels needs none, and the CC BY/BY-SA
            Commons photos are credited in the post caption (renderVetTipReels.mjs). */}
        <Audio src={staticFile(seg.audio)} />
      </Sequence>
    );
  });
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {seqs}
      <Sequence from={0} durationInFrames={cursor}>
        <Header title={title} totalFrames={cursor} />
      </Sequence>
      <Sequence from={cursor}>
        <EndCard cta={cta} />
      </Sequence>
      {music ? <Audio src={staticFile(music)} volume={(f) => interpolate(f, [durationInFrames - 30, durationInFrames], [0.07, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })} loop /> : null}
    </AbsoluteFill>
  );
}
