// Hand-drawn line art, after the Lasso Box drawings: every line is drawn twice (a firm pass and a faint one),
// bows a little, wobbles, and its ends either overshoot or stop short, so corners rarely meet.
// `boil` re-rolls the small jitter a few times a second, which keeps the drawing alive.
import React from 'react';

export type Pt = [number, number];
export type Stroke = { d: string; o: number; w: number };
const PI = Math.PI;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export function mulberry(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const f1 = (n: number) => n.toFixed(1);
const poly = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${f1(p[0])} ${f1(p[1])}`).join('');

/** boil index: the jitter changes every 5 frames (12 times a second at 60 fps) */
export const boilAt = (f: number) => Math.floor(f / 5);

export function line(x1: number, y1: number, x2: number, y2: number, p: number, seed: number, boil: number, w = 3): Stroke[] {
  if (p <= 0) return [];
  const r = mulberry(seed), j = mulberry(seed * 31 + boil * 977);
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
  const out: Stroke[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const q = clamp(L / 140, 0.2, 1);
    const e1 = (-10 + r() * 26) * q, e2 = (-10 + r() * 26) * q;
    const s1 = ((r() - 0.5) * 9 + (j() - 0.5) * 2.2) * q, s2 = ((r() - 0.5) * 9 + (j() - 0.5) * 2.2) * q;
    const bow = (r() - 0.5) * L * 0.07, amp = (0.6 + r() * 1.8) * q, fr = 1.5 + r() * 2.5, ph = r() * 6 + (j() - 0.5) * 0.6;
    const ax = x1 - ux * e1 + nx * s1, ay = y1 - uy * e1 + ny * s1, bx = x2 + ux * e2 + nx * s2, by = y2 + uy * e2 + ny * s2;
    const cx = (ax + bx) / 2 + nx * bow, cy = (ay + by) / 2 + ny * bow;
    const n = Math.max(6, Math.round(L / 12)), m = Math.ceil(n * p), pts: Pt[] = [];
    for (let i = 0; i <= m; i++) {
      const t = Math.min(p, i / n), u = 1 - t, wob = amp * Math.sin(t * fr * PI + ph);
      pts.push([u * u * ax + 2 * u * t * cx + t * t * bx + nx * wob, u * u * ay + 2 * u * t * cy + t * t * by + ny * wob]);
    }
    out.push({ d: poly(pts), o: pass ? 0.35 : 0.95, w: pass ? w * 0.55 : w });
  }
  return out;
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, p: number, seed: number, boil: number, rot = 0, w = 3): Stroke[] {
  if (p <= 0) return [];
  const r = mulberry(seed), j = mulberry(seed * 13 + boil * 503), out: Stroke[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const a0 = r() * 2 * PI, sweep = (2 * PI + 0.45 + r() * 0.4) * p, pts: Pt[] = [];
    for (let i = 0; i <= 44; i++) {
      const a = a0 + (sweep * i) / 44, wob = 1 + 0.05 * Math.sin(a * 3 + seed) + (j() - 0.5) * 0.025 + (0.05 * i) / 44;
      const x = Math.cos(a) * rx * wob, y = Math.sin(a) * ry * wob;
      pts.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
    }
    out.push({ d: poly(pts), o: pass ? 0.35 : 0.95, w: pass ? w * 0.55 : w });
  }
  return out;
}

/** a rounded rectangle drawn as four loose sides plus soft corners that don't quite close */
export function rect(x: number, y: number, w: number, h: number, p: number, seed: number, boil: number, rad = 0, sw = 3): Stroke[] {
  const k = Math.min(rad, w / 2, h / 2);
  const sides: [number, number, number, number][] = [[x + k, y, x + w - k, y], [x + w, y + k, x + w, y + h - k], [x + w - k, y + h, x + k, y + h], [x, y + h - k, x, y + k]];
  const out: Stroke[] = [];
  sides.forEach((s, i) => out.push(...line(s[0], s[1], s[2], s[3], clamp(p * 4 - i, 0, 1), seed + i * 7, boil, sw)));
  if (k > 4) {
    const corners: Pt[] = [[x + k, y + k], [x + w - k, y + k], [x + w - k, y + h - k], [x + k, y + h - k]];
    corners.forEach(([cx, cy], i) => {
      const cp = clamp(p * 4 - i - 0.6, 0, 1); if (cp <= 0) return;
      const a0 = PI + (i * PI) / 2, rr = mulberry(seed * 3 + i), pts: Pt[] = [];
      for (let s = 0; s <= 8 * cp; s++) { const a = a0 + (s / 8) * (PI / 2) * (1.1 + rr() * 0.2) - 0.05; pts.push([cx + Math.cos(a) * k * (1 + (rr() - 0.5) * 0.08), cy + Math.sin(a) * k * (1 + (rr() - 0.5) * 0.08)]); }
      out.push({ d: poly(pts), o: 0.9, w: sw });
    });
  }
  return out;
}

/* a smooth, slightly shaky curve through points (Catmull–Rom), drawable up to a fraction of its length */
export function densify(pts: Pt[], per = 10): Pt[] {
  if (pts.length < 3) {
    const out: Pt[] = []; const [a, b] = [pts[0], pts[pts.length - 1]];
    for (let i = 0; i <= per; i++) out.push([a[0] + ((b[0] - a[0]) * i) / per, a[1] + ((b[1] - a[1]) * i) / per]);
    return out;
  }
  const out: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < per; s++) {
      const t = s / per, t2 = t * t, t3 = t2 * t;
      out.push([0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
export const lengthOf = (pts: Pt[]) => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; };
/** the first `len` units of a dense polyline, and the point where it ends */
export function cut(pts: Pt[], len: number): { pts: Pt[]; tip: Pt } {
  if (len <= 0) return { pts: [], tip: pts[0] };
  const out: Pt[] = [pts[0]]; let L = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (L + seg >= len) { const t = (len - L) / (seg || 1); const tip: Pt = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; out.push(tip); return { pts: out, tip }; }
    L += seg; out.push(pts[i]);
  }
  return { pts: out, tip: pts[pts.length - 1] };
}
/** a freehand curve: firm pass plus a faint offset pass, with boil */
export function curve(pts: Pt[], p: number, seed: number, boil: number, w = 3): Stroke[] {
  if (p <= 0) return [];
  const j = mulberry(seed * 17 + boil * 331), r = mulberry(seed);
  const dense = densify(pts, 8).map(([x, y], i) => [x + (j() - 0.5) * 1.4 + Math.sin(i * 0.4 + seed) * 0.6, y + (j() - 0.5) * 1.4] as Pt);
  const L = lengthOf(dense);
  const a = cut(dense, L * p).pts, ox = (r() - 0.5) * 4, oy = (r() - 0.5) * 4;
  return [{ d: poly(a), o: 0.95, w }, { d: poly(cut(dense, L * p * 0.97).pts.map(([x, y]) => [x + ox, y + oy] as Pt)), o: 0.3, w: w * 0.55 }];
}

export const Ink: React.FC<{ strokes: Stroke[]; color?: string; style?: React.CSSProperties; w?: number; h?: number }> = ({ strokes, color = '#1c2230', style, w = 1920, h = 1080 }) => (
  <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', ...style }}>
    {strokes.map((s, i) => <path key={i} d={s.d} fill="none" stroke={color} strokeOpacity={s.o} strokeWidth={s.w} strokeLinecap="round" strokeLinejoin="round" />)}
  </svg>
);
