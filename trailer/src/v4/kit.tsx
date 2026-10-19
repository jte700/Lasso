// v4: the 50-second cut. Same visual language as v3, with three additions:
// a smoothed camera (no velocity jumps between keyframes), frosted caption pills that grow word by word,
// and the Lasso card with a live document preview.
import React from 'react';
import { interpolate, interpolateColors, useCurrentFrame } from 'remotion';
import { C, SANS, MONO, SHADOW, LassoMark, sp, ramp, lerp, clamp, EASE, EXIT } from '../v3/kit';
export * from '../v3/kit';

/* 120 BPM at 60 fps */
export const BEAT = 30, BAR = 120;

/** keyframed camera [frame, scale, cx, cy], eased per leg and then Gaussian-smoothed over time,
 *  so zooms and pans start and stop like a real camera operator rather than a keyframe */
export type CamKey = [number, number, number, number];
const camRaw = (f: number, keys: CamKey[]) => {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1][0] <= f) i++;
  const a = keys[i], b = keys[i + 1];
  const u = interpolate(f, [a[0], b[0]], [0, 1], { ...clamp, easing: EASE });
  return { ls: lerp(Math.log(a[1]), Math.log(b[1]), u), x: lerp(a[2], b[2], u), y: lerp(a[3], b[3], u) };
};
export function smoothCam(f: number, keys: CamKey[], sigma = 9) {
  let ls = 0, x = 0, y = 0, wsum = 0;
  for (let k = -3 * sigma; k <= 3 * sigma; k += 2) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma)), c = camRaw(f + k, keys);
    ls += c.ls * w; x += c.x * w; y += c.y * w; wsum += w;
  }
  const s = Math.exp(ls / wsum);
  return { s, cx: x / wsum, cy: y / wsum, css: `translate(${(960 - s * (x / wsum)).toFixed(2)}px, ${(540 - s * (y / wsum)).toFixed(2)}px) scale(${s.toFixed(4)})` };
}
/** a stage point → where it lands on screen under a camera */
export const toScreen = (cam: { s: number; cx: number; cy: number }, x: number, y: number) => ({ x: 960 + (x - cam.cx) * cam.s, y: 540 + (y - cam.cy) * cam.s });

/** a frosted caption pill: readable on any background. Words join on a spring and the pill grows to fit them. */
export const Pill: React.FC<{ parts: { text: string; at: number }[]; out: number; top?: number; size?: number; dark?: boolean }> = ({ parts, out, top = 64, size = 34, dark }) => {
  const f = useCurrentFrame();
  const first = parts[0].at;
  const v = sp(f, first + 1, 20, 150) * (1 - ramp(f, out - 14, 14, EXIT));
  if (v < 0.005) return null;
  const words: { w: string; at: number }[] = [];
  parts.forEach((p) => p.text.split(' ').forEach((w, i) => words.push({ w, at: p.at + i * 5 })));
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top, display: 'flex', justifyContent: 'center', zIndex: 30, pointerEvents: 'none' }}>
      <div style={{
        display: 'flex', alignItems: 'center', padding: `${size * 0.42}px ${size * 0.75}px`, borderRadius: 999, opacity: Math.min(1, v * 1.4),
        transform: `translateY(${((1 - v) * -16).toFixed(1)}px) scale(${lerp(0.92, 1, v).toFixed(4)})`,
        background: dark ? 'rgba(14,18,15,.78)' : 'rgba(255,255,255,.86)', backdropFilter: 'blur(18px)', boxShadow: '0 1px 1px rgba(0,0,0,.05), 0 10px 30px rgba(0,0,0,.14)',
        fontFamily: SANS, fontWeight: 600, fontSize: size, letterSpacing: '-0.015em', whiteSpace: 'nowrap', color: dark ? '#fff' : C.ink,
      }}>
        {words.map(({ w, at }, i) => {
          const k = sp(f, at, 22, 170);
          const col = interpolateColors(f - at, [0, 10, 26], [C.greenD, C.greenD, dark ? '#ffffff' : C.ink]);
          return (
            <span key={i} style={{ display: 'inline-block', overflow: 'hidden', maxWidth: `${(k * (w.length * 0.62 + 0.4)).toFixed(3)}em`, opacity: Math.min(1, k * 1.3), color: col, filter: k < 0.98 ? `blur(${((1 - k) * 6).toFixed(1)}px)` : undefined, transform: `translateY(${((1 - k) * 0.3).toFixed(3)}em)` }}>
              {w}{i < words.length - 1 ? ' ' : ''}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** the Lasso card: value, source, and a preview of the document it came from */
export const LassoCard: React.FC<{ show: number; tab?: boolean; scale?: number }> = ({ show, tab, scale = 1 }) => {
  const f = useCurrentFrame();
  const s = Math.max(0, Math.min(1, show)), k = scale;
  const rows: [number, string, string][] = [[45, 'Creative agency', '$118,400'], [46, 'Paid social', '$96,350'], [47, 'Q4 launch — total', '$428,750'], [48, 'Brand refresh', '$54,900']];
  return (
    <div style={{ width: 560 * k, transformOrigin: '0 0', transform: `translateY(${((1 - s) * -14).toFixed(1)}px) scale(${lerp(0.9, 1, s).toFixed(4)})`, opacity: Math.min(1, s * 1.5), background: C.white, borderRadius: 24 * k, boxShadow: SHADOW, overflow: 'hidden', fontFamily: SANS, whiteSpace: 'nowrap' }}>
      <div style={{ padding: `${18 * k}px ${22 * k}px ${12 * k}px`, display: 'flex', alignItems: 'center', gap: 14 * k }}>
        <LassoMark size={30 * k} draw={s} />
        <span style={{ fontWeight: 700, fontSize: 40 * k, letterSpacing: '-0.025em', color: C.ink }}>$428,750</span>
        <span style={{ marginLeft: 'auto', fontWeight: 600, fontSize: 16 * k, padding: `${5 * k}px ${11 * k}px`, borderRadius: 8 * k, background: tab ? C.green : C.sand, color: tab ? '#fff' : C.ink2 }}>tab</span>
      </div>
      <div style={{ padding: `0 ${22 * k}px ${12 * k}px`, fontFamily: MONO, fontSize: 17 * k, color: C.ink3 }}>Q4_Budget_Final.xlsx · Marketing · Row 47</div>
      {/* the document preview */}
      <div style={{ margin: `0 ${14 * k}px ${14 * k}px`, borderRadius: 14 * k, background: '#fbfaf8', boxShadow: `inset 0 0 0 1px ${C.line}`, overflow: 'hidden', fontSize: 17 * k }}>
        {rows.map(([n, a, v], i) => {
          const on = n === 47, glow = on ? 0.55 + 0.45 * Math.sin(f * 0.12) : 0;
          return (
            <div key={n} style={{ display: 'grid', gridTemplateColumns: `${42 * k}px 1fr ${120 * k}px`, height: 38 * k, alignItems: 'center', borderTop: i ? '1px solid #efece8' : undefined, background: on ? `rgba(246,196,69,${(0.35 + glow * 0.2).toFixed(3)})` : undefined, fontWeight: on ? 600 : 400, opacity: lerp(0, 1, ramp(s * 30, 8 + i * 3, 10)) }}>
              <span style={{ textAlign: 'center', color: C.ink3, fontSize: 14 * k }}>{n}</span><span style={{ color: C.ink }}>{a}</span><span style={{ fontFamily: MONO, textAlign: 'right', paddingRight: 14 * k, color: C.ink }}>{v}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

