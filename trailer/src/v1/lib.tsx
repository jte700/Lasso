import React from 'react';
import { AbsoluteFill, Easing, interpolate, random, useCurrentFrame } from 'remotion';
import { loadFont as loadSerif } from '@remotion/google-fonts/SourceSerif4';
import { loadFont as loadSans } from '@remotion/google-fonts/InterTight';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { loadFont as loadHand } from '@remotion/google-fonts/Caveat';
import { loadFont as loadType } from '@remotion/google-fonts/SpecialElite';

export const SERIF = loadSerif('normal', { weights: ['500', '600'], subsets: ['latin'] }).fontFamily;
export const SANS = loadSans('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] }).fontFamily;
export const MONO = loadMono('normal', { weights: ['400', '600'], subsets: ['latin'] }).fontFamily;
export const HAND = loadHand('normal', { weights: ['600'], subsets: ['latin'] }).fontFamily;
export const TYPE = loadType('normal', { weights: ['400'], subsets: ['latin'] }).fontFamily;

export const C = {
  sand: '#f5f3f1', sand2: '#ebe8e4', white: '#ffffff', ink: '#000000', ink2: 'rgba(0,0,0,.62)', ink3: 'rgba(0,0,0,.42)',
  line: '#e7e4e0', green: '#29cc57', greenD: '#1f9d55', greenBg: '#eafaf0', blue: '#3b6cf6', pink: '#e5487a', pinkBg: '#fdeef3', yellow: '#fff4cc',
};
export const SHADOW = '0 1px 2px rgba(0,0,0,.04), 0 30px 80px rgba(0,0,0,.12)';

export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);
export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
// 0→1 between two frames, eased
export const ramp = (f: number, a: number, b: number, easing = easeOut) => interpolate(f, [a, b], [0, 1], { ...clamp, easing });
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// when each character of a typed string lands, with a little human irregularity
export function schedule(text: string, start: number, step: number, seed: string) {
  const out: number[] = [];
  let t = start;
  for (let i = 0; i < text.length; i++) {
    out.push(Math.round(t));
    const pause = text[i] === ' ' ? 0.6 : 0;
    t += step * (0.7 + random(`${seed}-${i}`) * 0.6 + pause);
  }
  return out;
}
export const typedCount = (times: number[], f: number) => times.filter((t) => t <= f).length;

// camera keyframes: [frame, scale, cx, cy] — the stage point (cx, cy) sits at the centre of the frame.
// Apply the result to a stage with transform-origin 0 0.
export type Key = [number, number, number, number];
export function camera(f: number, keys: Key[], W = 1920, H = 1080) {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1][0] <= f) i++;
  const a = keys[i], b = keys[i + 1];
  const u = interpolate(f, [a[0], b[0]], [0, 1], { ...clamp, easing: easeInOut });
  const s = Math.exp(lerp(Math.log(a[1]), Math.log(b[1]), u));
  // move the centre in "zoom space" so a zoom-and-pan reads as one motion
  const v = Math.abs(b[1] - a[1]) < 1e-3 ? u : (s - a[1]) / (b[1] - a[1]);
  const cx = lerp(a[2], b[2], (u + v) / 2), cy = lerp(a[3], b[3], (u + v) / 2);
  return `translate(${W / 2 - s * cx}px, ${H / 2 - s * cy}px) scale(${s})`;
}

// A shot. It dissolves in over the previous one from a soft blur-zoom (or hard-cuts in), and on the way out
// pushes forward and softens while the next shot dissolves over it. `fade` also fades it to its background.
export const Shot: React.FC<{ dur: number; bg?: string; cut?: boolean; inF?: number; outF?: number; fade?: boolean; children: React.ReactNode }> = ({ dur, bg = C.sand, cut, inF = 16, outF = 14, fade, children }) => {
  const f = useCurrentFrame();
  const a = cut ? 1 : ramp(f, 0, inF, easeInOut);
  const b = ramp(f, dur - outF, dur, Easing.bezier(0.55, 0, 0.8, 0.2));
  const scale = lerp(1.05, 1, a) * lerp(1, 1.035, b);
  const blur = (1 - a) * 18 + b * 10;
  return (
    <AbsoluteFill style={{ background: bg, opacity: a }}>
      <AbsoluteFill style={{ opacity: fade ? 1 - b : 1, transform: `scale(${scale})`, filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};

// a line of words that each rise in from a blur
export const Words: React.FC<{ text: string; start: number; per?: number; dur?: number; style?: React.CSSProperties }> = ({ text, start, per = 4, dur = 20, style }) => {
  const f = useCurrentFrame();
  return (
    <span style={style}>
      {text.split(' ').map((w, i, all) => {
        const a = ramp(f, start + i * per, start + i * per + dur);
        return <span key={i} style={{ display: 'inline-block', whiteSpace: 'pre', opacity: a, transform: `translateY(${((1 - a) * 0.28).toFixed(3)}em)`, filter: a < 0.999 ? `blur(${((1 - a) * 10).toFixed(2)}px)` : undefined }}>{w}{i < all.length - 1 ? ' ' : ''}</span>;
      })}
    </span>
  );
};

export type Cue = { f: number; s: string; v?: number };

export const Kicker: React.FC<{ n: string; label: string; dark?: boolean }> = ({ n, label, dark }) => {
  const f = useCurrentFrame();
  const a = ramp(f, 6, 24);
  return (
    <div style={{ position: 'absolute', left: 96, bottom: 84, display: 'flex', alignItems: 'center', gap: 16, opacity: a, transform: `translateY(${(1 - a) * 12}px)`, fontFamily: SANS, fontSize: 26, fontWeight: 600, color: dark ? 'rgba(255,255,255,.75)' : C.ink2 }}>
      <span style={{ fontFamily: SERIF, fontSize: 30, color: C.greenD }}>{n}</span>
      <span style={{ width: 36, height: 2, background: dark ? 'rgba(255,255,255,.3)' : C.line }} />
      {label}
    </div>
  );
};

export const Caret: React.FC<{ h?: number; color?: string; on?: boolean }> = ({ h = 1, color = C.green, on = true }) => {
  const f = useCurrentFrame();
  const blink = on || Math.floor(f / 15) % 2 === 0;
  return <span style={{ display: 'inline-block', width: '0.07em', minWidth: 3, height: `${h}em`, marginLeft: '0.04em', verticalAlign: '-0.14em', background: color, opacity: blink ? 1 : 0 }} />;
};

export const Keycap: React.FC<{ label: string; pressed?: number; show?: number; size?: number }> = ({ label, pressed = 0, show = 1, size = 34 }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: size * 1.9, height: size * 1.7, padding: `0 ${size * 0.5}px`, borderRadius: size * 0.42,
    fontFamily: SANS, fontSize: size, fontWeight: 600, opacity: show, transform: `translateY(${pressed * 4}px) scale(${1 - pressed * 0.05})`,
    background: pressed > 0.5 ? C.green : C.white, color: pressed > 0.5 ? C.white : C.ink,
    boxShadow: pressed > 0.5 ? '0 1px 0 rgba(0,0,0,.08)' : `0 0 0 1.5px ${C.line}, 0 6px 0 ${C.line}, 0 14px 30px rgba(0,0,0,.08)`,
  }}>{label}</span>
);

export const Pointer: React.FC<{ x: number; y: number; press?: number; scale?: number }> = ({ x, y, press = 0, scale = 1.6 }) => (
  <svg viewBox="0 0 22 28" style={{ position: 'absolute', left: x, top: y, width: 22 * scale, height: 28 * scale, transform: `scale(${1 - press * 0.15})`, transformOrigin: '0 0', filter: 'drop-shadow(0 3px 6px rgba(0,0,0,.3))', zIndex: 50 }}>
    <path d="M2 2v21l5.6-5.3 4 8.6 3.6-1.6-4-8.4H19z" fill="#000" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

export const LassoMark: React.FC<{ size?: number; color?: string; draw?: number }> = ({ size = 40, color = C.green, draw = 1 }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} fill="none">
    <ellipse cx="15" cy="12" rx="11" ry="7.5" transform="rotate(-10 15 12)" stroke={color} strokeWidth="2.4" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - draw} />
    <path d="M19.5 18.6c1.6 3.2 4.6 4.6 7.6 9.4" stroke={color} strokeWidth="2.4" strokeLinecap="round" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - Math.max(0, draw * 1.4 - 0.4)} />
    <circle cx="19.3" cy="18.4" r="2.2" fill={color} opacity={draw > 0.9 ? 1 : 0} />
  </svg>
);

// a macOS-style window frame
export const Win: React.FC<{ title?: string; w: number; h: number; x?: number; y?: number; style?: React.CSSProperties; right?: React.ReactNode; children?: React.ReactNode }> = ({ title, w, h, x, y, style, right, children }) => (
  <div style={{ position: x === undefined ? 'relative' : 'absolute', left: x, top: y, width: w, height: h, borderRadius: 22, background: C.white, boxShadow: '0 0 0 1px rgba(0,0,0,.08), 0 40px 100px rgba(0,0,0,.18)', overflow: 'hidden', display: 'flex', flexDirection: 'column', ...style }}>
    <div style={{ position: 'relative', height: 64, flex: 'none', display: 'flex', alignItems: 'center', gap: 12, padding: '0 22px', background: '#fbfaf9', borderBottom: '1px solid #edebe8', fontFamily: SANS, fontSize: 22, fontWeight: 600, color: 'rgba(0,0,0,.55)' }}>
      <i style={{ width: 18, height: 18, borderRadius: 9, background: '#ff5f57' }} /><i style={{ width: 18, height: 18, borderRadius: 9, background: '#febc2e' }} /><i style={{ width: 18, height: 18, borderRadius: 9, background: '#28c840' }} />
      <span style={{ position: 'absolute', left: 0, right: 0, textAlign: 'center' }}>{title}</span>
      <span style={{ marginLeft: 'auto', position: 'relative' }}>{right}</span>
    </div>
    <div style={{ position: 'relative', flex: 1 }}>{children}</div>
  </div>
);

export const WALLPAPER = 'radial-gradient(70% 90% at 12% 0%, #fde3cc 0%, transparent 60%), radial-gradient(60% 80% at 100% 100%, #d8e4ff 0%, transparent 62%), radial-gradient(55% 60% at 85% 8%, #e3f5df 0%, transparent 60%), #f1ece6';
