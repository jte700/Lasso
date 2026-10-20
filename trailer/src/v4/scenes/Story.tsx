import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { loadFont as loadScript } from '@remotion/google-fonts/GreatVibes';
import { C, SANS, MONO, TYPE, BAR, Caret, Selected, sp, ramp, lerp, clamp, typing, count, EXIT, SHADOW } from '../kit';
import type { Cue } from '../../v2/cues';

const SCRIPT = loadScript('normal', { weights: ['400'], subsets: ['latin'] }).fontFamily;

/* ───────────── 0:00–0:17 · from "For 150 years" to "Finding didn't." ─────────────
   One continuous vertical scroll. Each line arrives at the centre and pushes the earlier ones up into a
   fading stack. The era names each perform their own era as they land, and the cuts get faster. */
export const STORY = BAR * 8.5; // 1020 frames
type Item = { at: number; h: number; render: (t: number) => React.ReactNode };
const T = { intro: 20, hand: 240, type: 390, word: 510, auto: 615, intel: 705, faster: 790, finding: 862 };

const Handwriting = (t: number) => {
  const p = ramp(t, 4, 80);
  return <span style={{ fontFamily: SCRIPT, fontSize: 190, color: '#1b2a52', display: 'inline-block', clipPath: `inset(-30% ${((1 - p) * 100).toFixed(2)}% -30% -8%)`, padding: '0 20px', lineHeight: 1 }}>Handwriting</span>;
};
const tw = typing('Typewriter', 4, 3.2, 'tw');
const Typewriter = (t: number) => (
  <span style={{ fontFamily: TYPE, fontSize: 132, color: '#22201c', whiteSpace: 'pre' }}>
    {'Typewriter'.split('').map((ch, i) => { const a = tw[i]; if (t < a) return <span key={i} style={{ opacity: 0 }}>{ch}</span>; const k = Math.max(0, 1 - (t - a) / 6); return <span key={i} style={{ display: 'inline-block', transform: `scale(${(1 + k * 0.35).toFixed(3)})`, opacity: 0.85 + (i % 3) * 0.05 }}>{ch}</span>; })}
  </span>
);
const wp = typing('Word processor', 2, 1.3, 'wp');
const WordProcessor = (t: number) => {
  const n = count(wp, t);
  return (
    <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 124, letterSpacing: '-0.035em', color: C.ink, whiteSpace: 'pre' }}>
      {n < 14 ? <>{"Word processor".slice(0, n)}<Caret /></> : <>Word <Selected at={T.word + 38} dur={18}>processor</Selected></>}
    </span>
  );
};
const ac = typing('Autoco', 2, 2.4, 'ac');
const Autocomplete = (t: number) => {
  const n = count(ac, t), ok = t >= 44, flash = 1 - ramp(t, 44, 24);
  return (
    <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 124, letterSpacing: '-0.035em', color: C.ink, whiteSpace: 'pre' }}>
      {'Autoco'.slice(0, n)}
      {ok ? <span style={{ background: `rgba(41,204,87,${(0.25 * flash).toFixed(3)})`, borderRadius: 10 }}>mplete</span> : <><Caret /><span style={{ color: 'rgba(17,21,17,.24)', opacity: ramp(t, 18, 8) }}>mplete</span></>}
    </span>
  );
};
const it = typing('Intelli', 2, 2, 'it');
const IntelliSense = (t: number) => {
  const n = count(it, t), pop = sp(t, 18, 18, 180) * (1 - ramp(t, 40, 8, EXIT)), done = t >= 40;
  return (
    <span style={{ position: 'relative', fontFamily: MONO, fontWeight: 500, fontSize: 112, letterSpacing: '-0.03em', color: C.ink, whiteSpace: 'pre' }}>
      {done ? <span style={{ color: '#3b6cf6' }}>IntelliSense</span> : <>{'Intelli'.slice(0, n)}<Caret /></>}
      {pop > 0.01 && (
        <span style={{ position: 'absolute', left: 0, top: 150, transformOrigin: '0 0', transform: `scale(${lerp(0.9, 1, pop).toFixed(3)})`, opacity: Math.min(1, pop * 1.4), background: C.white, borderRadius: 18, boxShadow: SHADOW, padding: 8, fontSize: 34, letterSpacing: 0, display: 'flex', flexDirection: 'column', gap: 2, width: 420 }}>
          {['IntelliSense', 'Intellisearch', 'Intelligence'].map((s, i) => <span key={s} style={{ padding: '8px 14px', borderRadius: 10, background: i === 0 ? 'rgba(41,204,87,.16)' : undefined }}><span style={{ color: '#3b6cf6' }}>ƒ</span> {s}</span>)}
        </span>
      )}
    </span>
  );
};
const Faster = () => <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 128, letterSpacing: '-0.04em', color: C.ink }}>Typing got faster.</span>;
const Finding = (t: number) => (
  <span style={{ fontFamily: SANS, fontWeight: 700, fontSize: 128, letterSpacing: '-0.04em', color: C.ink, whiteSpace: 'pre' }}>Finding <Selected at={T.finding + 34} dur={16}>didn’t.</Selected></span>
);

const ITEMS: Item[] = [
  { at: T.intro, h: 300, render: () => null },
  { at: T.hand, h: 230, render: Handwriting },
  { at: T.type, h: 190, render: Typewriter },
  { at: T.word, h: 190, render: WordProcessor },
  { at: T.auto, h: 190, render: Autocomplete },
  { at: T.intel, h: 190, render: IntelliSense },
  { at: T.faster, h: 170, render: () => <Faster /> },
  { at: T.finding, h: 170, render: Finding },
];

export const Story: React.FC = () => {
  const f = useCurrentFrame();
  // how far the stack has scrolled: each arrival pushes everything up by the newcomer's height (on a spring)
  let scroll = 0;
  ITEMS.forEach((it, i) => { if (i > 0) scroll += sp(f, it.at - 6, 22, 130) * (ITEMS[i - 1].h / 2 + it.h / 2); });
  // the history stack flies away when "Typing got faster." arrives, so the last two lines stand alone
  const clearOut = sp(f, T.faster - 8, 24, 110);
  const exit = ramp(f, STORY - 34, 34, EXIT);
  let y = 0;
  return (
    <AbsoluteFill style={{ background: `rgba(246,246,244,${(1 - exit).toFixed(3)})`, overflow: 'hidden' }}>
      <AbsoluteFill style={{ transform: `scale(${(interpolate(f, [0, STORY], [1, 1.05], clamp) * (1 + exit * 0.6)).toFixed(4)})`, opacity: 1 - exit, filter: exit > 0.01 ? `blur(${(exit * 24).toFixed(1)}px)` : undefined }}>
        {ITEMS.map((it, i) => {
          if (i > 0) y += ITEMS[i - 1].h / 2 + it.h / 2;
          const cy = 540 + y - scroll;
          const arrive = sp(f, it.at - 6, 22, 130);
          if (arrive < 0.002) return null;
          const dist = Math.max(0, (scroll - y) / 200); // 0 at centre, ~1 per slot above
          const history = i >= 1 && i <= 5;
          const gone = history ? clearOut : i === 0 ? sp(f, T.hand - 20, 22, 120) : 0;
          const shrink = i === 0 ? 1 : lerp(1, 0.42, Math.min(1, dist));
          const o = Math.min(1, arrive * 1.6) * Math.max(0, 1 - Math.max(0, dist - 0.6) * 0.42) * (1 - gone);
          if (o < 0.005) return null;
          const t = f - it.at;
          return (
            <div key={i} style={{ position: 'absolute', left: 0, right: 0, top: cy - gone * 300, height: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', opacity: o,
              transform: `translateY(${((1 - arrive) * 90).toFixed(1)}px) scale(${shrink.toFixed(4)})`, filter: dist > 0.3 || arrive < 0.98 || gone > 0.01 ? `blur(${(Math.max(0, dist - 0.3) * 3 + (1 - arrive) * 14 + gone * 12).toFixed(1)}px) grayscale(${Math.min(1, dist).toFixed(2)})` : undefined }}>
              {i === 0 ? <Intro f={f} /> : it.render(t)}
            </div>
          );
        })}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const Intro: React.FC<{ f: number }> = ({ f }) => {
  const w = (s: string, at: number, size: number, color: string, weight = 700) => {
    const k = sp(f, at, 20, 160);
    return <span style={{ display: 'inline-block', whiteSpace: 'pre', fontSize: size, fontWeight: weight, color, opacity: Math.min(1, k * 1.4), transform: `translateY(${((1 - k) * 0.3).toFixed(3)}em)`, filter: k < 0.98 ? `blur(${((1 - k) * 10).toFixed(1)}px)` : undefined }}>{s}</span>;
  };
  return (
    <div style={{ textAlign: 'center', fontFamily: SANS, letterSpacing: '-0.035em', lineHeight: 1.12 }}>
      <div>{w('For ', 24, 118, C.ink)}{w('150 ', 32, 118, C.greenD)}{w('years,', 40, 118, C.ink)}</div>
      <div style={{ marginTop: 14 }}>{w('we made ', 96, 58, C.ink2, 500)}{w('writing ', 104, 58, C.ink2, 500)}{w('faster.', 112, 58, C.ink2, 500)}</div>
    </div>
  );
};

export const storyCues: Cue[] = [
  ...tw.map((t) => ({ f: T.type + t, s: 'clack', v: 0.32 })),
  ...wp.filter((_, i) => i % 2 === 0).map((t) => ({ f: T.word + t, s: 'key', v: 0.22 })),
  ...ac.map((t) => ({ f: T.auto + t, s: 'key', v: 0.22 })), { f: T.auto + 44, s: 'tab', v: 0.32 },
  ...it.map((t) => ({ f: T.intel + t, s: 'key', v: 0.22 })), { f: T.intel + 40, s: 'tab', v: 0.32 },
];
