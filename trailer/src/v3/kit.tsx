// v3 building blocks: SF-style type (Inter), the Shotbase-like vocabulary (keycaps, focus pulls, word reveals,
// text selection, a liquid wallpaper, a big cursor) in Lasso's colours.
import React from 'react';
import { interpolateColors, spring, useCurrentFrame } from 'remotion';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';
import { loadFont as loadType } from '@remotion/google-fonts/SpecialElite';
export { BAR, BEAT, bt, ramp, lerp, life, EASE, ENTER, EXIT, Q, S, L, camera, typing, count, clamp, FileTile } from '../v2/kit';
export type { Key as CamKey } from '../v2/kit';
import { ramp, lerp, ENTER, EXIT, EASE, S } from '../v2/kit';

export const SANS = loadInter('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] }).fontFamily;
export const MONO = loadMono('normal', { weights: ['400', '500'], subsets: ['latin'] }).fontFamily;
export const TYPE = loadType('normal', { weights: ['400'], subsets: ['latin'] }).fontFamily;

export const C = {
  paper: '#fbfaf8', white: '#ffffff', bg: '#f6f6f4', ink: '#111511', ink2: 'rgba(17,21,17,.6)', ink3: 'rgba(17,21,17,.38)', line: '#e7e5e1', pen: '#1c2230',
  green: '#29cc57', greenD: '#1f9d55', deep: '#0b3b25', greenBg: '#e6f7ec', sel: '#29cc57', red: '#e5484d', sand: '#f1eee9',
};
export const SHADOW = '0 1px 1px rgba(10,20,14,.05), 0 12px 28px rgba(10,20,14,.08), 0 40px 90px rgba(10,20,14,.12)';
export const SHADOW_SM = '0 1px 1px rgba(10,20,14,.06), 0 8px 18px rgba(10,20,14,.08)';

/** words arrive from a soft blur; the newest word glows in the accent, then settles. Mark a green run with *…*. */
export const Words: React.FC<{ text: string; start: number; step?: number; size?: number; color?: string; accent?: string; weight?: number; out?: number; align?: 'center' | 'left'; style?: React.CSSProperties; mark?: React.ReactNode; lh?: number }> = ({ text, start, step = 7, size = 64, color = C.ink, accent = C.green, weight = 600, out, align = 'center', style, mark, lh = 1.12 }) => {
  const f = useCurrentFrame();
  const words = text.split(' ');
  let inEm = false;
  const em = words.map((w) => { if (w.startsWith('*')) inEm = true; const on = inEm; if (w.endsWith('*')) inEm = false; return on; });
  const gone = out === undefined ? 0 : ramp(f, out, S, EXIT);
  let k = -1;
  return (
    <div style={{ fontFamily: SANS, fontWeight: weight, fontSize: size, letterSpacing: size > 40 ? '-0.025em' : '-0.01em', lineHeight: lh, textAlign: align, color, opacity: 1 - gone, filter: gone > 0.01 ? `blur(${(gone * 14).toFixed(2)}px)` : undefined, transform: `scale(${(1 - gone * 0.04).toFixed(3)})`, ...style }}>
      {words.map((raw, i) => {
        if (raw === '/') return <br key={i} />;
        k++;
        const w = raw.replace(/\*/g, ''), a = start + k * step, age = f - a, v = ramp(f, a, S, ENTER);
        const col = interpolateColors(Math.max(0, age), [0, 16, 34], [accent, accent, em[i] ? C.greenD : color]);
        return (
          <span key={i} style={{ position: em[i] && mark ? 'relative' : undefined, display: 'inline-block', whiteSpace: 'pre', color: col, opacity: v, transform: `translateY(${((1 - v) * 0.25).toFixed(3)}em)`, filter: v < 0.995 ? `blur(${((1 - v) * 12).toFixed(2)}px)` : undefined }}>
            {w}{em[i] && mark}{i < words.length - 1 && words[i + 1] !== '/' ? ' ' : ''}
          </span>
        );
      })}
    </div>
  );
};

/** a drag-selection: the highlight sweeps across the text and the text turns white */
export const Selected: React.FC<{ children: React.ReactNode; at: number; dur?: number; color?: string }> = ({ children, at, dur = 14, color = C.sel }) => {
  const f = useCurrentFrame();
  const p = ramp(f, at, dur);
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <span style={{ position: 'absolute', left: '-0.06em', top: '0.04em', bottom: '-0.02em', width: `calc(${(p * 100).toFixed(1)}% + ${(p * 0.12).toFixed(3)}em)`, background: color, borderRadius: '0.06em' }} />
      <span style={{ position: 'relative', color: p > 0.5 ? '#fff' : undefined }}>{children}</span>
      {p > 0 && p < 1 && <span style={{ position: 'absolute', left: `${(p * 100).toFixed(1)}%`, top: '0.02em', width: '0.05em', height: '1.04em', background: C.ink }} />}
    </span>
  );
};

/** a macOS-like liquid wallpaper in Lasso greens: big soft ribbons that drift */
export const Wallpaper: React.FC<{ blur?: number; o?: number }> = ({ blur = 0, o = 1 }) => {
  const f = useCurrentFrame(), t = f / 60;
  const ribbon = (x: number, y: number, w: number, h: number, rot: number, c: string) => (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: '50%', background: c, transform: `rotate(${rot}deg)`, filter: 'blur(70px)' }} />
  );
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', opacity: o, background: 'linear-gradient(160deg, #0d2f22 0%, #0f4a33 38%, #1d6b54 62%, #e7dcc6 100%)', filter: blur ? `blur(${blur}px)` : undefined }}>
      {ribbon(-300 + Math.sin(t * 0.21) * 80, 380 + Math.cos(t * 0.17) * 60, 2600, 420, -14 + Math.sin(t * 0.1) * 3, 'rgba(41,204,87,.55)')}
      {ribbon(-200 + Math.cos(t * 0.15) * 90, 120 + Math.sin(t * 0.2) * 50, 2400, 300, -22 + Math.cos(t * 0.12) * 4, 'rgba(146,224,197,.45)')}
      {ribbon(600 + Math.sin(t * 0.13) * 120, 700 + Math.cos(t * 0.19) * 60, 1800, 380, -8, 'rgba(245,226,190,.65)')}
      {ribbon(-400, -260 + Math.sin(t * 0.18) * 40, 1600, 500, 12, 'rgba(6,26,18,.6)')}
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(120% 90% at 50% 40%, transparent 55%, rgba(0,0,0,.28) 100%)' }} />
    </div>
  );
};

/** focus pull: blurred and slightly large while arriving, blurred and drifting while leaving */
export const Focus: React.FC<{ at: number; out?: number; din?: number; dout?: number; children: React.ReactNode; style?: React.CSSProperties; drift?: number; rise?: number }> = ({ at, out, dout = 18, children, style, drift = 0, rise = 40 }) => {
  const f = useCurrentFrame();
  const a = sp(f, at, 20, 110), b = out === undefined ? 0 : ramp(f, out - dout, dout, EXIT);
  if (a <= 0.001 || b >= 0.999) return null;
  const blur = Math.max(0, 1 - a * 1.15) * 20 + b * 18;
  return (
    <div style={{ ...style, opacity: Math.min(1, a * 1.5) * (1 - b), filter: blur > 0.1 ? `blur(${blur.toFixed(2)}px)` : undefined, transform: `${style?.transform ?? ''} translate(${(b * drift).toFixed(1)}px, ${((1 - a) * rise - b * 24).toFixed(1)}px) scale(${(lerp(1.04, 1, a) * lerp(1, 0.97, b)).toFixed(4)})` }}>
      {children}
    </div>
  );
};

/** a spring from 0 to 1 that starts at frame `at` (60 fps). Soft by default: settles without visible bounce. */
export const sp = (f: number, at: number, damping = 20, stiffness = 120, mass = 1) => (f < at ? 0 : spring({ frame: f - at, fps: 60, config: { damping, stiffness, mass } }));

/** a Mac keycap. tone 'dark' for the big hero keys, 'light' for the Apple keyboard look. */
export const KeyCap: React.FC<{ glyph?: string; label?: string; big?: string; w?: number; h?: number; down?: number; lit?: number; tone?: 'dark' | 'light' }> = ({ glyph, label, big, w = 200, h = 180, down = 0, lit = 0, tone = 'dark' }) => {
  const dark = tone === 'dark', r = h * 0.15;
  const face = dark ? 'linear-gradient(180deg, #303231 0%, #222423 55%, #1b1c1c 100%)' : 'linear-gradient(180deg, #ffffff 0%, #f6f5f3 60%, #eeedea 100%)';
  return (
    <div style={{ position: 'relative', width: w, height: h + h * 0.06 }}>
      {/* the key's skirt, visible below the face */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: h * 0.06, height: h, borderRadius: r, background: dark ? '#0c0d0d' : '#d8d5d0' }} />
      {/* contact shadow that tightens when the key goes down */}
      <div style={{ position: 'absolute', left: '6%', right: '6%', top: h * 0.5, height: h * 0.6, borderRadius: r, background: 'rgba(0,0,0,.5)', filter: `blur(${(h * (0.16 - down * 0.08)).toFixed(1)}px)`, opacity: dark ? 0.55 - down * 0.2 : 0.22 - down * 0.08 }} />
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 0, height: h, borderRadius: r, transform: `translateY(${(down * h * 0.05).toFixed(2)}px)`, overflow: 'hidden',
        background: face, boxShadow: dark ? 'inset 0 1.5px 0 rgba(255,255,255,.13), inset 0 -2px 0 rgba(0,0,0,.35)' : 'inset 0 1.5px 0 #fff, inset 0 -2px 0 rgba(0,0,0,.06), 0 0 0 1px rgba(0,0,0,.06)',
        color: dark ? '#f2f3f2' : '#1c1d1c', fontFamily: SANS, fontWeight: 500,
      }}>
        <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(180deg, ${C.green}, ${C.greenD})`, opacity: lit }} />
        <div style={{ position: 'absolute', inset: 0, color: lit > 0.5 ? '#fff' : undefined }}>
          {glyph && <span style={{ position: 'absolute', right: h * 0.12, top: h * 0.1, fontSize: h * 0.2 }}>{glyph}</span>}
          {label && <span style={{ position: 'absolute', left: h * 0.12, bottom: h * 0.11, fontSize: h * 0.155, letterSpacing: '0.01em' }}>{label}</span>}
          {big && <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: h * 0.32 }}>{big}</span>}
        </div>
      </div>
    </div>
  );
};
export const DarkKey = KeyCap;
/** keys rise in on a spring one after another, press together (down and back up), then either sink away
 *  or, with `dock`, glide up and shrink to sit beside the caption */
export const KeyCombo: React.FC<{ keys: { glyph?: string; label?: string; big?: string; w?: number }[]; at: number; press: number; out: number; h?: number; gap?: number; tone?: 'dark' | 'light'; dock?: { at: number; y: number; scale: number } }> = ({ keys, at, press, out, h = 180, gap = 20, tone = 'dark', dock }) => {
  const f = useCurrentFrame();
  const down = f < press - 4 ? 0 : f < press ? (f - press + 4) / 4 : Math.max(0, 1 - sp(f, press + 2, 12, 260));
  const lit = f < press ? 0 : 1 - ramp(f, press + 16, 34, EASE);
  const dk = dock ? sp(f, dock.at, 22, 110) : 0;
  return (
    <div style={{ display: 'flex', gap, alignItems: 'flex-end', transform: `translateY(${(dk * (dock?.y ?? 0)).toFixed(1)}px) scale(${lerp(1, dock?.scale ?? 1, dk).toFixed(4)})` }}>
      {keys.map((k, i) => {
        const a = sp(f, at + i * 6, 18, 140), z = sp(f, out - 18 + i * 3, 22, 160);
        const v = a * (1 - z);
        return (
          <div key={i} style={{ opacity: Math.min(1, v * 1.6), transform: `translateY(${((1 - a) * 70 + z * 40).toFixed(1)}px) scale(${lerp(0.94, 1, a).toFixed(4)})` }}>
            <KeyCap {...k} h={h} down={down} lit={lit} tone={tone} />
          </div>
        );
      })}
    </div>
  );
};

/** a smooth cursor path through timed waypoints: each leg eases and bows slightly, like a hand on a trackpad */
export function glide(f: number, pts: [number, number, number][]): { x: number; y: number; v: number } {
  const at = (q: number) => {
    if (q <= pts[0][0]) return { x: pts[0][1], y: pts[0][2] };
    for (let i = 0; i < pts.length - 1; i++) {
      const [f0, x0, y0] = pts[i], [f1, x1, y1] = pts[i + 1];
      if (q <= f1) {
        const u = EASE(Math.max(0, Math.min(1, (q - f0) / Math.max(1, f1 - f0))));
        const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), bow = L * 0.08 * Math.sin(u * Math.PI);
        return { x: x0 + dx * u + (-dy / (L || 1)) * bow, y: y0 + dy * u + (dx / (L || 1)) * bow };
      }
    }
    const l = pts[pts.length - 1]; return { x: l[1], y: l[2] };
  };
  const p = at(f), q = at(f - 1);
  return { x: p.x, y: p.y, v: Math.hypot(p.x - q.x, p.y - q.y) };
}

/** a big macOS pointer with a little motion blur when it travels */
export const Cursor: React.FC<{ x: number; y: number; vx?: number; press?: number; scale?: number; hand?: boolean }> = ({ x, y, vx = 0, press = 0, scale = 2.2, hand }) => (
  <svg viewBox="0 0 24 30" style={{ position: 'absolute', left: x, top: y, width: 24 * scale, height: 30 * scale, overflow: 'visible', transform: `scale(${(1 - press * 0.14).toFixed(3)})`, transformOrigin: '0 0', filter: `drop-shadow(0 4px 8px rgba(0,0,0,.3))${Math.abs(vx) > 6 ? ` blur(${Math.min(2.5, Math.abs(vx) / 18).toFixed(1)}px)` : ''}`, zIndex: 40 }}>
    {hand
      ? <path d="M9 13V4.5a2 2 0 0 1 4 0V11l1-.2a2 2 0 0 1 2.4 1.2l.3-.1a2 2 0 0 1 2.5 1.3 2 2 0 0 1 2.6 1.6l.3 4.6c.2 3.6-2.4 6.6-6 6.6h-2.5a6 6 0 0 1-4.7-2.3L4.3 18a2 2 0 0 1 2.9-2.7L9 17Z" fill="#fff" stroke="#111" strokeWidth="1.4" strokeLinejoin="round" />
      : <path d="M3 2v22l5.8-5.6 4.2 9 3.8-1.7-4.2-8.8H21z" fill="#111" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />}
  </svg>
);

/** a crisp white card that floats over the wallpaper */
export const Card: React.FC<{ x: number; y: number; w: number; h?: number; r?: number; children?: React.ReactNode; style?: React.CSSProperties }> = ({ x, y, w, h, r = 26, children, style }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: r, background: C.white, boxShadow: SHADOW, overflow: 'hidden', fontFamily: SANS, ...style }}>{children}</div>
);

export const LassoMark: React.FC<{ size?: number; color?: string; draw?: number; stroke?: number }> = ({ size = 40, color = C.green, draw = 1, stroke = 2.4 }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} fill="none" style={{ overflow: 'visible' }}>
    <ellipse cx="15" cy="12" rx="11" ry="7.5" transform="rotate(-10 15 12)" stroke={color} strokeWidth={stroke} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - Math.min(1, draw * 1.25)} />
    <path d="M19.5 18.6c1.6 3.2 4.6 4.6 7.6 9.4" stroke={color} strokeWidth={stroke} strokeLinecap="round" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - Math.max(0, draw * 1.6 - 0.6)} />
    <circle cx="19.3" cy="18.4" r={stroke * 0.95} fill={color} opacity={draw > 0.95 ? 1 : 0} />
  </svg>
);

export const Caret: React.FC<{ color?: string; blink?: boolean; h?: number }> = ({ color = C.ink, blink = false, h = 1.05 }) => {
  const f = useCurrentFrame();
  return <span style={{ display: 'inline-block', width: '0.06em', minWidth: 3, height: `${h}em`, marginLeft: '0.03em', verticalAlign: '-0.16em', background: color, opacity: !blink || Math.floor(f / 30) % 2 === 0 ? 1 : 0, borderRadius: 2 }} />;
};

