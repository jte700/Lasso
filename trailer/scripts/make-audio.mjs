// Synthesizes the trailer's sound effects and music bed as 44.1 kHz mono WAV files in public/sfx.
// Everything is generated from oscillators and filtered noise, so there are no third-party audio assets.
import { writeFileSync, mkdirSync } from 'node:fs';

const SR = 44100;
const OUT = new URL('../public/sfx/', import.meta.url);
mkdirSync(OUT, { recursive: true });

let seed = 7;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rand() * 2 - 1;

function write(name, data, peak = 0.9) {
  let max = 0;
  for (const v of data) max = Math.max(max, Math.abs(v));
  const g = max > 0 ? peak / max : 1;
  const buf = Buffer.alloc(44 + data.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(data.length * 2, 40);
  data.forEach((v, i) => buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * g * 32767))), 44 + i * 2));
  writeFileSync(new URL(name, OUT), buf);
}
const make = (sec) => new Float32Array(Math.round(sec * SR));
// simple one-pole filters
function lowpass(data, hz) { const a = 1 - Math.exp(-2 * Math.PI * hz / SR); let y = 0; for (let i = 0; i < data.length; i++) { y += a * (data[i] - y); data[i] = y; } return data; }
function highpass(data, hz) { const a = 1 - Math.exp(-2 * Math.PI * hz / SR); let y = 0; for (let i = 0; i < data.length; i++) { y += a * (data[i] - y); data[i] -= y; } return data; }
const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));

// pen on paper: bursts of bright, filtered noise, one per stroke
{
  const d = make(5.2);
  let t = 0.15;
  while (t < 5.0) {
    const len = 0.08 + rand() * 0.22, amp = 0.5 + rand() * 0.5;
    for (let i = Math.round(t * SR); i < Math.min(d.length, Math.round((t + len) * SR)); i++) {
      const u = (i / SR - t) / len, shape = Math.sin(Math.PI * u) ** 0.6;
      d[i] += noise() * amp * shape * (0.7 + 0.3 * Math.sin(i / SR * 2 * Math.PI * (30 + rand() * 4)));
    }
    t += len + 0.02 + rand() * 0.09;
  }
  highpass(d, 1800); lowpass(d, 7000);
  write('pen.wav', d, 0.5);
}
// a typewriter key: a sharp click on top of a short wooden thump
{
  const d = make(0.16);
  for (let i = 0; i < d.length; i++) {
    const t = i / SR;
    d[i] = noise() * env(t, 0.0005, 0.006) * 0.9 + Math.sin(2 * Math.PI * 180 * t) * env(t, 0.001, 0.03) * 0.6 + Math.sin(2 * Math.PI * 1200 * t) * env(t, 0.0005, 0.012) * 0.25;
  }
  highpass(d, 120);
  write('clack.wav', d, 0.85);
}
// the typewriter bell
{
  const d = make(1.8);
  const parts = [[2093, 1], [4186, 0.35], [5650, 0.2], [7330, 0.08]];
  for (let i = 0; i < d.length; i++) { const t = i / SR; d[i] = parts.reduce((s, [f, a]) => s + Math.sin(2 * Math.PI * f * t) * a * Math.exp(-t * (1.8 + f / 4000)), 0) * Math.min(1, t / 0.002); }
  write('ding.wav', d, 0.6);
}
// the carriage return: a ratchet then a slide
{
  const d = make(0.7);
  for (let k = 0; k < 9; k++) { const t0 = 0.02 + k * 0.035; for (let i = Math.round(t0 * SR); i < Math.round((t0 + 0.02) * SR); i++) d[i] += noise() * env(i / SR - t0, 0.0005, 0.004); }
  for (let i = Math.round(0.34 * SR); i < d.length; i++) { const t = i / SR - 0.34; d[i] += noise() * 0.25 * Math.sin(Math.PI * Math.min(1, t / 0.32)); }
  highpass(d, 600);
  write('carriage.wav', d, 0.55);
}
// a soft laptop key
{
  const d = make(0.07);
  for (let i = 0; i < d.length; i++) { const t = i / SR; d[i] = noise() * env(t, 0.0004, 0.004) + Math.sin(2 * Math.PI * 2400 * t) * env(t, 0.0004, 0.006) * 0.3; }
  highpass(d, 900); lowpass(d, 9000);
  write('key.wav', d, 0.45);
}
// a heavier key for Tab and Return
{
  const d = make(0.12);
  for (let i = 0; i < d.length; i++) { const t = i / SR; d[i] = noise() * env(t, 0.0004, 0.006) + Math.sin(2 * Math.PI * 900 * t) * env(t, 0.0005, 0.02) * 0.5; }
  highpass(d, 300);
  write('tab.wav', d, 0.6);
}
// a gentle confirmation chime for the moment Lasso fills the value in
{
  const d = make(1.6);
  for (let i = 0; i < d.length; i++) { const t = i / SR; d[i] = (Math.sin(2 * Math.PI * 784 * t) + 0.5 * Math.sin(2 * Math.PI * 1568 * t) + 0.25 * Math.sin(2 * Math.PI * 2352 * t)) * env(t, 0.004, 0.5) + (t > 0.09 ? (Math.sin(2 * Math.PI * 1175 * (t - 0.09)) * env(t - 0.09, 0.004, 0.55)) * 0.8 : 0); }
  write('chime.wav', d, 0.35);
}
// a mail notification: two soft tones
{
  const d = make(1.2);
  for (let i = 0; i < d.length; i++) { const t = i / SR; d[i] = Math.sin(2 * Math.PI * 1319 * t) * env(t, 0.003, 0.18) + (t > 0.12 ? Math.sin(2 * Math.PI * 1760 * (t - 0.12)) * env(t - 0.12, 0.003, 0.3) : 0); }
  write('notify.wav', d, 0.35);
}
// a whoosh for transitions
{
  const d = make(0.9);
  let lp = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / SR, u = t / 0.9, cut = 300 + 5000 * Math.sin(Math.PI * u) ** 2, a = 1 - Math.exp(-2 * Math.PI * cut / SR);
    lp += a * (noise() - lp); d[i] = lp * Math.sin(Math.PI * u) ** 1.5;
  }
  write('whoosh.wav', d, 0.4);
}
// a low, warm hit for the logo
{
  const d = make(3.2);
  for (let i = 0; i < d.length; i++) {
    const t = i / SR;
    d[i] = Math.sin(2 * Math.PI * (52 + 20 * Math.exp(-t * 8)) * t) * env(t, 0.004, 0.9) * 0.9
      + [523.25, 659.25, 783.99, 1046.5].reduce((s, f, j) => s + Math.sin(2 * Math.PI * f * t + j) * env(t, 0.02 + j * 0.02, 1.1) * 0.12, 0)
      + noise() * env(t, 0.001, 0.02) * 0.3;
  }
  lowpass(d, 6000);
  write('hit.wav', d, 0.75);
}
// the music bed: slow, warm chords that start when the history interrupts and run to the end (52 s)
{
  const dur = 52, d = make(dur);
  const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
  // Cmaj9, Am9, Fmaj9, Gsus2 then G, voiced around middle C
  const chords = [[48, 55, 59, 62, 64], [45, 52, 55, 59, 60], [41, 48, 52, 55, 57], [43, 50, 55, 57, 62], [43, 50, 55, 59, 62]];
  const len = 6.5;
  for (let c = 0; c * len < dur; c++) {
    const notes = chords[c % chords.length], t0 = c * len, t1 = Math.min(dur, t0 + len + 2.5);
    for (let i = Math.round(t0 * SR); i < Math.round(t1 * SR); i++) {
      const t = i / SR - t0, e = Math.min(1, t / 1.6) * (t > len ? Math.max(0, 1 - (t - len) / 2.5) : 1);
      let s = 0;
      notes.forEach((m, j) => {
        const f = mtof(m);
        s += (Math.sin(2 * Math.PI * f * t * 1.0015) + Math.sin(2 * Math.PI * f * t * 0.9985) + 0.3 * Math.sin(2 * Math.PI * f * 2 * t)) * (j === 0 ? 0.9 : 0.55);
      });
      s += Math.sin(2 * Math.PI * mtof(notes[0] - 12) * t) * 0.8;
      d[i] += s * e * (0.85 + 0.15 * Math.sin(2 * Math.PI * 0.2 * (i / SR)));
    }
  }
  lowpass(d, 2200);
  for (let i = 0; i < d.length; i++) { const t = i / SR; d[i] *= Math.min(1, t / 3) * Math.min(1, (dur - t) / 2.5); }
  write('pad.wav', d, 0.5);
}
console.log('audio written to public/sfx');
