import React from 'react';
import { AbsoluteFill, interpolate, random, useCurrentFrame } from 'remotion';
import { C, SERIF, SANS, MONO, HAND, TYPE, Shot, Words, Kicker, Caret, Keycap, Pointer, Win, WALLPAPER, ramp, lerp, clamp, schedule, typedCount, easeInOut, easeOut, Cue } from '../lib';

export const ERA = 156; // frames per era

/* ───────────────────────── opening line ───────────────────────── */
export const OPEN = 126;
export const Open: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <Shot dur={OPEN} bg={C.white} cut>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', transform: `scale(${interpolate(f, [0, OPEN], [1, 1.06])})` }}>
        <div style={{ fontFamily: SERIF, fontWeight: 600, textAlign: 'center', letterSpacing: '-0.02em', lineHeight: 1.1 }}>
          <div style={{ fontSize: 112, color: C.ink }}><Words text="For 150 years," start={10} per={6} dur={24} /></div>
          <div style={{ fontSize: 62, color: C.ink3, marginTop: 30, maxWidth: 1500 }}><Words text="we kept making it faster to put words onto a page." start={40} per={3} dur={22} /></div>
        </div>
      </AbsoluteFill>
    </Shot>
  );
};

/* ───────────────────────── I · handwriting ───────────────────────── */
const INK = '#1e2b5c';
const HW = [
  { text: 'Dear John,', start: 10, dur: 62 },
  { text: 'here are the final numbers.', start: 84, dur: 170 }, // deliberately too slow to finish: the cut interrupts it
];
const hwProgress = (f: number, l: (typeof HW)[number]) => {
  const t = (f - l.start) / l.dur;
  return Math.max(0, Math.min(1, t + 0.012 * Math.sin((f - l.start) * 0.8) * (t > 0 && t < 1 ? 1 : 0)));
};
const Pen: React.FC<{ x: number; y: number }> = ({ x, y }) => (
  <svg width={640} height={640} viewBox="0 0 640 640" style={{ position: 'absolute', left: x, top: y - 640, overflow: 'visible', filter: 'drop-shadow(18px 26px 18px rgba(40,30,10,.28))' }}>
    <g transform="translate(0 640) rotate(-52)">
      <path d="M0 0L46 -12Q52 0 46 12Z" fill="#cfae5b" />
      <path d="M2 0L40 0" stroke="#8a6d27" strokeWidth="1.6" />
      <rect x="44" y="-14" width="58" height="28" rx="6" fill="#17181c" />
      <rect x="100" y="-19" width="430" height="38" rx="17" fill="#1e3354" />
      <rect x="108" y="-14" width="410" height="6" rx="3" fill="rgba(255,255,255,.22)" />
      <rect x="226" y="-20" width="16" height="40" rx="3" fill="#cfae5b" />
    </g>
  </svg>
);
export const Handwriting: React.FC = () => {
  const f = useCurrentFrame();
  const ps = HW.map((l) => hwProgress(f, l));
  const active = ps[1] > 0 ? 1 : 0;
  const LINE = 132, RULE0 = 470, LEFT = 260;
  const cam = interpolate(f, [0, ERA], [1.0, 1.14], clamp);
  const panX = interpolate(f, [0, ERA], [0, -90], clamp);
  return (
    <Shot dur={ERA} bg="#e7dfd2" outF={1}>
      <AbsoluteFill style={{ transform: `translateX(${panX}px) scale(${cam})`, transformOrigin: '40% 50%' }}>
        <div style={{ position: 'absolute', left: 150, top: 40, width: 1650, height: 1150, background: '#fbf7ee', transform: 'rotate(-1.6deg)', boxShadow: '0 2px 3px rgba(60,40,10,.08), 0 40px 90px rgba(60,40,10,.18)', borderRadius: 4 }}>
          {Array.from({ length: 9 }, (_, k) => <div key={k} style={{ position: 'absolute', left: 0, right: 0, top: RULE0 + (k - 2) * LINE, height: 2, background: 'rgba(70,110,190,.22)' }} />)}
          <div style={{ position: 'absolute', left: 190, top: 0, bottom: 0, width: 2, background: 'rgba(214,80,80,.35)' }} />
          {HW.map((l, i) => (
            <div key={i} style={{ position: 'absolute', left: LEFT, top: RULE0 + i * LINE - 104, fontFamily: HAND, fontWeight: 600, fontSize: 124, lineHeight: `${LINE}px`, color: INK, whiteSpace: 'nowrap' }}>
              <span style={{ position: 'relative', display: 'inline-block' }}>
                <span style={{ clipPath: `inset(-40% ${((1 - ps[i]) * 100).toFixed(2)}% -40% -5%)`, display: 'inline-block' }}>{l.text}</span>
                {i === active && (
                  <span style={{ position: 'absolute', left: `${ps[i] * 100}%`, top: 84 + Math.sin(f * 1.3) * 14, width: 0, height: 0 }}>
                    <Pen x={-2} y={0} />
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: 'radial-gradient(80% 80% at 50% 45%, transparent 60%, rgba(60,40,10,.18) 100%)' }} />
      <Kicker n="I" label="Handwriting" />
    </Shot>
  );
};

/* ───────────────────────── II · typewriter ───────────────────────── */
const TW1 = 'Dear John,', TW2 = 'here are the final numbers.';
const tw1 = schedule(TW1, 10, 3.4, 'tw1');
const TW_DING = tw1[tw1.length - 1] + 5, TW_RET = TW_DING + 9, TW_RET_END = TW_RET + 14;
const tw2 = schedule(TW2, TW_RET_END + 6, 2.5, 'tw2');
const TW_FS = 66, TW_CW = TW_FS * 0.62, TW_LH = 104;
export const Typewriter: React.FC = () => {
  const f = useCurrentFrame();
  const n1 = typedCount(tw1, f), n2 = typedCount(tw2, f);
  const ret = ramp(f, TW_RET, TW_RET_END, easeInOut);
  // the carriage moves left as each character lands, then flies back on return
  const strike = [...tw1, ...tw2].filter((t) => t <= f).pop() ?? -99;
  const kick = Math.max(0, 1 - (f - strike) / 4);
  const carriage = f < TW_RET ? -n1 * TW_CW - kick * 5 : lerp(-TW1.length * TW_CW, 0, ret) - n2 * TW_CW - (f >= TW_RET_END ? kick * 5 : 0);
  const lift = ret * TW_LH;
  const char = (s: string, i: number, seed: string) => (
    <span key={i} style={{ display: 'inline-block', width: TW_CW, textAlign: 'center', opacity: 0.78 + random(`${seed}o${i}`) * 0.22, transform: `translateY(${(random(`${seed}y${i}`) - 0.5) * 3}px) rotate(${(random(`${seed}r${i}`) - 0.5) * 2.2}deg)` }}>{s === ' ' ? ' ' : s}</span>
  );
  const BASE = 650, X0 = 960;
  return (
    <Shot dur={ERA} bg="#1b1a18" cut outF={10}>
      <AbsoluteFill style={{ transform: `scale(${interpolate(f, [0, ERA], [1.06, 1.16])}) translateY(${kick * 1.2}px)`, transformOrigin: '50% 58%' }}>
        {/* paper: the line being typed always sits just above the type guide */}
        <div style={{ position: 'absolute', left: X0 + carriage - 420, top: -420 - lift, width: 3000, height: BASE + 560 + lift, background: 'linear-gradient(90deg, #ece6d8, #f6f2e8 12%, #f6f2e8 88%, #ece6d8)', boxShadow: '0 0 60px rgba(0,0,0,.5)' }}>
          <div style={{ position: 'absolute', left: 420, top: BASE + 420 - 50, fontFamily: TYPE, fontSize: TW_FS, color: '#262320', whiteSpace: 'nowrap', lineHeight: `${TW_LH}px` }}>
            <div>{TW1.slice(0, n1).split('').map((s, i) => char(s, i, 'a'))}</div>
            <div>{TW2.slice(0, n2).split('').map((s, i) => char(s, i, 'b'))}</div>
          </div>
        </div>
        {/* platen and paper bail */}
        <div style={{ position: 'absolute', left: -100, right: -100, top: BASE + 110, height: 220, background: 'linear-gradient(#000 0%, #2c2b29 22%, #4a4845 34%, #191817 62%, #050505 100%)' }} />
        <div style={{ position: 'absolute', left: -100, right: -100, top: BASE + 70, height: 26, background: 'linear-gradient(#cfd2d6, #8a8e94)', boxShadow: '0 6px 14px rgba(0,0,0,.5)' }} />
        {/* type guide */}
        <svg width="90" height="70" style={{ position: 'absolute', left: X0 - 45 + TW_CW / 2, top: BASE + 28 }}>
          <path d="M8 4V40Q8 60 28 60H62Q82 60 82 40V4" fill="none" stroke="#c9ccd1" strokeWidth="8" strokeLinecap="round" />
        </svg>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: 'radial-gradient(70% 70% at 50% 45%, transparent 45%, rgba(0,0,0,.55) 100%)' }} />
      <Kicker n="II" label="Typewriter" dark />
    </Shot>
  );
};
export const typewriterCues: Cue[] = [
  ...tw1.map((f) => ({ f, s: 'clack', v: 0.75 })),
  { f: TW_DING, s: 'ding', v: 0.55 },
  { f: TW_RET, s: 'carriage', v: 0.7 },
  ...tw2.map((f) => ({ f, s: 'clack', v: 0.7 })),
];

/* ───────────────────────── III · word processor ───────────────────────── */
type Ev = { f: number; ch?: string };
const wpEvents: Ev[] = (() => {
  const out: Ev[] = [];
  const a = schedule('Dear John, here are the nubm', 6, 1.05, 'wp1');
  a.forEach((f, i) => out.push({ f, ch: 'Dear John, here are the nubm'[i] }));
  let t = a[a.length - 1] + 6;
  out.push({ f: t }); out.push({ f: t + 3 });
  schedule('mbers final.', t + 8, 1.1, 'wp2').forEach((f, i) => out.push({ f, ch: 'mbers final.'[i] }));
  return out;
})();
const WP_TYPED = wpEvents[wpEvents.length - 1].f;
const WP_SEL = WP_TYPED + 14, WP_CUT = WP_SEL + 14, WP_CLICK = WP_CUT + 14, WP_PASTE = WP_CLICK + 10;
const wpText = (f: number) => wpEvents.filter((e) => e.f <= f).reduce((s, e) => (e.ch ? s + e.ch : s.slice(0, -1)), '');
export const WordProcessor: React.FC = () => {
  const f = useCurrentFrame();
  const sel = ramp(f, WP_SEL, WP_SEL + 3);
  const pastedGlow = 1 - ramp(f, WP_PASTE + 4, WP_PASTE + 30);
  // pointer offsets relative to the span it is parked in
  const toFinal = ramp(f, WP_SEL - 18, WP_SEL - 2, easeInOut);
  const toGap = ramp(f, WP_CUT + 2, WP_CLICK - 1, easeInOut);
  const press = (at: number) => (f >= at && f < at + 4 ? 1 : 0);
  const caret = <Caret color={C.ink} on={false} />;
  let body: React.ReactNode;
  if (f < WP_SEL - 18) {
    body = <>{wpText(f)}{caret}</>;
  } else if (f < WP_CUT) {
    body = (
      <>Dear John, here are the numbers<span style={{ position: 'relative', background: sel > 0.5 ? '#b4d5fe' : 'transparent', borderRadius: 4 }}> final<Pointer x={lerp(380, 70, toFinal)} y={lerp(260, 30, toFinal)} press={press(WP_SEL - 1)} /></span>.{f < WP_SEL ? caret : null}</>
    );
  } else if (f < WP_PASTE) {
    body = (
      <>Dear John, here are the <span style={{ position: 'relative' }}>{f >= WP_CLICK ? caret : null}<Pointer x={lerp(250, 10, toGap)} y={30} press={press(WP_CLICK - 1)} /></span>numbers.</>
    );
  } else {
    const pop = ramp(f, WP_PASTE, WP_PASTE + 10);
    body = (
      <>Dear John, here are the <span style={{ position: 'relative', background: `rgba(41,204,87,${(0.22 * pastedGlow).toFixed(3)})`, borderRadius: 6, display: 'inline-block', transform: `scale(${lerp(0.9, 1, pop)})`, opacity: pop }}>final&nbsp;</span>{caret}numbers.<span style={{ position: 'relative' }}><Pointer x={lerp(-250, -230, pop)} y={lerp(30, 70, pop)} /></span></>
    );
  }
  const keys = (at: number, letter: string) => {
    const show = ramp(f, at - 8, at - 2) * (1 - ramp(f, at + 14, at + 20));
    const p = f >= at && f < at + 6 ? 1 : 0;
    return show > 0.01 ? (
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 110, display: 'flex', justifyContent: 'center', gap: 16, opacity: show, transform: `translateY(${(1 - show) * 20}px)` }}>
        <Keycap label="⌘" pressed={p} size={40} /><Keycap label={letter} pressed={p} size={40} />
      </div>
    ) : null;
  };
  return (
    <Shot dur={ERA} bg="#efe9e2">
      <AbsoluteFill style={{ background: WALLPAPER }} />
      <AbsoluteFill style={{ transform: `scale(${interpolate(f, [0, ERA], [1.0, 1.08])})` }}>
        <Win title="Letter.doc — Edited" w={1520} h={700} x={200} y={170}>
          <div style={{ height: 64, borderBottom: '1px solid #f0eeeb', display: 'flex', alignItems: 'center', gap: 30, padding: '0 36px', fontFamily: SANS, fontSize: 24, color: C.ink3 }}>
            <span style={{ fontFamily: SERIF }}>Source Serif</span><span>·</span><span>58</span><b style={{ color: C.ink2 }}>B</b><i>I</i><u>U</u><span>≡</span>
          </div>
          <div style={{ padding: '90px 120px', fontFamily: SERIF, fontSize: 58, fontWeight: 500, color: C.ink, whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>{body}</div>
        </Win>
      </AbsoluteFill>
      {keys(WP_CUT, 'X')}
      {keys(WP_PASTE, 'V')}
      <Kicker n="III" label="Word processor" />
    </Shot>
  );
};
export const wordCues: Cue[] = [
  ...wpEvents.map((e) => ({ f: e.f, s: 'key', v: 0.8 })),
  { f: WP_SEL - 1, s: 'key', v: 0.5 }, { f: WP_SEL + 1, s: 'key', v: 0.5 },
  { f: WP_CUT, s: 'tab', v: 0.6 }, { f: WP_CLICK - 1, s: 'key', v: 0.5 }, { f: WP_PASTE, s: 'tab', v: 0.6 },
];

/* ───────────────────────── IV · autocomplete ───────────────────────── */
const ac1 = schedule('Dear Joh', 12, 3.1, 'ac1');
const AC_GHOST = ac1[ac1.length - 1] + 6, AC_TAB = AC_GHOST + 20;
const AC_GHOST2 = AC_TAB + 22, AC_TAB2 = AC_GHOST2 + 22;
export const Autocomplete: React.FC = () => {
  const f = useCurrentFrame();
  const n = typedCount(ac1, f);
  const g1 = ramp(f, AC_GHOST, AC_GHOST + 8), g2 = ramp(f, AC_GHOST2, AC_GHOST2 + 8);
  const ok1 = f >= AC_TAB, ok2 = f >= AC_TAB2;
  const flash = (at: number) => 1 - ramp(f, at, at + 22);
  const tabShow = (at: number) => ramp(f, at - 12, at - 4) * (1 - ramp(f, at + 10, at + 16));
  const tabP = (at: number) => (f >= at && f < at + 6 ? 1 : 0);
  const ghost = { color: 'rgba(0,0,0,.3)' };
  const accepted = (at: number) => ({ background: `rgba(41,204,87,${(0.2 * flash(at)).toFixed(3)})`, borderRadius: 6 });
  const cam = interpolate(f, [0, 60, ERA], [1, 1.18, 1.3], { ...clamp, easing: easeInOut });
  return (
    <Shot dur={ERA} bg="#efe9e2">
      <AbsoluteFill style={{ background: WALLPAPER }} />
      <AbsoluteFill style={{ transform: `scale(${cam})`, transformOrigin: '40% 52%' }}>
        <Win title="New Message" w={1400} h={760} x={260} y={160}>
          {[['To:', 'John Carter'], ['Subject:', 'Final numbers']].map(([k, v]) => (
            <div key={k} style={{ height: 72, borderBottom: '1px solid #f0eeeb', display: 'flex', alignItems: 'center', gap: 16, padding: '0 40px', fontFamily: SANS, fontSize: 28 }}>
              <span style={{ color: C.ink3 }}>{k}</span><span style={{ color: C.ink, fontWeight: 500 }}>{v}</span>
            </div>
          ))}
          <div style={{ padding: '60px 40px', fontFamily: SANS, fontSize: 50, color: C.ink, fontWeight: 500, whiteSpace: 'nowrap' }}>
            {'Dear Joh'.slice(0, n)}
            {ok1 ? <span style={accepted(AC_TAB)}>n,</span> : null}
            {!ok1 && n === 8 ? <><Caret color={C.ink} on={false} /><span style={{ ...ghost, opacity: g1 }}>n,</span></> : null}
            {ok1 && !ok2 ? <><Caret color={C.ink} on={false} /><span style={{ ...ghost, opacity: g2 }}> I hope you’re well.</span></> : null}
            {ok2 ? <><span style={accepted(AC_TAB2)}> I hope you’re well.</span><Caret color={C.ink} on={false} /></> : null}
            {n < 8 ? <Caret color={C.ink} /> : null}
          </div>
        </Win>
      </AbsoluteFill>
      {[AC_TAB, AC_TAB2].map((at) => tabShow(at) > 0.01 && (
        <div key={at} style={{ position: 'absolute', left: 0, right: 0, bottom: 110, display: 'flex', justifyContent: 'center', opacity: tabShow(at) }}>
          <Keycap label="Tab ⇥" pressed={tabP(at)} size={38} />
        </div>
      ))}
      <Kicker n="IV" label="Autocomplete" />
    </Shot>
  );
};
export const autoCues: Cue[] = [...ac1.map((f) => ({ f, s: 'key', v: 0.8 })), { f: AC_TAB, s: 'tab', v: 0.6 }, { f: AC_TAB2, s: 'tab', v: 0.6 }];

/* ───────────────────────── V · IntelliSense ───────────────────────── */
const K = { kw: '#c2255c', fn: '#3b6cf6', str: '#1f9d55', id: '#111', p: 'rgba(0,0,0,.45)', cm: 'rgba(0,0,0,.35)' };
const L3: [string, string][] = [['const ', K.kw], ['spend', K.id], [' = ', K.p], ['budget', K.id], ['.', K.p], ['byQuarter', K.fn], ['(', K.p], ['"Q4"', K.str], [')', K.p], [';', K.p]];
const L3_TEXT = L3.map((t) => t[0]).join('');
const is1 = schedule('const spend = budget.', 10, 1.7, 'is1');
const IS_POP = is1[is1.length - 1] + 5, IS_DOWN = IS_POP + 16, IS_TAB = IS_DOWN + 18;
const is2 = schedule('"Q4");', IS_TAB + 12, 2.4, 'is2');
const IS_ITEMS = [['total', '()'], ['byQuarter', '(q: Quarter)'], ['forecast', '(months)'], ['lineItems', '()'], ['owner', '']];
export const IntelliSense: React.FC = () => {
  const f = useCurrentFrame();
  let count = typedCount(is1, f);
  if (f >= IS_TAB) count = 'const spend = budget.byQuarter('.length + typedCount(is2, f);
  const reveal = (tokens: [string, string][], n: number) => {
    let left = n;
    return tokens.map(([t, c], i) => { const s = t.slice(0, Math.max(0, left)); left -= t.length; return s ? <span key={i} style={{ color: c }}>{s}</span> : null; });
  };
  const pop = ramp(f, IS_POP, IS_POP + 8) * (f < IS_TAB ? 1 : 0);
  const hi = f >= IS_DOWN ? 1 : 0;
  const autoClose = f >= IS_TAB && count < L3_TEXT.length - 1;
  const cam = interpolate(f, [0, 40, ERA], [1.0, 1.06, 1.26], { ...clamp, easing: easeInOut });
  const line = (n: number, children: React.ReactNode, hl = false) => (
    <div style={{ display: 'flex', height: 60, alignItems: 'center', background: hl ? 'rgba(59,108,246,.05)' : undefined }}>
      <span style={{ width: 90, textAlign: 'right', paddingRight: 34, color: 'rgba(0,0,0,.22)' }}>{n}</span>
      <span style={{ whiteSpace: 'pre' }}>{children}</span>
    </div>
  );
  return (
    <Shot dur={ERA} bg="#efe9e2" outF={16}>
      <AbsoluteFill style={{ background: WALLPAPER }} />
      <AbsoluteFill style={{ transform: `scale(${cam})`, transformOrigin: '42% 52%' }}>
        <Win title="report.ts" w={1440} h={760} x={240} y={160}>
          <div style={{ display: 'flex', height: 52, background: '#fbfaf9', borderBottom: '1px solid #f0eeeb', fontFamily: SANS, fontSize: 21, color: C.ink3 }}>
            <span style={{ padding: '0 26px', display: 'flex', alignItems: 'center', background: C.white, color: C.ink, borderRight: '1px solid #f0eeeb' }}>report.ts</span>
            <span style={{ padding: '0 26px', display: 'flex', alignItems: 'center' }}>finance.ts</span>
          </div>
          <div style={{ paddingTop: 36, fontFamily: MONO, fontSize: 34, color: K.id }}>
            {line(1, <><span style={{ color: K.kw }}>import</span><span style={{ color: K.p }}>{' { '}</span>budget<span style={{ color: K.p }}>{' } '}</span><span style={{ color: K.kw }}>from</span> <span style={{ color: K.str }}>"./finance"</span><span style={{ color: K.p }}>;</span></>)}
            {line(2, '')}
            {line(3, <span style={{ color: K.cm }}>// what did we spend on the Q4 launch?</span>)}
            {line(4, <>
              {reveal(L3, count)}
              <span style={{ position: 'relative' }}>
                <Caret color={C.ink} on={f < 8 || (f > is1[0] && f < IS_TAB + 40)} />
                {autoClose ? <span style={{ color: K.p }}>)</span> : null}
                {pop > 0.01 && (
                  <div style={{ position: 'absolute', left: -6, top: 54, display: 'flex', gap: 14, opacity: pop, transform: `translateY(${(1 - pop) * -10}px)`, transformOrigin: '0 0' }}>
                    <div style={{ width: 500, background: C.white, borderRadius: 14, boxShadow: '0 0 0 1px rgba(0,0,0,.08), 0 24px 60px rgba(0,0,0,.16)', padding: 8, fontSize: 28 }}>
                      {IS_ITEMS.map(([name, sig], i) => (
                        <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 16, height: 54, padding: '0 14px', borderRadius: 9, background: i === hi ? 'rgba(59,108,246,.12)' : undefined }}>
                          <span style={{ width: 32, height: 32, borderRadius: 7, background: name === 'owner' ? '#fdf0e4' : '#eef2ff', color: name === 'owner' ? '#e8590c' : K.fn, display: 'grid', placeItems: 'center', fontSize: 20, fontFamily: SANS, fontWeight: 700 }}>{name === 'owner' ? 'p' : 'ƒ'}</span>
                          <span style={{ color: K.id }}>{name}</span><span style={{ color: 'rgba(0,0,0,.35)', fontSize: 24 }}>{sig}</span>
                        </div>
                      ))}
                    </div>
                    {hi === 1 && (
                      <div style={{ width: 370, whiteSpace: 'normal', alignSelf: 'flex-start', marginTop: 62, background: '#fbfaf9', borderRadius: 14, boxShadow: '0 0 0 1px rgba(0,0,0,.07), 0 18px 40px rgba(0,0,0,.1)', padding: '18px 22px', fontSize: 22, lineHeight: 1.5, opacity: ramp(f, IS_DOWN, IS_DOWN + 6) }}>
                        <div><span style={{ color: K.fn }}>byQuarter</span>(q: Quarter): <span style={{ color: K.kw }}>Spend</span></div>
                        <div style={{ fontFamily: SANS, fontSize: 22, color: C.ink2, marginTop: 8 }}>Total spend for one fiscal quarter.</div>
                      </div>
                    )}
                  </div>
                )}
              </span>
            </>, true)}
            {line(5, '')}
            {line(6, <><span style={{ color: K.kw }}>export</span> <span style={{ color: K.kw }}>default</span> spend<span style={{ color: K.p }}>;</span></>)}
          </div>
        </Win>
      </AbsoluteFill>
      {(() => { const s = ramp(f, IS_TAB - 10, IS_TAB - 3) * (1 - ramp(f, IS_TAB + 10, IS_TAB + 16)); return s > 0.01 ? <div style={{ position: 'absolute', left: 0, right: 0, bottom: 110, display: 'flex', justifyContent: 'center', opacity: s }}><Keycap label="Tab ⇥" pressed={f >= IS_TAB && f < IS_TAB + 6 ? 1 : 0} size={38} /></div> : null; })()}
      <Kicker n="V" label="IntelliSense" />
    </Shot>
  );
};
export const intelliCues: Cue[] = [...is1.map((f) => ({ f, s: 'key', v: 0.8 })), { f: IS_DOWN, s: 'key', v: 0.4 }, { f: IS_TAB, s: 'tab', v: 0.6 }, ...is2.map((f) => ({ f, s: 'key', v: 0.8 }))];
