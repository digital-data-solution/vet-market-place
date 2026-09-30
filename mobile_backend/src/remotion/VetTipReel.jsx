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
export const END_CARD_SECONDS = 2.8;
const BRAND = '#2563EB';
const HIGHLIGHT = '#FACC15';
const FONT = 'Arial Black, Arial, sans-serif';

export const segmentFrames = (seg) => Math.ceil((seg.duration + SEGMENT_PAD_SECONDS) * FPS);

export function calculateMetadata({ props }) {
  const total = props.segments.reduce((n, s) => n + segmentFrames(s), 0) + Math.round(END_CARD_SECONDS * FPS);
  return { durationInFrames: total, fps: FPS, width: 1080, height: 1920 };
}

function Background({ seg }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
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

function EndCard() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 13, stiffness: 120 }, durationInFrames: 16 });
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, ${BRAND}, #1e3a8a)`, justifyContent: 'center', alignItems: 'center', gap: 44 }}>
      <div style={{ transform: `scale(${pop})`, background: 'white', borderRadius: 48, padding: 36 }}>
        <Img src={staticFile('_brand/logo.png')} style={{ height: 190 }} />
      </div>
      <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 76, color: 'white', textAlign: 'center', lineHeight: 1.15 }}>
        Full guide:<br />link in bio 👆
      </div>
      <div style={{ fontFamily: 'Arial', fontWeight: 700, fontSize: 46, color: HIGHLIGHT }}>Follow @xpress_vet</div>
      <div style={{ fontFamily: 'Arial', fontSize: 36, color: 'white', opacity: 0.9, textAlign: 'center', width: 860 }}>
        Free vet tips for Nigerian pet owners &amp; farmers
      </div>
    </AbsoluteFill>
  );
}

export function VetTipReel({ title, segments, music }) {
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
        <EndCard />
      </Sequence>
      {music ? <Audio src={staticFile(music)} volume={(f) => interpolate(f, [durationInFrames - 30, durationInFrames], [0.07, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })} loop /> : null}
    </AbsoluteFill>
  );
}
