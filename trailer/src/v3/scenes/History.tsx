import React from 'react';
import { AbsoluteFill, interpolate, random, useCurrentFrame } from 'remotion';
import { C, SANS, MONO, TYPE, BAR, Words, Caret, KeyCombo, sp, ramp, lerp, clamp, typing, count, EXIT, SHADOW } from '../kit';
import { Ink, boilAt } from '../sketch';
import { write, writtenAt, HandSvg } from '../hand';
import type { Cue } from '../../v2/cues';

/* ───────────── B · five eras (bars 2.5–10) ─────────────
   One surface carries the words through history: a sheet of paper, the typewriter's page, a monitor, a phone,
   a laptop. It morphs from one to the next on the beat while each device springs in around it.
   Only the handwriting itself is hand-drawn; everything else is a clean illustration. */
const ERAS = [0, BAR * 2, BAR * 3.5, BAR * 5, BAR * 6.25, BAR * 7.5];
export const ERAS_LEN = ERAS[5];
const LABELS = ['By hand.', 'By typewriter.', 'By word processor.', 'By autocomplete.', 'By IntelliSense.'];

type Rect = { x: number; y: number; w: number; h: number; r: number; rot: number };
const RECTS: Rect[] = [
  { x: 330, y: 250, w: 1260, h: 560, r: 8, rot: -1.2 },  // paper on the desk
  { x: 700, y: 110, w: 520, h: 354, r: 4, rot: 0 },      // paper in the typewriter
  { x: 680, y: 160, w: 560, h: 400, r: 14, rot: 0 },     // monitor
  { x: 804, y: 104, w: 312, h: 676, r: 46, rot: 0 },     // phone
  { x: 604, y: 168, w: 712, h: 446, r: 8, rot: 0 },      // laptop
];
const SHEET_OFF: Rect = { ...RECTS[0], y: 1160, rot: 4 };
const lerpRect = (a: Rect, b: Rect, u: number): Rect => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), w: lerp(a.w, b.w, u), h: lerp(a.h, b.h, u), r: lerp(a.r, b.r, u), rot: lerp(a.rot, b.rot, u) });
const Surface: React.FC<{ rect: Rect; opacity?: number; children?: React.ReactNode }> = ({ rect, opacity = 1, children }) => (
  <div style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h, borderRadius: rect.r, transform: `rotate(${rect.rot.toFixed(2)}deg)`, background: C.white, boxShadow: '0 1px 2px rgba(20,24,20,.06), 0 18px 50px rgba(20,24,20,.10)', overflow: 'hidden', opacity }}>{children}</div>
);

/* ───────────── A · the opening line (bars 0–2.5) ───────────── */
export const INTRO = BAR * 2.5;
export const Intro: React.FC = () => {
  const f = useCurrentFrame();
  const paper = sp(f, INTRO - 70, 22, 90);
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 360, transform: `scale(${interpolate(f, [0, INTRO], [1, 1.04], clamp)})` }}>
        <Words text="For 150 years," start={36} step={11} size={104} out={INTRO - 80} />
        <div style={{ height: 18 }} />
        <Words text="we kept making it faster / to put words onto a page." start={120} step={6} size={50} weight={500} color={C.ink2} out={INTRO - 74} lh={1.3} />
      </div>
      {/* the sheet of paper the first era writes on rises into place */}
      <Surface rect={lerpRect(SHEET_OFF, RECTS[0], paper)} opacity={Math.min(1, paper * 1.4)} />
    </AbsoluteFill>
  );
};

/* device chrome: springs up into place when its era starts, sinks away when it ends */
const chromeOf = (f: number, mine: number) => {
  const a = sp(f, ERAS[mine] - 6, 18, 120), z = mine < 4 ? ramp(f, ERAS[mine + 1] - 18, 18, EXIT) : 0;
  return { o: Math.min(1, a * 1.5) * (1 - z), y: (1 - a) * 120 + z * 90, show: a > 0.001 && z < 0.999 };
};
const Typewriter: React.FC<{ o: number; y: number; hit: number; kick: number }> = ({ o, y, hit, kick }) => {
  const rows: [number, number, number][] = [[626, 10, 642], [694, 9, 678], [762, 8, 714]];
  let idx = 0;
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: o, transform: `translateY(${y.toFixed(1)}px)` }}>
      <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <linearGradient id="twBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#d8e9de" /><stop offset=".55" stopColor="#bcd6c5" /><stop offset="1" stopColor="#9fbfab" /></linearGradient>
          <linearGradient id="twRoll" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4a4e50" /><stop offset=".35" stopColor="#25282a" /><stop offset="1" stopColor="#0d0e0f" /></linearGradient>
          <radialGradient id="twKnob" cx=".4" cy=".35" r=".7"><stop offset="0" stopColor="#ffffff" /><stop offset=".5" stopColor="#c9ccd0" /><stop offset="1" stopColor="#7d8288" /></radialGradient>
        </defs>
        <ellipse cx="960" cy="900" rx="560" ry="26" fill="rgba(20,30,24,.14)" style={{ filter: 'blur(10px)' }} />
        <path d="M560 520H1360L1446 864Q1452 888 1426 888H494Q468 888 474 864Z" fill="url(#twBody)" />
        <path d="M566 524H1354" stroke="rgba(255,255,255,.7)" strokeWidth="3" />
        <rect x="600" y="462" width="720" height="58" rx="29" fill="url(#twRoll)" />
        <rect x="616" y="470" width="688" height="6" rx="3" fill="rgba(255,255,255,.18)" />
        <circle cx="580" cy="491" r="34" fill="url(#twKnob)" /><circle cx="1340" cy="491" r="34" fill="url(#twKnob)" />
        {rows.map(([cy, n, x0]) => Array.from({ length: n }, (_, i) => {
          const me = idx++, down = me === hit ? kick : 0;
          return (
            <g key={me} transform={`translate(${x0 + i * 72} ${cy + down * 5})`}>
              <circle r="26" fill="#2b302d" /><circle r="22" fill={down > 0.3 ? '#e2f6ea' : '#fbfbf8'} /><circle r="22" fill="none" stroke="#c9ccc6" strokeWidth="2" />
            </g>
          );
        }))}
        <rect x="770" y="806" width="380" height="34" rx="17" fill="#fbfbf8" stroke="#2b302d" strokeWidth="5" />
      </svg>
    </div>
  );
};
const Monitor: React.FC<{ o: number; y: number }> = ({ o, y }) => (
  <div style={{ position: 'absolute', inset: 0, opacity: o, transform: `translateY(${y.toFixed(1)}px)` }}>
    <div style={{ position: 'absolute', left: 640, top: 120, width: 640, height: 560, borderRadius: 38, background: 'linear-gradient(180deg, #f6f3ec, #e3ddd0)', boxShadow: SHADOW }}>
      <div style={{ position: 'absolute', left: 30, top: 30, width: 580, height: 420, borderRadius: 22, background: '#23262a' }} />
      <div style={{ position: 'absolute', left: 260, top: 492, width: 120, height: 8, borderRadius: 4, background: 'rgba(0,0,0,.18)' }} />
      <div style={{ position: 'absolute', left: 60, top: 490, width: 12, height: 12, borderRadius: 6, background: C.green }} />
    </div>
    <div style={{ position: 'absolute', left: 900, top: 680, width: 120, height: 60, background: 'linear-gradient(180deg, #dcd6c9, #cdc6b7)', clipPath: 'polygon(12% 0, 88% 0, 100% 100%, 0 100%)' }} />
    <div style={{ position: 'absolute', left: 810, top: 736, width: 300, height: 22, borderRadius: 11, background: 'linear-gradient(180deg, #e8e3d8, #cfc8b9)', boxShadow: '0 10px 20px rgba(0,0,0,.12)' }} />
    <div style={{ position: 'absolute', left: 600, top: 790, width: 720, height: 96, borderRadius: 18, background: 'linear-gradient(180deg, #f7f4ee, #e6e0d4)', boxShadow: SHADOW, padding: '14px 18px', display: 'grid', gridTemplateColumns: 'repeat(16, 1fr)', gap: 6 }}>
      {Array.from({ length: 48 }, (_, i) => <div key={i} style={{ height: 18, borderRadius: 4, background: '#fff', boxShadow: '0 1.5px 0 rgba(0,0,0,.12)' }} />)}
    </div>
  </div>
);
const Phone: React.FC<{ o: number; y: number }> = ({ o, y }) => (
  <div style={{ position: 'absolute', left: 788, top: 88 + y, width: 344, height: 708, borderRadius: 60, background: '#16171a', boxShadow: `inset 0 0 0 3px #4b4e53, ${SHADOW}`, opacity: o }} />
);
const PhoneIsland: React.FC<{ o: number; y: number }> = ({ o, y }) => (
  <div style={{ position: 'absolute', left: 912, top: 120 + y, width: 96, height: 28, borderRadius: 14, background: '#0b0b0c', opacity: o }} />
);
const Laptop: React.FC<{ o: number; y: number }> = ({ o, y }) => (
  <div style={{ position: 'absolute', inset: 0, opacity: o, transform: `translateY(${y.toFixed(1)}px)` }}>
    <div style={{ position: 'absolute', left: 584, top: 148, width: 752, height: 486, borderRadius: 26, background: '#17181b', boxShadow: `inset 0 0 0 2px #3b3d42, ${SHADOW}` }} />
    <div style={{ position: 'absolute', left: 500, top: 632, width: 920, height: 34, borderRadius: '6px 6px 30px 30px', background: 'linear-gradient(180deg, #e9eaec, #c3c5c9)', boxShadow: '0 16px 30px rgba(0,0,0,.18)' }}>
      <div style={{ position: 'absolute', left: 400, top: 0, width: 120, height: 10, borderRadius: '0 0 10px 10px', background: '#b3b6bb' }} />
    </div>
  </div>
);

/* timing for each era's content (frames from the era's start) */
const HW = write('Dear John,', 470, 610, 200, 7);
const HW_A = 30, HW_B = 262;
const TW1 = 'Dear John,', TW2 = 'the numbers are in.';
const tw1 = typing(TW1, 28, 3.3, 'tw1'), tw2 = typing(TW2, tw1[tw1.length - 1] + 20, 3.1, 'tw2');
const wpT = typing('the numbers final are in.', 30, 1.5, 'wp');
const W_SEL = wpT[wpT.length - 1] + 14, W_CUT = W_SEL + 26, W_CLICK = W_CUT + 22, W_PASTE = W_CLICK + 22;
const ac = typing('Dear Joh', 24, 3.4, 'ac');
const TAP = ac[ac.length - 1] + 30, TAP2 = TAP + 44;
const is1 = typing('const spend = budget.', 24, 1.8, 'is');
const IS_POP = is1[is1.length - 1] + 6, IS_DOWN = IS_POP + 20, IS_TAB = IS_DOWN + 24;
const is2 = typing('"Q4")', IS_TAB + 10, 3, 'is2');
const CODE: [string, string][] = [['const ', '#c2255c'], ['spend', C.ink], [' = ', C.ink3], ['budget', C.ink], ['.', C.ink3], ['byQuarter', '#3b6cf6'], ['(', C.ink3], ['"Q4"', C.greenD], [')', C.ink3]];

export const Eras: React.FC = () => {
  const f = useCurrentFrame();
  let e = 0; while (e < 4 && f >= ERAS[e + 1]) e++;
  const t = f - ERAS[e];
  // the surface morphs to the next device across each boundary
  let rect = RECTS[e];
  if (e < 4 && f > ERAS[e + 1] - 16) rect = lerpRect(RECTS[e], RECTS[e + 1], sp(f, ERAS[e + 1] - 16, 20, 110));
  if (e > 0 && f < ERAS[e] + 40) rect = lerpRect(RECTS[e - 1], RECTS[e], sp(f, ERAS[e] - 16, 20, 110));
  const content = (i: number) => (i === e ? ramp(t, 4, 14) * (i < 4 ? 1 - ramp(f, ERAS[i + 1] - 14, 10, EXIT) : 1) : 0);
  const blurOf = (v: number) => (v < 0.99 ? `blur(${((1 - v) * 10).toFixed(1)}px)` : undefined);
  const drift = interpolate(f, [0, ERAS_LEN], [1, 1.05], clamp);
  const hw = writtenAt(HW, interpolate(f, [HW_A, HW_B], [0, HW.total], { ...clamp, easing: (x) => x * 0.88 + (0.12 * (1 - Math.cos(x * Math.PI))) / 2 }), boilAt(f));
  const handIn = sp(f, 4, 18, 90), handOut = ramp(f, HW_B + 6, 44, EXIT);
  const n1 = count(tw1, t), n2 = count(tw2, t), last = [...tw1, ...tw2].filter((x) => x <= t).pop() ?? -99, kick = e === 1 ? Math.max(0, 1 - (t - last) / 6) : 0;
  const hit = Math.floor(random(`k${n1 + n2}`) * 27);
  const ch = [0, 1, 2, 3, 4].map((i) => chromeOf(f, i));
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <AbsoluteFill style={{ transform: `scale(${drift.toFixed(4)})` }}>
        {ch[1].show && <Typewriter o={ch[1].o} y={ch[1].y} hit={hit} kick={kick} />}
        {ch[2].show && <Monitor o={ch[2].o} y={ch[2].y} />}
        {ch[3].show && <Phone o={ch[3].o} y={ch[3].y} />}
        {ch[4].show && <Laptop o={ch[4].o} y={ch[4].y} />}
        <Surface rect={rect}>
          {content(0) > 0.01 && <div style={{ position: 'absolute', left: -rect.x, top: -rect.y, width: 1920, height: 1080, opacity: content(0), filter: blurOf(content(0)) }}><Ink strokes={hw.ink} color={C.pen} /></div>}
          {content(1) > 0.01 && (
            <div style={{ position: 'absolute', left: 44, top: 70, fontFamily: TYPE, fontSize: 40, lineHeight: '60px', color: '#23211d', whiteSpace: 'pre', opacity: content(1), filter: blurOf(content(1)), transform: `translateY(${(kick * 1.2).toFixed(2)}px)` }}>
              <div>{TW1.slice(0, n1)}{n1 < TW1.length && <Caret />}</div>
              <div>{TW2.slice(0, n2)}{n1 === TW1.length && n2 < TW2.length && <Caret />}</div>
            </div>
          )}
          {content(2) > 0.01 && <WordProc t={t} o={content(2)} />}
          {content(3) > 0.01 && <PhoneUI t={t} o={content(3)} />}
          {content(4) > 0.01 && <Code t={t} o={content(4)} />}
        </Surface>
        {ch[3].show && <PhoneIsland o={ch[3].o} y={ch[3].y} />}
        {e === 0 && <HandSvg x={hw.tip[0] + (1 - handIn) * 380 + handOut * 460} y={hw.tip[1] + (1 - handIn) * 320 + handOut * 360 - (hw.down ? 0 : 8)} rot={-3 + Math.sin(f * 0.045) * 2 + (hw.down ? Math.sin(f * 0.9) * 0.5 : 0)} scale={1.5} p={Math.min(1, handIn * 1.4)} />}
      </AbsoluteFill>
      {e === 2 && <KeyRowAt t={t} at={W_CUT} keys={[{ glyph: '⌘', label: 'command', w: 170 }, { big: 'X', w: 120 }]} />}
      {e === 2 && <KeyRowAt t={t} at={W_PASTE} keys={[{ glyph: '⌘', label: 'command', w: 170 }, { big: 'V', w: 120 }]} />}
      {e === 4 && <KeyRowAt t={t} at={IS_TAB} keys={[{ glyph: '⇥', label: 'tab', w: 210 }]} y={700} />}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 960 }}>
        <Words key={e} text={LABELS[e]} start={ERAS[e] + 8} step={6} size={32} weight={500} color={C.ink2} out={e < 4 ? ERAS[e + 1] - 14 : undefined} />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 1018, display: 'flex', justifyContent: 'center', gap: 10 }}>
        {[0, 1, 2, 3, 4].map((i) => { const on = i === e ? sp(t, 0, 18, 140) : i === e - 1 ? 1 - sp(t, 0, 18, 140) : 0; return <span key={i} style={{ width: 8 + on * 22, height: 8, borderRadius: 4, background: i === e ? C.green : i < e ? C.ink3 : C.line }} />; })}
      </div>
    </AbsoluteFill>
  );
};

/** a light key row beside the device; KeyCombo reads the scene clock, so local era times are converted */
const KeyRowAt: React.FC<{ t: number; at: number; keys: { glyph?: string; label?: string; big?: string; w?: number }[]; y?: number }> = ({ t, at, keys, y = 300 }) => {
  const f = useCurrentFrame();
  if (t < at - 30 || t > at + 64) return null;
  const off = f - t;
  return (
    <div style={{ position: 'absolute', left: 1370, top: y }}>
      <KeyCombo keys={keys} at={off + at - 26} press={off + at} out={off + at + 60} h={120} tone="light" gap={14} />
    </div>
  );
};

const WordProc: React.FC<{ t: number; o: number }> = ({ t, o }) => {
  const box: React.CSSProperties = { display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', whiteSpace: 'pre' };
  const sel = ramp(t, W_SEL - 10, 10);
  let l2: React.ReactNode;
  if (t < W_SEL - 10) l2 = <>{'the numbers final are in.'.slice(0, count(wpT, t))}<Caret /></>;
  else if (t < W_CUT) l2 = <>the numbers<span style={{ backgroundImage: `linear-gradient(${C.green},${C.green})`, backgroundRepeat: 'no-repeat', backgroundSize: `${(sel * 100).toFixed(1)}% 100%`, color: sel > 0.6 ? '#fff' : undefined, borderRadius: 3 }}> final</span> are in.</>;
  else if (t < W_PASTE) { const k = sp(t, W_CUT, 22, 160); l2 = <>the {t >= W_CLICK && <Caret />}numbers<span style={{ ...box, maxWidth: `${((1 - k) * 2.6).toFixed(3)}em`, opacity: 1 - k }}> final</span> are in.</>; }
  else { const k = sp(t, W_PASTE, 20, 140); l2 = <>the <span style={{ ...box, maxWidth: `${(k * 2.6).toFixed(3)}em`, background: `rgba(41,204,87,${(0.25 * (1 - ramp(t, W_PASTE + 10, 30))).toFixed(3)})`, borderRadius: 4 }}>final </span><Caret />numbers are in.</>; }
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: o, filter: o < 0.99 ? `blur(${((1 - o) * 10).toFixed(1)}px)` : undefined }}>
      <div style={{ height: 34, background: '#f3f2ef', borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', gap: 7, padding: '0 12px' }}>{['#ff5f57', '#febc2e', '#28c840'].map((c) => <i key={c} style={{ width: 11, height: 11, borderRadius: 6, background: c }} />)}<span style={{ marginLeft: 10, fontFamily: SANS, fontSize: 14, color: C.ink3 }}>Letter.doc</span></div>
      <div style={{ padding: '34px 36px', fontFamily: SANS, fontWeight: 500, fontSize: 36, lineHeight: '54px', color: C.ink, whiteSpace: 'pre' }}><div>Dear John,</div><div>{l2}</div></div>
    </div>
  );
};
const PhoneUI: React.FC<{ t: number; o: number }> = ({ t, o }) => {
  const n = count(ac, t), first = t >= TAP, second = t >= TAP2;
  const chip = (s: string, on: boolean, at: number) => {
    const hit = at > 0 && t >= at && t < at + 20 ? 1 - ramp(t, at, 20) : 0;
    return <div style={{ flex: 1, display: 'grid', placeItems: 'center', height: 46, fontFamily: SANS, fontWeight: on ? 600 : 500, fontSize: 19, color: C.ink, borderRadius: 10, background: `rgba(41,204,87,${(hit * 0.35).toFixed(3)})`, transform: `scale(${(1 - hit * 0.06).toFixed(3)})` }}>{s}</div>;
  };
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: o, filter: o < 0.99 ? `blur(${((1 - o) * 10).toFixed(1)}px)` : undefined, fontFamily: SANS }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 70, textAlign: 'center', fontWeight: 600, fontSize: 18 }}>John</div>
      <div style={{ position: 'absolute', left: 16, right: 16, top: 360, height: 56, borderRadius: 28, border: `1.5px solid ${C.line}`, display: 'flex', alignItems: 'center', padding: '0 18px', fontSize: 21, color: C.ink, whiteSpace: 'pre' }}>
        {first ? 'Dear John, ' : 'Dear Joh'.slice(0, n)}{second ? 'the' : ''}<Caret />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 436, bottom: 0, background: '#e9e9ec' }}>
        <div style={{ display: 'flex', gap: 2, padding: '6px 8px', borderBottom: '1px solid #d6d6da' }}>
          {!first ? <>{chip('John', true, TAP)}{chip('Johnny', false, -1)}{chip('Johnson', false, -1)}</> : <>{chip('the', true, TAP2)}{chip('I', false, -1)}{chip('we', false, -1)}</>}
        </div>
        {[0, 1, 2].map((r) => (
          <div key={r} style={{ display: 'flex', gap: 5, padding: '7px 8px 0', justifyContent: 'center' }}>
            {Array.from({ length: 10 - r }, (_, i) => <div key={i} style={{ width: 24, height: 40, borderRadius: 6, background: '#fff', boxShadow: '0 1px 0 rgba(0,0,0,.25)' }} />)}
          </div>
        ))}
      </div>
    </div>
  );
};
const Code: React.FC<{ t: number; o: number }> = ({ t, o }) => {
  let n = count(is1, t); if (t >= IS_TAB) n = 'const spend = budget.byQuarter('.length + count(is2, t);
  let left = n;
  const pop = sp(t, IS_POP, 20, 150) * (1 - ramp(t, IS_TAB, 8, EXIT)), hi = t >= IS_DOWN ? 1 : 0;
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: o, filter: o < 0.99 ? `blur(${((1 - o) * 10).toFixed(1)}px)` : undefined }}>
      <div style={{ height: 32, background: '#f3f2ef', borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', gap: 7, padding: '0 12px' }}>{['#ff5f57', '#febc2e', '#28c840'].map((c) => <i key={c} style={{ width: 11, height: 11, borderRadius: 6, background: c }} />)}<span style={{ marginLeft: 10, fontFamily: SANS, fontSize: 14, color: C.ink3 }}>report.ts</span></div>
      <div style={{ position: 'absolute', left: 30, top: 120, fontFamily: MONO, fontSize: 27, whiteSpace: 'pre' }}>
        {CODE.map(([s, c], i) => { const v = s.slice(0, Math.max(0, left)); left -= s.length; return v ? <span key={i} style={{ color: c }}>{v}</span> : null; })}
        <span style={{ position: 'relative' }}>
          <Caret />
          {pop > 0.01 && (
            <div style={{ position: 'absolute', left: -6, top: 52, width: 300, opacity: Math.min(1, pop * 1.4), transformOrigin: '0 0', transform: `translateY(${((1 - pop) * -10).toFixed(1)}px) scale(${lerp(0.94, 1, pop).toFixed(3)})`, background: C.white, borderRadius: 12, boxShadow: SHADOW, padding: 6, fontSize: 21 }}>
              {['total()', 'byQuarter(q)', 'forecast(m)'].map((s, i) => <div key={s} style={{ padding: '7px 10px', borderRadius: 8, background: i === hi ? 'rgba(41,204,87,.16)' : undefined }}><span style={{ color: '#3b6cf6' }}>ƒ</span> {s}</div>)}
            </div>
          )}
        </span>
      </div>
    </div>
  );
};

export const eraCues: Cue[] = [
  ...[...tw1, ...tw2].map((t) => ({ f: ERAS[1] + t, s: 'clack', v: 0.3 })),
  { f: ERAS[1] + tw1[tw1.length - 1] + 10, s: 'ding', v: 0.15 },
  ...wpT.filter((_, i) => i % 2 === 0).map((t) => ({ f: ERAS[2] + t, s: 'key', v: 0.22 })), { f: ERAS[2] + W_CUT, s: 'tab', v: 0.3 }, { f: ERAS[2] + W_PASTE, s: 'tab', v: 0.3 },
  ...ac.map((t) => ({ f: ERAS[3] + t, s: 'key', v: 0.22 })), { f: ERAS[3] + TAP, s: 'key', v: 0.35 }, { f: ERAS[3] + TAP2, s: 'key', v: 0.35 },
  ...is1.filter((_, i) => i % 2 === 0).map((t) => ({ f: ERAS[4] + t, s: 'key', v: 0.22 })), { f: ERAS[4] + IS_TAB, s: 'tab', v: 0.32 },
];
