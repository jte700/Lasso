// "Dear John," written stroke by stroke, and a line-drawn hand holding the pen.
// Glyphs live in a box where 0 is the cap line, 45 the x-height and 100 the baseline.
import React from 'react';
import { Pt, Stroke, densify, lengthOf, cut, mulberry } from './sketch';

const GLYPHS: Record<string, { w: number; s: Pt[][] }> = {
  D: { w: 74, s: [[[4, 2], [3, 50], [5, 100]], [[0, 5], [30, 0], [58, 14], [70, 48], [60, 84], [32, 99], [2, 97]]] },
  e: { w: 60, s: [[[6, 72], [40, 66], [50, 54], [40, 44], [20, 46], [8, 62], [8, 84], [22, 98], [44, 99], [56, 90]]] },
  a: { w: 64, s: [[[50, 56], [38, 45], [20, 47], [8, 64], [10, 88], [24, 99], [42, 94], [50, 78]], [[52, 46], [50, 76], [52, 96], [60, 100]]] },
  r: { w: 46, s: [[[8, 46], [9, 72], [8, 99]], [[9, 66], [16, 52], [30, 45], [44, 47]]] },
  ' ': { w: 30, s: [] },
  J: { w: 70, s: [[[16, 5], [42, 1], [68, 3]], [[46, 2], [47, 50], [45, 96], [36, 118], [20, 124], [6, 114], [4, 100]]] },
  o: { w: 62, s: [[[36, 45], [18, 49], [8, 66], [10, 88], [26, 99], [46, 95], [56, 78], [54, 58], [42, 46], [28, 47]]] },
  h: { w: 62, s: [[[10, 0], [9, 50], [10, 99]], [[10, 66], [20, 52], [36, 46], [50, 52], [52, 74], [51, 99]]] },
  n: { w: 62, s: [[[8, 46], [9, 72], [8, 99]], [[9, 64], [20, 51], [36, 46], [50, 53], [52, 76], [52, 99]]] },
  ',': { w: 22, s: [[[10, 90], [12, 98], [9, 108], [3, 116]]] },
};

export type Written = { strokes: Pt[][]; lens: number[]; total: number; plan: { a: number; b: number }[] };
/** lay out text as dense pen strokes at (x, y) (y = baseline), `size` px per 100 units */
export function write(text: string, x: number, y: number, size: number, seed = 5): Written {
  const k = size / 100, r = mulberry(seed);
  let cx = x;
  const strokes: Pt[][] = [];
  for (const ch of text) {
    const g = GLYPHS[ch]; if (!g) continue;
    const rot = (r() - 0.5) * 0.06, sc = 1 + (r() - 0.5) * 0.08, dy = (r() - 0.5) * 5;
    for (const s of g.s) {
      strokes.push(densify(s.map(([gx, gy]) => {
        const lx = gx * sc, ly = (gy - 100) * sc;
        const rx = lx * Math.cos(rot) - ly * Math.sin(rot), ry = lx * Math.sin(rot) + ly * Math.cos(rot);
        return [cx + (rx - ry * 0.2 + (r() - 0.5) * 2.5) * k, y + (ry + dy + (r() - 0.5) * 2.5) * k] as Pt; // slanted, a little uneven
      }), 9));
    }
    cx += (g.w + 7 + (r() - 0.5) * 4) * k;
  }
  // time plan: the pen draws at a steady speed and lifts between strokes (lift time ∝ distance)
  const lens = strokes.map(lengthOf); let t = 0; const plan: { a: number; b: number }[] = [];
  strokes.forEach((s, i) => {
    if (i) { const p = strokes[i - 1][strokes[i - 1].length - 1], q = s[0]; t += 18 + Math.hypot(q[0] - p[0], q[1] - p[1]) * 0.4; }
    plan.push({ a: t, b: t + lens[i] }); t += lens[i];
  });
  return { strokes, lens, total: t, plan };
}
/** strokes drawn by "time" u (in the plan's units), and where the pen is */
export function writtenAt(W: Written, u: number, boil: number): { ink: Stroke[]; tip: Pt; down: boolean } {
  const ink: Stroke[] = []; let tip: Pt = W.strokes[0][0], down = false;
  W.strokes.forEach((s, i) => {
    const { a, b } = W.plan[i];
    if (u <= a) return;
    const len = Math.min(u, b) - a;
    const part = cut(s, len);
    const j = mulberry(i * 97 + boil * 13);
    const jit = part.pts.map(([x, y]) => [x + (j() - 0.5) * 0.9, y + (j() - 0.5) * 0.9] as Pt);
    const d = jit.map((p, n) => `${n ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
    ink.push({ d, o: 0.95, w: 7 }, { d: jit.map((p, n) => `${n ? 'L' : 'M'}${(p[0] + 1.6).toFixed(1)} ${(p[1] + 1.2).toFixed(1)}`).join(''), o: 0.22, w: 4 });
    if (u < b) { tip = part.tip; down = true; }
    else {
      tip = s[s.length - 1];
      const next = W.strokes[i + 1];
      if (next && u < W.plan[i + 1].a) { const g = (u - b) / (W.plan[i + 1].a - b), q = next[0]; tip = [tip[0] + (q[0] - tip[0]) * g, tip[1] + (q[1] - tip[1]) * g - Math.sin(g * Math.PI) * 26]; }
    }
  });
  return { ink, tip, down };
}

/** a hand holding a pen, as a clean illustration; the pen tip is at (0, 0) */
const smooth = (pts: Pt[], closed = false) => {
  const P = closed ? [...pts, pts[0], pts[1]] : pts;
  const d = densify(P, 10);
  const D = closed ? d.slice(0, d.length - 10) : d;
  return D.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('') + (closed ? 'Z' : '');
};
const SKIN: Pt[] = [[50, -90], [48, -102], [60, -114], [86, -136], [118, -153], [152, -160], [188, -153], [238, -154], [292, -128], [332, -84], [354, -30],
  [330, 18], [282, -6], [232, -28], [206, -16], [176, -20], [158, -36], [138, -28], [110, -34], [94, -50], [76, -40], [46, -38], [29, -50], [30, -65], [42, -72], [56, -80]];
const SLEEVE: Pt[] = [[350, -40], [480, 22], [440, 100], [322, 24]];
const DETAILS: Pt[][] = [
  [[62, -80], [92, -96], [124, -110], [150, -118]],          // underside of the index finger
  [[96, -54], [112, -38], [138, -30]], [[160, -40], [178, -24], [204, -18]], // curled fingers
  [[150, -158], [158, -146], [156, -134]],                    // knuckle
  [[42, -70], [56, -60], [76, -56], [100, -60]],              // thumb crease
];
const PEN_ANGLE = (Math.atan2(-0.89, 0.46) * 180) / Math.PI;
export const HandSvg: React.FC<{ x: number; y: number; rot?: number; scale?: number; p?: number; boil?: number; color?: string }> = ({ x, y, rot = 0, scale = 1.5, p = 1 }) => (
  <svg width={1} height={1} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', opacity: p }}>
    <defs>
      <linearGradient id="skin" x1="0" y1="-160" x2="0" y2="40" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#f6d9c6" /><stop offset="1" stopColor="#e9b99d" /></linearGradient>
      <linearGradient id="barrel3" x1="0" y1="-10" x2="0" y2="10" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#3b4a66" /><stop offset=".45" stopColor="#1a2234" /><stop offset="1" stopColor="#0b0f18" /></linearGradient>
      <linearGradient id="nib3" x1="0" y1="-9" x2="0" y2="9" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#f6e2a6" /><stop offset=".5" stopColor="#cfa24a" /><stop offset="1" stopColor="#8d6a24" /></linearGradient>
      <linearGradient id="sleeve" x1="330" y1="-30" x2="470" y2="90" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#2e7a55" /><stop offset="1" stopColor="#1d5a3e" /></linearGradient>
    </defs>
    <g transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(2)}) scale(${scale})`}>
      {/* soft shadow of the hand on the page */}
      <path d={smooth(SKIN, true)} fill="rgba(30,25,20,.10)" transform="translate(16 22)" style={{ filter: 'blur(9px)' }} />
      {/* the pen sits under the fingers */}
      <g transform={`rotate(${PEN_ANGLE.toFixed(2)})`}>
        <path d="M0 0L36 -8L36 8Z" fill="url(#nib3)" />
        <path d="M3 0H30" stroke="#6b4c16" strokeWidth="1.2" />
        <rect x="34" y="-9" width="50" height="18" rx="5" fill="#121417" />
        <rect x="82" y="-10.5" width="262" height="21" rx="10" fill="url(#barrel3)" />
        <rect x="92" y="-7.5" width="240" height="3.5" rx="1.75" fill="rgba(255,255,255,.3)" />
        <rect x="150" y="-11" width="9" height="22" rx="2" fill="url(#nib3)" />
      </g>
      <path d={smooth(SKIN, true)} fill="url(#skin)" stroke="#5a4034" strokeOpacity=".55" strokeWidth={1.6} strokeLinejoin="round" />
      {DETAILS.map((d, i) => <path key={i} d={smooth(d)} fill="none" stroke="#7a5646" strokeOpacity=".5" strokeWidth={1.5} strokeLinecap="round" />)}
      <path d={smooth(SLEEVE, true)} fill="url(#sleeve)" />
      <path d="M346 -36C330 -6 326 14 324 24" fill="none" stroke="#174a33" strokeWidth={3} strokeLinecap="round" opacity=".6" />
    </g>
  </svg>
);
