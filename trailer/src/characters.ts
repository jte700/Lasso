// The Lasso cowboy and cowgirl, drawn as SVG strings (same construction as the website).
const PI = Math.PI;
const f1 = (n: number) => (+n).toFixed(1);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
function mulberry(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export const PALS = {
  bluegrass: { body: '#7b93ff', hat: '#f3ead2', band: '#2b3a8f', scarf: '#d4f75c', dots: '#2b3a8f' },
  desert: { body: '#f2b84b', hat: '#f3ead2', band: '#7a5232', scarf: '#2f6fdd', dots: '#f3ead2' },
  rodeo: { body: '#ff94b6', hat: '#f7f1e3', band: '#e03b1f', star: '#ffc83d', bow: '#e03b1f', hair: '#9a6a42' },
} as const;

export const HAND = { idle: { x: 68, y: -34 }, up: { x: 40, y: -150 }, throw: { x: 98, y: -84 }, pull: { x: 72, y: -56 }, hold: { x: 44, y: -152 } };
export type Char = {
  kind: 'cowboy' | 'cowgirl'; pal: any; x: number; y: number; k: number; lift?: number; sx?: number; sy?: number; rot?: number; face?: number;
  hand?: { x: number; y: number }; rope?: 'coil' | 'twirl' | 'none'; twirlA?: number; eyeOpen?: number; mood?: 'normal' | 'happy' | 'squint' | 'wide';
  look?: { x: number; y: number }; seed?: number; hatOff?: number; hatTilt?: number;
};
const BODY = [[-48, -20, 22], [-58, -60, 30], [-44, -101, 24], [-12, -115, 18], [24, -104, 20], [54, -86, 13], [60, -44, 22], [52, -15, 7], [0, -11, 34]];
function rounded(pts: number[][], r: number) {
  const n = pts.length; let d = '';
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const d1 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]), d2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), rr = Math.min(p1[2] ?? r, d1 / 2, d2 / 2);
    const a = [p1[0] + ((p0[0] - p1[0]) / d1) * rr, p1[1] + ((p0[1] - p1[1]) / d1) * rr], b = [p1[0] + ((p2[0] - p1[0]) / d2) * rr, p1[1] + ((p2[1] - p1[1]) / d2) * rr];
    d += `${i ? 'L' : 'M'}${f1(a[0])} ${f1(a[1])}Q${f1(p1[0])} ${f1(p1[1])} ${f1(b[0])} ${f1(b[1])}`;
  }
  return d + 'Z';
}
const bodyPath = (seed: number) => { const r = mulberry(seed * 7919 + 13); return rounded(BODY.map(([x, y, c]) => [x + (r() - 0.5) * 3.4, y + (r() - 0.5) * 3.4, c]), 24); };
const star = (cx: number, cy: number, r: number, c: string) => { let d = ''; for (let i = 0; i < 10; i++) { const a = -PI / 2 + (i * PI) / 5, rr = i % 2 ? r * 0.45 : r; d += (i ? 'L' : 'M') + f1(cx + rr * Math.cos(a)) + ' ' + f1(cy + rr * Math.sin(a)); } return `<path fill="${c}" d="${d}Z"/>`; };
const ROPE = '#2b2622';

export function toWorld(P: Char, px: number, py: number) {
  const k = P.k, x = px * k * (P.sx ?? 1) * (P.face ?? 1), y = py * k * (P.sy ?? 1), a = ((P.rot ?? 0) * PI) / 180;
  return { x: P.x + x * Math.cos(a) - y * Math.sin(a), y: P.y - (P.lift ?? 0) + x * Math.sin(a) + y * Math.cos(a) };
}
export function charSVG(P: Char, t = 0) {
  const p = P.pal, H = P.hand ?? HAND.idle, S = { x: 46, y: -62 }, face = P.face ?? 1, mood = P.mood ?? 'normal', open = P.eyeOpen ?? 1;
  const look = P.look ?? { x: 0.5, y: 0 }, lx = clamp(look.x, -1, 1) * face, ly = clamp(look.y, -1, 1);
  let eyes = '';
  for (const ex of [-20, 20]) {
    const ey = -66;
    if (mood === 'happy') { eyes += `<path d="M${ex - 8} ${ey + 3}Q${ex} ${ey - 9} ${ex + 8} ${ey + 3}" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round"/>`; continue; }
    const rx = mood === 'wide' ? 10.5 : 9, ry = Math.max(0.9, (mood === 'squint' ? 5.5 : mood === 'wide' ? 13 : 11.5) * open);
    eyes += `<ellipse fill="#fff" cx="${ex}" cy="${ey}" rx="${rx}" ry="${f1(ry)}"/>`;
    if (open > 0.35) { const pr = mood === 'wide' ? 4 : mood === 'squint' ? 3.6 : 5; eyes += `<circle fill="#111" cx="${f1(ex + lx * (rx - pr - 1.5))}" cy="${f1(ey + ly * Math.max(0, ry - pr - 1.5))}" r="${pr}"/>`; }
    if (P.kind === 'cowgirl' && open > 0.5) { const o = Math.sign(ex); eyes += `<path d="M${ex + o * 6} ${f1(ey - ry + 2)}l${o * 5} -4M${ex + o * 9} ${f1(ey - ry + 5)}l${o * 5} -2" fill="none" stroke="#111" stroke-width="2.6" stroke-linecap="round"/>`; }
  }
  if (mood === 'wide') eyes += '<ellipse fill="#111" cx="0" cy="-45" rx="4.5" ry="5.5"/>';
  if (mood === 'happy') eyes += '<path d="M-9 -49Q0 -39 9 -49" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round"/>';
  const hy = -106 + (P.hatOff ?? 0), tilt = 8 + (P.hatTilt ?? 0);
  const hat = P.kind === 'cowgirl'
    ? `<g transform="translate(3 ${f1(hy)}) rotate(${f1(tilt)})"><path fill="${p.hat}" d="M-24 2L-21 -26Q-12 -41 0 -30Q12 -41 21 -26L24 2Z"/><path fill="${p.band}" d="M-23.4 -8H23.4L24 0H-24Z"/>${star(0, -4.5, 6, p.star)}<path fill="${p.hat}" d="M-60 -10Q-53 8 -28 8Q0 11 28 8Q53 8 60 -10Q66 2 57 12Q38 21 0 21Q-38 21 -57 12Q-66 2 -60 -10Z"/></g>`
    : `<g transform="translate(3 ${f1(hy)}) rotate(${f1(tilt)})"><path fill="${p.hat}" d="M-26 2L-22 -30Q-12 -38 0 -31Q12 -38 22 -30L26 2Z"/><path fill="${p.band}" d="M-25.4 -8H25.4L26 0H-26Z"/><path fill="${p.hat}" d="M-62 -3Q-56 8 -30 9Q0 12 30 9Q56 8 62 -3Q64 4 58 11Q40 20 0 20Q-40 20 -58 11Q-64 4 -62 -3Z"/></g>`;
  const neck = P.kind === 'cowgirl'
    ? `<path fill="${p.bow}" d="M0 -32L-15 -41L-14 -23Z M0 -32L15 -41L14 -23Z"/><circle fill="${p.bow}" cx="0" cy="-32" r="4.6"/>`
    : `<path fill="${p.scarf}" d="M-30 -40Q0 -33 30 -40L5 -15Q0 -11 -5 -15Z"/><circle fill="${p.dots}" cx="-13" cy="-33" r="2"/><circle fill="${p.dots}" cx="9" cy="-32" r="2"/><circle fill="${p.dots}" cx="-1" cy="-23" r="2"/>`;
  let braids = '';
  if (P.kind === 'cowgirl') for (const o of [-1, 1]) braids += `<ellipse fill="${p.hair}" cx="${o * 52}" cy="-86" rx="7" ry="8"/><ellipse fill="${p.hair}" cx="${o * 55}" cy="-74" rx="6.5" ry="7.5"/><ellipse fill="${p.hair}" cx="${o * 57}" cy="-63" rx="6" ry="7"/><path fill="${p.bow}" d="M${o * 57} -55l-7 -5v10zM${o * 57} -55l7 -5v10z"/>`;
  let rope = '';
  if (P.rope === 'coil' || P.rope === undefined) { const sw = Math.sin(t / 10) * 7; rope = `<g transform="rotate(${f1(sw)} ${H.x} ${H.y})"><path d="M${H.x} ${H.y}q3 9 1 14" fill="none" stroke="${ROPE}" stroke-width="3.4" stroke-linecap="round"/><ellipse cx="${H.x + 2}" cy="${H.y + 31}" rx="12" ry="17" fill="none" stroke="${ROPE}" stroke-width="3.4"/><circle fill="${ROPE}" cx="${H.x + 1}" cy="${H.y + 14}" r="3.4"/></g>`; }
  if (P.rope === 'twirl') {
    const cx = H.x - 4, cy = H.y - 26, rx = 56, ry = 15, a = P.twirlA ?? 0, px = cx + rx * Math.cos(a), py = cy + ry * Math.sin(a);
    rope = `<path d="M${cx - rx} ${cy}A${rx} ${ry} 0 0 1 ${cx + rx} ${cy}" fill="none" stroke="${ROPE}" stroke-width="3.4" opacity=".4"/><path d="M${H.x} ${H.y}L${f1(px)} ${f1(py)}" fill="none" stroke="${ROPE}" stroke-width="3.4" stroke-linecap="round"/><path d="M${cx - rx} ${cy}A${rx} ${ry} 0 0 0 ${cx + rx} ${cy}" fill="none" stroke="${ROPE}" stroke-width="3.4"/><circle fill="${ROPE}" cx="${f1(px)}" cy="${f1(py)}" r="3.6"/>`;
  }
  const k = P.k, sx = (P.sx ?? 1) * face, sy = P.sy ?? 1;
  return `<g transform="translate(${f1(P.x)} ${f1(P.y - (P.lift ?? 0))}) rotate(${f1(P.rot ?? 0)}) scale(${f1(k * sx * 100) / 100} ${f1(k * sy * 100) / 100})">`
    + braids + `<ellipse fill="${p.body}" cx="-21" cy="-8" rx="14" ry="8.5"/><ellipse fill="${p.body}" cx="23" cy="-8" rx="14" ry="8.5"/>`
    + `<path fill="${p.body}" d="${bodyPath(P.seed ?? 1)}"/>` + neck
    + `<path fill="none" stroke="${p.body}" stroke-width="15" stroke-linecap="round" d="M${S.x} ${S.y}Q${f1((S.x + H.x) / 2 + 8)} ${f1((S.y + H.y) / 2 + 8)} ${f1(H.x)} ${f1(H.y)}"/><circle fill="${p.body}" cx="${f1(H.x)}" cy="${f1(H.y)}" r="9.5"/>`
    + eyes + hat + rope + '</g>';
}
// the thrown loop and the line back to the hand
export function thrownRope(P: Char, L: { x: number; y: number }, rx: number, ry: number, tension: number, sw = 5) {
  const Hh = toWorld(P, (P.hand ?? HAND.idle).x, (P.hand ?? HAND.idle).y), a = Math.atan2(Hh.y - L.y, Hh.x - L.x);
  const K = { x: L.x + rx * Math.cos(a), y: L.y + ry * Math.sin(a) }, sag = (1 - tension) * 160;
  return `<ellipse cx="${f1(L.x)}" cy="${f1(L.y)}" rx="${f1(rx)}" ry="${f1(ry)}" fill="none" stroke="${ROPE}" stroke-width="${sw}"/>`
    + `<path d="M${f1(Hh.x)} ${f1(Hh.y)}Q${f1((Hh.x + K.x) / 2)} ${f1((Hh.y + K.y) / 2 + sag)} ${f1(K.x)} ${f1(K.y)}" fill="none" stroke="${ROPE}" stroke-width="${sw}" stroke-linecap="round"/><circle fill="${ROPE}" cx="${f1(K.x)}" cy="${f1(K.y)}" r="${sw * 1.3}"/>`;
}
// blink: the eyes close briefly every few seconds
export const blink = (f: number, seed = 0) => { const p = (f + seed * 37) % 110; return p < 5 ? Math.abs(1 - p / 2.5) : 1; };
