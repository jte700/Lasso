// Shared building blocks for the v2 trailer: one motion vocabulary used everywhere.
// Motion identity (after the LottieFiles motion-design skill, "Premium" personality):
//   signature curve EASE (0.4,0,0.2,1) for on-screen moves, ENTER (0.05,0.7,0.1,1) to arrive, EXIT (0.3,0,1,1) to leave;
//   three durations Q/S/L; no overshoot on UI (characters are the playful exception); staggers stay under ~0.5 s.
import React from 'react';
import { Easing, interpolate, interpolateColors, random, useCurrentFrame } from 'remotion';
import { loadFont as loadSerif } from '@remotion/google-fonts/SourceSerif4';
import { loadFont as loadSans } from '@remotion/google-fonts/InterTight';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { loadFont as loadScript } from '@remotion/google-fonts/GreatVibes';
import { loadFont as loadType } from '@remotion/google-fonts/SpecialElite';

export const SERIF = loadSerif('normal', { weights: ['500', '600'], subsets: ['latin'] }).fontFamily;
export const SANS = loadSans('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] }).fontFamily;
export const MONO = loadMono('normal', { weights: ['400', '500'], subsets: ['latin'] }).fontFamily;
export const SCRIPT = loadScript('normal', { weights: ['400'], subsets: ['latin'] }).fontFamily;
export const TYPE = loadType('normal', { weights: ['400'], subsets: ['latin'] }).fontFamily;

/* ── the beat grid: 60 fps, 90 BPM ── */
export const FPS = 60, BEAT = 40, BAR = 160;
export const bt = (bar: number, beat = 0) => Math.round(bar * BAR + beat * BEAT);

/* ── palette (Lasso) ── */
export const C = {
  bg: '#f7f6f4', paper: '#ffffff', sand: '#efece8', line: '#e6e2dd',
  ink: '#14201a', ink2: 'rgba(20,32,26,.62)', ink3: 'rgba(20,32,26,.38)',
  green: '#29cc57', greenD: '#1f9d55', deep: '#11613a', greenBg: '#e6f7ec',
  pink: '#ec86a8', blue: '#6688ee', yellow: '#f6c445', red: '#e5484d',
};
export const SHADOW = '0 1px 1px rgba(20,32,26,.04), 0 10px 24px rgba(20,32,26,.06), 0 40px 80px rgba(20,32,26,.08)';
export const SHADOW_SM = '0 1px 1px rgba(20,32,26,.05), 0 6px 16px rgba(20,32,26,.07)';

/* ── motion ── */
export const EASE = Easing.bezier(0.4, 0, 0.2, 1);
export const ENTER = Easing.bezier(0.05, 0.7, 0.1, 1);
export const EXIT = Easing.bezier(0.3, 0, 1, 1);
export const Q = 12, S = 24, L = 42;
const CL = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const clamp = CL;
/** 0→1 from frame `a` over `d` frames */
export const ramp = (f: number, a: number, d: number, e = EASE) => interpolate(f, [a, a + Math.max(1, d)], [0, 1], { ...CL, easing: e });
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** in at `a` (ENTER), out at `z` (EXIT): returns visibility 0..1 */
export const life = (f: number, a: number, z: number, din = S, dout = Q + 4) => ramp(f, a, din, ENTER) * (1 - ramp(f, z - dout, dout, EXIT));

/** keyframed camera: [frame, scale, cx, cy] — stage point (cx, cy) is centred. Stage uses transform-origin 0 0. */
export type Key = [number, number, number, number];
export function camera(f: number, keys: Key[], W = 1920, H = 1080) {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1][0] <= f) i++;
  const a = keys[i], b = keys[i + 1];
  const u = interpolate(f, [a[0], b[0]], [0, 1], { ...CL, easing: EASE });
  const s = Math.exp(lerp(Math.log(a[1]), Math.log(b[1]), u));
  return `translate(${(W / 2 - s * lerp(a[2], b[2], u)).toFixed(2)}px, ${(H / 2 - s * lerp(a[3], b[3], u)).toFixed(2)}px) scale(${s.toFixed(4)})`;
}

/** typing schedule with human irregularity: frame at which each char lands */
export function typing(text: string, start: number, step: number, seed: string) {
  const out: number[] = []; let t = start;
  for (let i = 0; i < text.length; i++) { out.push(Math.round(t)); t += step * (0.65 + random(`${seed}${i}`) * 0.7 + (text[i] === ' ' ? 0.5 : 0)); }
  return out;
}
export const count = (times: number[], f: number) => { let n = 0; for (const t of times) if (t <= f) n++; return n; };

/* ── Caption: words arrive from a soft blur and travel pink → blue → their final colour ──
   Mark emphasised words with *asterisks*; they settle in Lasso green. */
export const Caption: React.FC<{ text: string; start: number; step?: number; size?: number; out?: number; color?: string; weight?: number; style?: React.CSSProperties; font?: string; mark?: React.ReactNode }> = ({ text, start, step = 9, size = 64, out, color = C.ink, weight = 600, style, font = SERIF, mark }) => {
  const f = useCurrentFrame();
  const words = text.split(' ');
  // *a few words* marks a green run
  let inEm = false;
  const emph = words.map((w) => { const open = w.startsWith('*'); if (open) inEm = true; const on = inEm; if (w.endsWith('*')) inEm = false; return on; });
  const gone = out === undefined ? 0 : ramp(f, out, S, EXIT);
  return (
    <div style={{ fontFamily: font, fontWeight: weight, fontSize: size, letterSpacing: font === SERIF ? '-0.02em' : '-0.01em', lineHeight: 1.18, textAlign: 'center', color, opacity: 1 - gone, filter: gone > 0.01 ? `blur(${(gone * 10).toFixed(2)}px)` : undefined, transform: `translateY(${(-gone * 12).toFixed(2)}px)`, ...style }}>
      {words.map((raw, i) => {
        if (raw === '/') return <br key={i} />;
        const em = emph[i], w = raw.replace(/\*/g, '');
        const a = start + words.slice(0, i).filter((x) => x !== '/').length * step;
        const age = f - a, k = ramp(f, a, S + 6, ENTER);
        const col = interpolateColors(Math.max(0, age), [0, 18, 48], [C.pink, C.blue, em ? C.greenD : color]);
        return (
          <span key={i} style={{ position: em && mark ? 'relative' : undefined, display: 'inline-block', whiteSpace: 'pre', color: col, opacity: k, transform: `translateY(${((1 - k) * 0.22).toFixed(3)}em)`, filter: k < 0.995 ? `blur(${((1 - k) * 9).toFixed(2)}px)` : undefined }}>
            {w}{em && mark}{i < words.length - 1 && words[i + 1] !== '/' ? ' ' : ''}
          </span>
        );
      })}
    </div>
  );
};

/* ── Liquid: the HomePod-style smear. amt 0..1 drives displacement, stretch and a pink/green fringe. ── */
let liqId = 0;
export const Liquid: React.FC<{ amt: number; seed?: number; dir?: 1 | -1; children: React.ReactNode; style?: React.CSSProperties }> = ({ amt, seed = 3, dir = 1, children, style }) => {
  const f = useCurrentFrame();
  const id = React.useMemo(() => `liq${liqId++}`, []);
  const a = Math.max(0, Math.min(1, amt));
  if (a < 0.002) return <div style={style}>{children}</div>;
  const disp = a * 380, fringe = a * 22 * dir;
  return (
    <div style={{ ...style, transform: `${style?.transform ?? ''} scaleX(${(1 + a * 0.5).toFixed(3)}) skewX(${(-a * 14 * dir).toFixed(2)}deg)`, filter: `url(#${id})` }}>
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <filter id={id} x="-40%" y="-80%" width="180%" height="260%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.0011 0.032" numOctaves={2} seed={seed} result="n0" />
          <feOffset in="n0" dx={(f * 9 * dir) % 4000} dy="0" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={disp} xChannelSelector="R" yChannelSelector="G" result="d0" />
          <feGaussianBlur in="d0" stdDeviation={`${(a * 10).toFixed(2)} 0`} result="d" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={disp * 1.3} xChannelSelector="R" yChannelSelector="G" result="d2" />
          <feOffset in="d2" dx={fringe} result="d2o" />
          <feColorMatrix in="d2o" type="matrix" values={`0 0 0 0 0.93  0 0 0 0 0.52  0 0 0 0 0.66  0 0 0 ${(0.75 * a + 0.1).toFixed(3)} 0`} result="pink" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={disp * 0.75} xChannelSelector="R" yChannelSelector="G" result="d3" />
          <feOffset in="d3" dx={-fringe} result="d3o" />
          <feColorMatrix in="d3o" type="matrix" values={`0 0 0 0 0.16  0 0 0 0 0.8  0 0 0 0 0.45  0 0 0 ${(0.7 * a + 0.1).toFixed(3)} 0`} result="green" />
          <feMerge><feMergeNode in="pink" /><feMergeNode in="green" /><feMergeNode in="d" /></feMerge>
        </filter>
      </svg>
      {children}
    </div>
  );
};
/** smear envelope around a switch frame: rises over `pre`, peaks at `at`, resolves over `post` */
export const smear = (f: number, at: number, pre = 8, post = 16) => (f < at ? ramp(f, at - pre, pre, Easing.in(Easing.cubic)) : 1 - ramp(f, at, post, Easing.out(Easing.cubic)));

/* ── small objects ── */
export const Caret: React.FC<{ color?: string; blink?: boolean; h?: number }> = ({ color = C.ink, blink = false, h = 1.05 }) => {
  const f = useCurrentFrame();
  const on = !blink || Math.floor(f / 30) % 2 === 0;
  return <span style={{ display: 'inline-block', width: '0.06em', minWidth: 3, height: `${h}em`, marginLeft: '0.03em', verticalAlign: '-0.16em', background: color, opacity: on ? 1 : 0, borderRadius: 2 }} />;
};

export const Key: React.FC<{ label: string; down?: number; size?: number; wide?: number; tint?: boolean }> = ({ label, down = 0, size = 92, wide = 1, tint }) => {
  const d = Math.max(0, Math.min(1, down));
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: size * wide, height: size, marginBottom: 8 }}>
      <span style={{ position: 'absolute', inset: 0, top: 6, borderRadius: size * 0.2, background: '#d9d5cf' }} />
      <span style={{
        position: 'absolute', inset: 0, borderRadius: size * 0.2, transform: `translateY(${(d * 5).toFixed(2)}px)`,
        background: tint && d > 0.3 ? `linear-gradient(${C.green}, ${C.greenD})` : 'linear-gradient(#ffffff, #f3f1ee)',
        boxShadow: `0 0 0 1px rgba(20,32,26,.07), 0 ${(1 + (1 - d) * 3).toFixed(1)}px ${(2 + (1 - d) * 6).toFixed(1)}px rgba(20,32,26,.12)`,
        display: 'grid', placeItems: 'center', fontFamily: SANS, fontWeight: 500, fontSize: size * (label.length > 1 ? 0.3 : 0.42), color: tint && d > 0.3 ? '#fff' : C.ink,
      }}>{label}</span>
    </span>
  );
};

export const LassoMark: React.FC<{ size?: number; color?: string; draw?: number; stroke?: number }> = ({ size = 40, color = C.green, draw = 1, stroke = 2.4 }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} fill="none" style={{ overflow: 'visible' }}>
    <ellipse cx="15" cy="12" rx="11" ry="7.5" transform="rotate(-10 15 12)" stroke={color} strokeWidth={stroke} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - Math.min(1, draw * 1.25)} />
    <path d="M19.5 18.6c1.6 3.2 4.6 4.6 7.6 9.4" stroke={color} strokeWidth={stroke} strokeLinecap="round" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - Math.max(0, draw * 1.6 - 0.6)} />
    <circle cx="19.3" cy="18.4" r={stroke * 0.95} fill={color} opacity={draw > 0.95 ? 1 : 0} />
  </svg>
);

const FT: Record<string, { bg: string; fg: string; tag: string }> = {
  xlsx: { bg: '#e3f4e8', fg: '#1f9d55', tag: 'XLS' }, pdf: { bg: '#fde6e6', fg: '#d6403f', tag: 'PDF' }, docx: { bg: '#e6edfd', fg: '#3b6cf6', tag: 'DOC' },
  dwg: { bg: '#fdeedd', fg: '#e8590c', tag: 'DWG' }, key: { bg: '#efe9fb', fg: '#7c5cd6', tag: 'KEY' }, mail: { bg: '#e6f0fd', fg: '#2f7bf0', tag: '✉' },
};
/** a file, drawn as a small object */
export const FileTile: React.FC<{ type: keyof typeof FT; name?: string; size?: number; style?: React.CSSProperties; mark?: 'x' | 'check' }> = ({ type, name, size = 120, style, mark }) => {
  const t = FT[type];
  return (
    <div style={{ position: 'absolute', width: size, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: size * 0.1, ...style }}>
      <div style={{ position: 'relative', width: size * 0.78, height: size, borderRadius: size * 0.12, background: '#fff', boxShadow: SHADOW_SM, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', right: 0, top: 0, width: size * 0.24, height: size * 0.24, background: t.bg, borderBottomLeftRadius: size * 0.08 }} />
        <div style={{ position: 'absolute', left: size * 0.1, right: size * 0.1, bottom: size * 0.12, height: size * 0.3, borderRadius: size * 0.06, background: t.bg, color: t.fg, display: 'grid', placeItems: 'center', fontFamily: SANS, fontWeight: 700, fontSize: size * 0.15, letterSpacing: '0.04em' }}>{t.tag}</div>
        {[0.22, 0.34, 0.46].map((y, i) => <div key={i} style={{ position: 'absolute', left: size * 0.12, width: size * (0.5 - i * 0.08), top: size * y, height: size * 0.045, borderRadius: 3, background: '#ece9e5' }} />)}
        {mark && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: mark === 'x' ? 'rgba(229,72,77,.1)' : 'rgba(41,204,87,.1)', color: mark === 'x' ? C.red : C.greenD, fontSize: size * 0.4, fontFamily: SANS, fontWeight: 600 }}>{mark === 'x' ? '×' : '✓'}</div>}
      </div>
      {name && <div style={{ fontFamily: SANS, fontWeight: 500, fontSize: Math.max(13, size * 0.13), color: C.ink2, whiteSpace: 'nowrap' }}>{name}</div>}
    </div>
  );
};

/** the Lasso suggestion card that grows out of the caret */
export const Suggestion: React.FC<{ value: string; source: string; show: number; tab?: boolean; size?: number; children?: React.ReactNode }> = ({ value, source, show, tab, size = 1, children }) => {
  const s = Math.max(0, Math.min(1, show));
  return (
    <div style={{
      transformOrigin: '0 0', transform: `translateY(${((1 - s) * -10).toFixed(2)}px) scale(${lerp(0.92, 1, s).toFixed(3)})`, opacity: s,
      background: C.paper, borderRadius: 22 * size, boxShadow: SHADOW, padding: `${18 * size}px ${22 * size}px ${16 * size}px`, whiteSpace: 'nowrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 * size }}>
        <LassoMark size={30 * size} draw={ramp(s * 40, 6, 30)} />
        <span style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 42 * size, letterSpacing: '-0.015em', color: C.ink }}>{value}</span>
        <span style={{ marginLeft: 28 * size, fontFamily: SANS, fontWeight: 600, fontSize: 17 * size, padding: `${5 * size}px ${11 * size}px`, borderRadius: 8 * size, background: tab ? C.green : C.sand, color: tab ? '#fff' : C.ink2 }}>Tab</span>
      </div>
      <div style={{ fontFamily: MONO, fontSize: 19 * size, color: C.ink3, marginTop: 8 * size }}>{source}</div>
      {children}
    </div>
  );
};

/** very slow pastel drift behind everything (the ambient layer) */
export const Ambient: React.FC<{ strength?: number }> = ({ strength = 1 }) => {
  const f = useCurrentFrame();
  const t = f / 60;
  const blob = (x: number, y: number, r: number, c: string) => `radial-gradient(${r}px ${r}px at ${x}% ${y}%, ${c}, transparent 70%)`;
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: 0.55 * strength, background: [
      blob(18 + Math.sin(t * 0.11) * 6, 22 + Math.cos(t * 0.09) * 5, 900, 'rgba(253,227,212,.55)'),
      blob(84 + Math.cos(t * 0.08) * 5, 78 + Math.sin(t * 0.1) * 6, 1000, 'rgba(219,229,253,.5)'),
      blob(70 + Math.sin(t * 0.07) * 8, 12 + Math.cos(t * 0.12) * 4, 760, 'rgba(226,245,229,.5)'),
    ].join(', ') }} />
  );
};
