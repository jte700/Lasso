import React from 'react';
import { AbsoluteFill, interpolate, random, useCurrentFrame } from 'remotion';
import { C, SERIF, SANS, MONO, SCRIPT, TYPE, BEAT, BAR, Caption, Liquid, Caret, Key, smear, ramp, life, lerp, clamp, typing, count, EASE, ENTER, EXIT, S, Q, SHADOW, SHADOW_SM } from '../kit';
import type { Cue } from '../cues';

/* ───────────── A · opening line (bars 0–2.5) ───────────── */
export const INTRO = BAR * 2.5;
export const Intro: React.FC = () => {
  const f = useCurrentFrame();
  const caret = 1 - ramp(f, 36, Q);
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', transform: `scale(${interpolate(f, [0, INTRO], [1, 1.035])})` }}>
      {caret > 0.01 && <div style={{ position: 'absolute', fontFamily: SERIF, fontSize: 110, opacity: caret }}><Caret blink /></div>}
      <Liquid amt={smear(f, 44, 1, 26)} seed={7}>
        <Caption text="For 150 years," start={44} step={12} size={112} out={INTRO - 30} />
      </Liquid>
      <div style={{ height: 26 }} />
      <Caption text="we kept making it faster / to put words onto a page." start={150} step={7} size={60} color={C.ink2} out={INTRO - 26} />
    </AbsoluteFill>
  );
};

/* ───────────── B · five eras of writing (bars 2.5–10) ───────────── */
// each era is shorter than the last: the cuts accelerate with the music
const ERAS = [0, BAR * 2, BAR * 3.5, BAR * 5, BAR * 6.25, BAR * 7.5];
export const ERAS_LEN = ERAS[5];
const LABELS = ['Handwriting.', 'The typewriter.', 'The word processor.', 'Autocomplete.', 'IntelliSense.'];

const Pointer: React.FC<{ x: number; y: number; beam?: boolean; press?: number }> = ({ x, y, beam, press = 0 }) => (
  <svg viewBox={beam ? '0 0 16 32' : '0 0 22 28'} style={{ position: 'absolute', left: x, top: y, width: beam ? 22 : 34, height: beam ? 44 : 44, transform: `scale(${1 - press * 0.12})`, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.25))', zIndex: 5, overflow: 'visible' }}>
    {beam
      ? <path d="M3 2h4.5l.5.6.5-.6H13M8 2.6v26.8M3 30h4.5l.5-.6.5.6H13" fill="none" stroke="#111" strokeWidth="2.4" strokeLinecap="round" />
      : <path d="M2 2v21l5.6-5.3 4 8.6 3.6-1.6-4-8.4H19z" fill="#111" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />}
  </svg>
);
const keyDown = (f: number, at: number) => (f >= at - 2 && f < at + 7 ? Math.sin(Math.min(1, (f - at + 2) / 9) * Math.PI) : 0);
const KeyRow: React.FC<{ f: number; at: number; keys: string[]; tint?: boolean }> = ({ f, at, keys, tint }) => {
  const v = life(f, at - 18, at + 26, S, Q);
  if (v < 0.01) return null;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 690, display: 'flex', justifyContent: 'center', gap: 16, opacity: v, transform: `translateY(${((1 - v) * 18).toFixed(2)}px)` }}>
      {keys.map((k) => <Key key={k} label={k} down={keyDown(f, at)} size={88} wide={k.length > 2 ? 1.7 : 1} tint={tint} />)}
    </div>
  );
};

/* I · handwriting: a fountain pen writes the greeting */
const HW_TEXT = 'Dear John,';
const hwP = (t: number) => {
  const u = ramp(t, 28, 230, EASE);
  return Math.min(1, u + 0.008 * Math.sin(t * 0.5) * (u > 0 && u < 1 ? 1 : 0));
};
const Pen: React.FC<{ lift: number }> = ({ lift }) => (
  <div style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0 }}>
    {/* soft contact shadow on the page */}
    <div style={{ position: 'absolute', left: 30 + lift * 40, top: 30 + lift * 50, width: 360, height: 30, borderRadius: '50%', background: 'rgba(20,32,26,.10)', filter: 'blur(14px)', transform: 'rotate(-40deg)', transformOrigin: '0 50%', opacity: 1 - lift * 0.7 }} />
    <svg width="560" height="60" viewBox="0 0 560 60" style={{ position: 'absolute', left: 0, top: -30, transformOrigin: '0 30px', transform: `translate(${lift * 60}px, ${-lift * 90}px) rotate(-46deg)`, overflow: 'visible' }}>
      <defs>
        <linearGradient id="barrel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3a4f7a" /><stop offset=".35" stopColor="#1c2a48" /><stop offset="1" stopColor="#0d1526" /></linearGradient>
        <linearGradient id="nib" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f3dc9b" /><stop offset=".5" stopColor="#c99a3e" /><stop offset="1" stopColor="#8a6420" /></linearGradient>
      </defs>
      <path d="M0 30L58 16Q66 30 58 44Z" fill="url(#nib)" />
      <path d="M4 30L50 30" stroke="#6b4c16" strokeWidth="1.4" />
      <rect x="56" y="14" width="70" height="32" rx="8" fill="#121212" />
      <rect x="122" y="9" width="420" height="42" rx="20" fill="url(#barrel)" />
      <rect x="134" y="14" width="396" height="6" rx="3" fill="rgba(255,255,255,.28)" />
      <rect x="250" y="8" width="14" height="44" rx="3" fill="url(#nib)" />
    </svg>
  </div>
);
const Handwriting: React.FC<{ t: number }> = ({ t }) => {
  const p = hwP(t), lift = ramp(t, 238, 50, EXIT);
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 300, textAlign: 'center' }}>
      <span style={{ position: 'relative', display: 'inline-block', fontFamily: SCRIPT, fontSize: 210, lineHeight: 1.2, color: '#1b2a52', padding: '0 30px' }}>
        <span style={{ clipPath: `inset(-30% ${((1 - p) * 100).toFixed(2)}% -30% -10%)`, display: 'inline-block' }}>{HW_TEXT}</span>
        <span style={{ position: 'absolute', left: `calc(30px + ${(p * 100).toFixed(2)}% - ${(p * 60).toFixed(1)}px)`, top: 150 + Math.sin(t * 0.42) * 26 + Math.sin(t * 0.17) * 10, width: 0, height: 0, opacity: 1 - ramp(t, 270, 30) }}>
          <Pen lift={lift} />
        </span>
      </span>
    </div>
  );
};

/* II · typewriter: each letter is struck, and the key shows it */
const TW_TEXT = 'Dear John, the numbers are in.';
const tw = typing(TW_TEXT, 18, 5.2, 'tw');
const TW_FS = 78, TW_CW = TW_FS * 0.6;
const Typewriter: React.FC<{ t: number }> = ({ t }) => {
  const n = count(tw, t);
  const last = n ? tw[n - 1] : -99, kick = Math.max(0, 1 - (t - last) / 6);
  const width = TW_TEXT.length * TW_CW;
  return (
    <>
      <div style={{ position: 'absolute', left: 960 - width / 2, top: 360, fontFamily: TYPE, fontSize: TW_FS, color: '#22201c', whiteSpace: 'pre', transform: `translateY(${(kick * 1.5).toFixed(2)}px)` }}>
        {TW_TEXT.slice(0, n).split('').map((ch, i) => {
          const s = Math.max(0, 1 - (t - tw[i]) / 5);
          return <span key={i} style={{ display: 'inline-block', width: TW_CW, textAlign: 'center', opacity: 0.8 + random(`o${i}`) * 0.2, transform: `translateY(${((random(`y${i}`) - 0.5) * 3).toFixed(2)}px) scale(${(1 + s * 0.3).toFixed(3)})` }}>{ch}</span>;
        })}
        {n < TW_TEXT.length && <span style={{ position: 'absolute', left: n * TW_CW, top: '0.95em', width: TW_CW, height: 4, borderRadius: 2, background: C.ink3 }} />}
      </div>
      {/* the struck key */}
      <div style={{ position: 'absolute', left: 960 - 70, top: 640, width: 140, height: 140 }}>
        <div style={{ position: 'absolute', inset: 0, top: 10, borderRadius: 70, background: '#2a2a2a' }} />
        <div style={{ position: 'absolute', inset: 0, borderRadius: 70, transform: `translateY(${(kick * 8).toFixed(2)}px)`, background: 'radial-gradient(circle at 50% 35%, #fbfaf6, #e4e0d6 70%)', boxShadow: '0 0 0 7px #cfd2d6, 0 0 0 9px #8e9298, 0 8px 18px rgba(0,0,0,.25)', display: 'grid', placeItems: 'center', fontFamily: TYPE, fontSize: 64, color: '#22201c' }}>
          {(TW_TEXT[Math.max(0, n - 1)] ?? '').trim() || '␣'}
        </div>
      </div>
    </>
  );
};

/* III · word processor: type, select, cut, click, paste */
const WP_TYPED = 'Dear John, the numbers final are in.';
const wpT = typing(WP_TYPED, 8, 1.35, 'wp');
const WP_END = wpT[wpT.length - 1];
const SEL = WP_END + 14, CUT = SEL + 26, CLICK = CUT + 22, PASTE = CLICK + 20;
const WordProcessor: React.FC<{ t: number }> = ({ t }) => {
  const shown = WP_TYPED.slice(0, count(wpT, t));
  const sel = ramp(t, SEL - 12, 12);
  const box: React.CSSProperties = { display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', whiteSpace: 'pre' };
  let line: React.ReactNode;
  if (t < SEL - 14) line = <>{shown}<Caret /></>;
  else if (t < CUT) line = (
    <>Dear John, the numbers<span style={{ position: 'relative', backgroundImage: 'linear-gradient(#cddcfd,#cddcfd)', backgroundRepeat: 'no-repeat', backgroundSize: `${(sel * 100).toFixed(1)}% 100%`, borderRadius: 4 }}> final<span style={{ position: 'absolute', left: `${(sel * 100).toFixed(1)}%`, top: 8 }}><Pointer x={lerp(260, -6, ramp(t, SEL - 40, 26))} y={lerp(200, 6, ramp(t, SEL - 40, 26))} beam /></span></span> are in.</>
  );
  else if (t < PASTE) {
    const k = ramp(t, CUT, 16, EASE), move = ramp(t, CUT + 4, CLICK - CUT - 4, EASE);
    line = (
      <>Dear John, the <span style={{ position: 'relative' }}>{t >= CLICK && <Caret />}<Pointer x={lerp(330, -10, move)} y={6} beam /></span>numbers<span style={{ ...box, maxWidth: `${((1 - k) * 2.4).toFixed(3)}em`, opacity: 1 - k }}> final</span> are in.</>
    );
  } else {
    const k = ramp(t, PASTE, 16, ENTER), glow = 1 - ramp(t, PASTE + 10, 40);
    line = (
      <>Dear John, the <span style={{ ...box, maxWidth: `${(k * 2.4).toFixed(3)}em`, background: `rgba(41,204,87,${(0.2 * glow).toFixed(3)})`, borderRadius: 6 }}>final </span><Caret />numbers are in.</>
    );
  }
  return (
    <>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 380, textAlign: 'center', fontFamily: SERIF, fontWeight: 500, fontSize: 84, letterSpacing: '-0.015em', lineHeight: 1.25, color: C.ink, whiteSpace: 'pre' }}>{line}</div>
      <KeyRow f={t} at={CUT} keys={['⌘', 'X']} />
      <KeyRow f={t} at={PASTE} keys={['⌘', 'V']} />
    </>
  );
};

/* IV · autocomplete: the ghost finishes the name, Tab accepts it */
const ac = typing('Dear Joh', 10, 3.6, 'ac');
const AC1 = ac[ac.length - 1] + 8, TAB1 = AC1 + 30, AC2 = TAB1 + 14, TAB2 = AC2 + 34;
const Autocomplete: React.FC<{ t: number }> = ({ t }) => {
  const n = count(ac, t);
  const ghost = { color: 'rgba(20,32,26,.26)' };
  const flash = (at: number) => ({ background: `rgba(41,204,87,${(0.2 * (1 - ramp(t, at, 30))).toFixed(3)})`, borderRadius: 8 });
  return (
    <>
      <div style={{ position: 'absolute', left: 330, top: 380, fontFamily: SANS, fontWeight: 500, fontSize: 84, letterSpacing: '-0.02em', color: C.ink, whiteSpace: 'pre' }}>
        {'Dear Joh'.slice(0, n)}
        {t >= TAB1 ? <span style={flash(TAB1)}>n,</span> : null}
        {t < TAB1 && n === 8 ? <><Caret /><span style={{ ...ghost, opacity: ramp(t, AC1, Q) }}>n,</span></> : null}
        {t >= TAB1 && t < TAB2 ? <><Caret /><span style={{ ...ghost, opacity: ramp(t, AC2, Q) }}> the numbers are in.</span></> : null}
        {t >= TAB2 ? <><span style={flash(TAB2)}> the numbers are in.</span><Caret /></> : null}
        {n < 8 ? <Caret /> : null}
      </div>
      <KeyRow f={t} at={TAB1} keys={['tab']} tint />
      <KeyRow f={t} at={TAB2} keys={['tab']} tint />
    </>
  );
};

/* V · IntelliSense: the editor offers the method; Tab writes it */
const K = { kw: '#c2255c', fn: '#3b6cf6', str: '#1f9d55', id: C.ink, p: 'rgba(20,32,26,.42)' };
const CODE: [string, string][] = [['const ', K.kw], ['spend', K.id], [' = ', K.p], ['budget', K.id], ['.', K.p], ['byQuarter', K.fn], ['(', K.p], ['"Q4"', K.str], [')', K.p]];
const is1 = typing('const spend = budget.', 8, 1.9, 'is');
const IS_POP = is1[is1.length - 1] + 6, IS_DOWN = IS_POP + 22, IS_TAB = IS_DOWN + 24;
const is2 = typing('"Q4")', IS_TAB + 10, 3, 'is2');
const ITEMS: [string, string][] = [['total', '()'], ['byQuarter', '(q)'], ['forecast', '(months)'], ['lineItems', '()']];
const IntelliSense: React.FC<{ t: number }> = ({ t }) => {
  let n = count(is1, t);
  if (t >= IS_TAB) n = 'const spend = budget.byQuarter('.length + count(is2, t);
  let left = n;
  const pop = life(t, IS_POP, IS_TAB + 4, Q + 4, 8), hi = t >= IS_DOWN ? 1 : 0;
  return (
    <div style={{ position: 'absolute', left: 380, top: 390, fontFamily: MONO, fontSize: 60, whiteSpace: 'pre', color: K.id }}>
      {CODE.map(([s, c], i) => { const v = s.slice(0, Math.max(0, left)); left -= s.length; return v ? <span key={i} style={{ color: c }}>{v}</span> : null; })}
      <span style={{ position: 'relative' }}>
        <Caret />
        {t >= IS_TAB && n < 36 ? <span style={{ color: K.p }}>)</span> : null}
        {pop > 0.01 && (
          <div style={{ position: 'absolute', left: -10, top: 92, display: 'flex', gap: 16, opacity: pop, transform: `translateY(${((1 - pop) * -12).toFixed(2)}px)`, fontSize: 30 }}>
            <div style={{ width: 430, background: C.paper, borderRadius: 18, boxShadow: SHADOW, padding: 10 }}>
              {ITEMS.map(([name, sig], i) => (
                <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 14, height: 56, padding: '0 14px', borderRadius: 11, background: i === hi ? 'rgba(102,136,238,.13)' : undefined }}>
                  <span style={{ width: 30, height: 30, borderRadius: 8, background: '#eef2ff', color: K.fn, display: 'grid', placeItems: 'center', fontSize: 18, fontFamily: SANS, fontWeight: 700 }}>ƒ</span>
                  <span>{name}</span><span style={{ color: C.ink3, fontSize: 24 }}>{sig}</span>
                </div>
              ))}
            </div>
            {hi === 1 && (
              <div style={{ width: 360, alignSelf: 'flex-start', marginTop: 66, background: C.paper, borderRadius: 16, boxShadow: SHADOW_SM, padding: '16px 20px', fontSize: 22, whiteSpace: 'normal', opacity: ramp(t, IS_DOWN, Q) }}>
                <div><span style={{ color: K.fn }}>byQuarter</span>(q: Quarter)</div>
                <div style={{ fontFamily: SANS, color: C.ink2, marginTop: 6 }}>Total spend for one fiscal quarter.</div>
              </div>
            )}
          </div>
        )}
      </span>
    </div>
  );
};

const ERA_VIEWS = [Handwriting, Typewriter, WordProcessor, Autocomplete, IntelliSense];
export const Eras: React.FC = () => {
  const f = useCurrentFrame();
  let e = 0; while (e < 4 && f >= ERAS[e + 1]) e++;
  const t = f - ERAS[e], dur = ERAS[e + 1] - ERAS[e];
  const View = ERA_VIEWS[e];
  // the smear hands one era to the next, on the beat (the last era hard-cuts into silence)
  const amt = Math.max(e > 0 ? smear(f, ERAS[e], 1, 18) : 0, e < 4 ? smear(f, ERAS[e + 1], 9, 1) : 0);
  const push = interpolate(t, [0, dur], [1, 1.04], clamp);
  return (
    <AbsoluteFill>
      <Liquid amt={amt} seed={e * 5 + 2} dir={e % 2 ? -1 : 1} style={{ position: 'absolute', inset: 0, transform: `scale(${push.toFixed(4)})` }}>
        <View t={t} />
      </Liquid>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 860 }}>
        <Caption key={e} text={LABELS[e]} start={ERAS[e] + 10} step={7} size={40} font={SANS} weight={500} color={C.ink2} out={e < 4 ? ERAS[e + 1] - 12 : undefined} />
      </div>
      {/* progress: five dots, the current one stretches into a pill */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 958, display: 'flex', justifyContent: 'center', gap: 12 }}>
        {[0, 1, 2, 3, 4].map((i) => {
          const on = i === e ? ramp(t, 0, S) : i === e - 1 ? 1 - ramp(t, 0, S) : 0;
          return <span key={i} style={{ width: 10 + on * 26, height: 10, borderRadius: 5, background: i <= e ? (i === e ? C.green : C.ink3) : C.line }} />;
        })}
      </div>
    </AbsoluteFill>
  );
};
export const eraCues: Cue[] = [
  ...tw.map((f) => ({ f: ERAS[1] + f, s: 'clack', v: 0.32 })),
  { f: ERAS[1] + tw[tw.length - 1] + 14, s: 'ding', v: 0.18 },
  ...wpT.filter((_, i) => i % 2 === 0).map((f) => ({ f: ERAS[2] + f, s: 'key', v: 0.25 })),
  { f: ERAS[2] + CUT, s: 'tab', v: 0.32 }, { f: ERAS[2] + CLICK, s: 'key', v: 0.25 }, { f: ERAS[2] + PASTE, s: 'tab', v: 0.32 },
  ...ac.map((f) => ({ f: ERAS[3] + f, s: 'key', v: 0.25 })), { f: ERAS[3] + TAB1, s: 'tab', v: 0.35 }, { f: ERAS[3] + TAB2, s: 'tab', v: 0.35 },
  ...is1.filter((_, i) => i % 2 === 0).map((f) => ({ f: ERAS[4] + f, s: 'key', v: 0.25 })), { f: ERAS[4] + IS_TAB, s: 'tab', v: 0.35 },
];
