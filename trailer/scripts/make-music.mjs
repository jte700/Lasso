// The trailer's placeholder score: 90 BPM, 30 bars (exactly 80 s), stereo 44.1 kHz.
// Everything is synthesized (additive pads, FM electric piano, Karplus–Strong plucks, drums, a Freeverb-style
// reverb), and the arrangement follows the edit bar by bar so cuts can land on the grid.
// Bars (0-based):  0–2.5 intro · 2.5–10 history (builds) · 10–13 stop/interruption · 13–18 workplace
//                  (filtered dip 16.5–18) · 18 Tab drop · 20–22 leap · 22–27 capabilities · 27–30 outro.
import { writeFileSync, mkdirSync } from 'node:fs';

const SR = 44100, BPM = 90, BEAT = 60 / BPM, BAR = BEAT * 4, BARS = 30, LEN = Math.round(BARS * BAR * SR);
const OUT = new URL('../public/sfx/', import.meta.url);
mkdirSync(OUT, { recursive: true });

let seed = 11;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rand() * 2 - 1;
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const at = (bar, beat = 0) => Math.round((bar * BAR + beat * BEAT) * SR);
const TAU = Math.PI * 2;

const bus = () => [new Float32Array(LEN), new Float32Array(LEN)];
const pad = bus(), bass = bus(), drums = bus(), mel = bus(), send = bus();
function add(b, start, data, gl, gr, sendAmt = 0) {
  for (let i = 0; i < data.length; i++) {
    const j = start + i; if (j < 0 || j >= LEN) continue;
    b[0][j] += data[i] * gl; b[1][j] += data[i] * gr;
    if (sendAmt) { send[0][j] += data[i] * gl * sendAmt; send[1][j] += data[i] * gr * sendAmt; }
  }
}
const panG = (p) => [Math.cos((p + 1) * Math.PI / 4), Math.sin((p + 1) * Math.PI / 4)];

/* ── instruments ── */
function epiano(m, dur, vel = 1) {
  const f = mtof(m), n = Math.round((dur + 2.2) * SR), d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR, rel = t > dur ? Math.exp(-(t - dur) * 3) : 1;
    const I = 1.6 * Math.exp(-t * 4) + 0.25;
    const env = Math.min(1, t / 0.003) * Math.exp(-t * 0.9) * rel;
    d[i] = (Math.sin(TAU * f * t + I * Math.sin(TAU * f * t)) + 0.05 * Math.sin(TAU * f * 6.9 * t) * Math.exp(-t * 14)) * env * vel;
  }
  return d;
}
function pluck(m, vel = 1, bright = 0.5, t60 = 1.4) {
  const f = mtof(m), N = Math.max(2, Math.round(SR / f)), n = Math.round(t60 * 1.3 * SR), d = new Float32Array(n);
  const buf = new Float32Array(N); let lp = 0;
  for (let i = 0; i < N; i++) { lp += (noise() - lp) * (0.2 + bright * 0.8); buf[i] = lp; }
  const decay = Math.pow(10, -3 / (t60 * f)); let p = 0, y = 0;
  for (let i = 0; i < n; i++) {
    const a = buf[p], b = buf[(p + 1) % N];
    buf[p] = decay * 0.5 * (a + b); d[i] = a; p = (p + 1) % N;
  }
  for (let i = 0; i < n; i++) { y += (d[i] - y) * 0.45; d[i] = y * vel * Math.min(1, i / 40); }
  return d;
}
function padChord(notes, t0, dur, bright = 0.5, vel = 1) {
  const n = Math.round((dur + 1.6) * SR), L = new Float32Array(n), R = new Float32Array(n);
  const cutoff = 600 + bright * 3600;
  notes.forEach((m, k) => {
    [-7, 0, 7].forEach((cents, v) => {
      const f = mtof(m) * 2 ** (cents / 1200), [gl, gr] = panG([-0.6, 0, 0.6][v] * (k % 2 ? -1 : 1));
      const H = Math.min(18, Math.floor(9000 / f));
      const w = []; for (let h = 1; h <= H; h++) w.push((1 / h) / (1 + (h * f / cutoff) ** 4));
      const ph0 = rand() * TAU;
      for (let i = 0; i < n; i++) {
        const t = i / SR, env = Math.min(1, t / 0.9) * (t > dur ? Math.max(0, 1 - (t - dur) / 1.6) : 1);
        if (env <= 0) continue;
        let s = 0; const base = TAU * f * t + ph0;
        for (let h = 0; h < w.length; h++) s += w[h] * Math.sin(base * (h + 1));
        s *= env * 0.11 * vel; L[i] += s * gl; R[i] += s * gr;
      }
    });
  });
  const j = Math.round(t0 * SR);
  for (let i = 0; i < n; i++) { const q = j + i; if (q >= LEN) break; pad[0][q] += L[i]; pad[1][q] += R[i]; send[0][q] += L[i] * 0.35; send[1][q] += R[i] * 0.35; }
}
function kick(vel = 1) {
  const n = Math.round(0.5 * SR), d = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += TAU * (46 + 95 * Math.exp(-t * 30)) / SR; d[i] = (Math.sin(ph) * Math.exp(-t * 7) + noise() * Math.exp(-t * 600) * 0.25) * vel; }
  return d;
}
function shaker(vel = 1) {
  const n = Math.round(0.09 * SR), d = new Float32Array(n); let a = 0, b = 0;
  for (let i = 0; i < n; i++) { const t = i / SR, x = noise(); a += (x - a) * 0.5; b = x - a; d[i] = b * Math.min(1, t / 0.006) * Math.exp(-t * 45) * vel; }
  return d;
}
function clap(vel = 1) {
  const n = Math.round(0.35 * SR), d = new Float32Array(n); let lp = 0, hp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; let e = 0;
    for (const o of [0, 0.009, 0.019]) if (t >= o) e = Math.max(e, Math.exp(-(t - o) * 260));
    e = Math.max(e, 0.35 * Math.exp(-t * 16) * (t > 0.02 ? 1 : 0));
    const x = noise(); lp += (x - lp) * 0.35; hp = x - lp; d[i] = (hp * 0.7 + lp * 0.3) * e * vel;
  }
  return d;
}
function bassNote(m, dur, vel = 1) {
  const f = mtof(m), n = Math.round((dur + 0.15) * SR), d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = Math.min(1, t / 0.012) * (t > dur ? Math.max(0, 1 - (t - dur) / 0.15) : 1) * (0.75 + 0.25 * Math.exp(-t * 3));
    d[i] = Math.tanh(1.4 * (Math.sin(TAU * f * t) + 0.3 * Math.sin(TAU * 2 * f * t))) * env * vel;
  }
  return d;
}
function riser(dur, vel = 1) {
  const n = Math.round(dur * SR), d = new Float32Array(n); let low = 0, band = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n, fc = 300 + 7000 * u * u, F = 2 * Math.sin(Math.PI * fc / SR), q = 0.35;
    const x = noise(); low += F * band; const high = x - low - q * band; band += F * high;
    d[i] = band * u * u * vel * 0.6;
  }
  return d;
}
function boom(vel = 1) {
  const n = Math.round(3.5 * SR), d = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += TAU * (38 + 40 * Math.exp(-t * 9)) / SR; d[i] = Math.sin(ph) * Math.exp(-t * 1.6) * Math.min(1, t / 0.004) * vel; }
  return d;
}

/* ── harmony ── */
const CHORDS = [
  { pad: [53, 57, 60, 64, 67], bass: 41, arp: [65, 69, 72, 76, 79, 72] }, // Fmaj9
  { pad: [55, 57, 60, 64], bass: 45, arp: [64, 69, 72, 76, 79, 72] },     // Am7
  { pad: [55, 59, 62, 64], bass: 43, arp: [62, 67, 71, 74, 76, 71] },     // G6
  { pad: [52, 55, 59, 62], bass: 36, arp: [64, 67, 71, 74, 79, 71] },     // Cmaj9
];
const chordAt = (bar) => CHORDS[Math.floor(bar) % 4];
const inRange = (bar, a, b) => bar >= a && bar < b;

/* ── arrangement ── */
// pads: one chord per bar, except the interruption
for (let b = 0; b < BARS; b++) {
  if (inRange(b, 10, 13)) continue;
  const bright = b < 3 ? 0.15 : b < 10 ? 0.25 + (b - 3) * 0.05 : b < 18 ? 0.35 : b < 27 ? 0.7 : 0.55;
  const vel = b < 2 ? 0.6 + b * 0.2 : 1;
  padChord(chordAt(b).pad, b * BAR, b === 29 ? BAR * 0.9 : BAR, bright, vel);
}
// interruption: a low drone and one high note when "Finding didn't." lands
padChord([48, 55], 10 * BAR + BEAT * 0.5, BAR * 2.4, 0.08, 0.38);
add(mel, at(11, 0), epiano(76, 1.6, 0.35), ...panG(0.2), 0.6);
add(mel, at(12, 0), epiano(71, 1.2, 0.25), ...panG(-0.2), 0.6);
add(mel, at(12, 2), riser(BEAT * 6, 0.5), ...panG(0), 0.2);

// intro motif on electric piano
[[0, 0, 76, 1.8], [0, 2.5, 79, 0.8], [0, 3, 74, 1.4], [1, 0, 76, 1.8], [1, 2, 72, 1.2], [1, 3, 74, 0.9], [2, 0, 71, 2.0]].forEach(([b, bt, m, d]) => add(mel, at(b, bt), epiano(m, d, 0.55), ...panG(0.15), 0.5));

// plucked arpeggios
for (let b = 2.5; b < BARS; b += 0.125) {
  const bar = Math.floor(b), beat = (b - bar) * 4;
  if (inRange(b, 10, 13) || b >= 28.5) continue;
  if (inRange(b, 16.5, 18)) continue; // the hush before Lasso
  const sixteenth = inRange(b, 6.5, 10) || inRange(b, 14.5, 16.5) || inRange(b, 22, 28);
  const step = Math.round(b * 8);
  if (!sixteenth && step % 2) continue;
  const c = chordAt(bar), m = c.arp[(step >> (sixteenth ? 0 : 1)) % c.arp.length];
  const vel = (b < 6.5 ? 0.35 : 0.45) * (beat % 1 === 0 ? 1 : 0.75);
  add(mel, at(bar, beat), pluck(m, vel, 0.5, sixteenth ? 0.9 : 1.3), ...panG(((step % 4) - 1.5) * 0.25), 0.45);
}
// drums and bass
for (let bar = 0; bar < BARS; bar++) {
  for (let beat = 0; beat < 4; beat++) {
    const b = bar + beat / 4;
    const groove = inRange(b, 4, 10) || inRange(b, 13, 16.5) || inRange(b, 18, 20) || inRange(b, 21.5, 28);
    if (groove) {
      const four = inRange(b, 7, 10) || inRange(b, 22, 28);
      if (beat % 2 === 0 || four) add(drums, at(bar, beat), kick(beat % 2 === 0 ? 0.9 : 0.55), 1, 1, 0.05);
      if ((beat === 1 || beat === 3) && (inRange(b, 18, 20) || inRange(b, 22, 28))) add(drums, at(bar, beat), clap(0.45), ...panG(0.05), 0.35);
    }
    const shake = inRange(b, 5, 10) || inRange(b, 14.5, 16.5) || inRange(b, 18, 28);
    if (shake) for (let s = 0; s < 4; s++) add(drums, at(bar, beat + s / 4), shaker(s === 2 ? 0.13 : 0.065), ...panG(0.35), 0.1);
    const bassOn = inRange(b, 4, 10) || inRange(b, 13, 16.5) || inRange(b, 18, 28);
    if (bassOn) add(bass, at(bar, beat), bassNote(chordAt(bar).bass, BEAT * 0.8, beat === 0 ? 0.55 : 0.42), 1, 1);
  }
}
// risers into the big moments, and the hits
add(mel, at(9, 0), riser(BAR, 0.7), 1, 1, 0.3);
add(mel, at(17, 0), riser(BAR, 0.45), 1, 1, 0.3);
add(drums, at(18, 0), boom(0.55), 1, 1, 0.2);
add(mel, at(21, 0), riser(BAR, 0.5), 1, 1, 0.3);
add(drums, at(28, 0), boom(0.9), 1, 1, 0.3);
// the Tab moment: a bright chord stab, and the closing motif
[72, 76, 79, 84].forEach((m, k) => add(mel, at(18, 0) + k * 220, epiano(m, 1.4, 0.32), ...panG((k - 1.5) * 0.3), 0.7));
[[28, 0, 79, 1.2], [28, 1, 76, 1.2], [28, 2, 74, 1.2], [28, 3, 72, 3.2], [29, 0, 76, 3.5]].forEach(([b, bt, m, d]) => add(mel, at(b, bt), epiano(m, d, 0.5), ...panG(0.1), 0.65));

/* ── sidechain, reverb, master ── */
const duck = new Float32Array(LEN).fill(1);
for (let bar = 0; bar < BARS; bar++) for (let beat = 0; beat < 4; beat++) {
  const b = bar + beat / 4;
  if (!(inRange(b, 4, 10) || inRange(b, 13, 16.5) || inRange(b, 18, 20) || inRange(b, 21.5, 28))) continue;
  const s = at(bar, beat);
  for (let i = 0; i < SR * 0.5 && s + i < LEN; i++) duck[s + i] = Math.min(duck[s + i], 1 - 0.45 * Math.exp(-i / SR / 0.16));
}
function freeverb(inL, inR) {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], aps = [556, 441, 341, 225];
  const out = [new Float32Array(LEN), new Float32Array(LEN)];
  [inL, inR].forEach((inp, ch) => {
    const o = out[ch], sp = ch * 23;
    for (const c of combs) {
      const N = c + sp, buf = new Float32Array(N); let p = 0, f = 0;
      for (let i = 0; i < LEN; i++) { const y = buf[p]; f = y * 0.75 + f * 0.25; buf[p] = inp[i] * 0.015 + f * 0.86; o[i] += y; p = (p + 1) % N; }
    }
    for (const a of aps) {
      const N = a + sp, buf = new Float32Array(N); let p = 0;
      for (let i = 0; i < LEN; i++) { const b = buf[p], x = o[i]; o[i] = -x + b; buf[p] = x + b * 0.5; p = (p + 1) % N; }
    }
  });
  return out;
}
const verb = freeverb(send[0], send[1]);
// master automation: the hard stop into the interruption, the filtered hush before Lasso, and the fade out
const gainAt = (s) => {
  const b = s / SR / BAR;
  if (inRange(b, 16.5, 18)) return 1 - 0.55 * Math.min(1, (b - 16.5) / 0.4);
  if (b >= 29) return Math.max(0, 1 - (b - 29) / 1);
  return 1;
};
const cutoffAt = (s) => { const b = s / SR / BAR; return inRange(b, 16.3, 18) ? 9000 - 8400 * Math.min(1, (b - 16.3) / 0.6) : 16000; };
const L = new Float32Array(LEN), R = new Float32Array(LEN), DRIVE = 0.55;
let l1 = 0, l2 = 0, r1 = 0, r2 = 0, pre = 0;
for (let i = 0; i < LEN; i++) {
  const d = duck[i];
  let l = pad[0][i] * d + bass[0][i] * d * 0.55 + drums[0][i] * 0.8 + mel[0][i] + verb[0][i] * 0.9;
  let r = pad[1][i] * d + bass[1][i] * d * 0.55 + drums[1][i] * 0.8 + mel[1][i] + verb[1][i] * 0.9;
  const a = 1 - Math.exp(-TAU * cutoffAt(i) / SR);
  l1 += (l - l1) * a; l2 += (l1 - l2) * a; r1 += (r - r1) * a; r2 += (r1 - r2) * a;
  const g = gainAt(i);
  pre = Math.max(pre, Math.abs(l2 * g), Math.abs(r2 * g)); L[i] = Math.tanh(l2 * g * DRIVE); R[i] = Math.tanh(r2 * g * DRIVE);
}
let peak = 0; for (let i = 0; i < LEN; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const norm = 0.89 / peak;
const buf = Buffer.alloc(44 + LEN * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + LEN * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(LEN * 4, 40);
for (let i = 0; i < LEN; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * norm)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * norm)) * 32767), 46 + i * 4);
}
writeFileSync(new URL('score.wav', OUT), buf);
console.log(`pre-clip peak ${pre.toFixed(2)}`); console.log(`score.wav written: ${(LEN / SR).toFixed(2)} s, peak normalised from ${peak.toFixed(3)}`);
