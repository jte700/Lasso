import React from 'react';
import { AbsoluteFill, interpolate, random, useCurrentFrame } from 'remotion';
import { C, SERIF, SANS, MONO, BAR, Caret, FileTile, Suggestion, ramp, life, lerp, clamp, camera, typing, count, EASE, ENTER, EXIT, Q, S, L, SHADOW, Key as CamKey } from '../kit';
import type { Cue } from '../cues';

/* ───────────── D · the modern workplace (bars 13–20) ───────────── */
export const WORK = BAR * 7;
const MORPH = 52, REPLY = 172;
const REPLY_TEXT = 'The final Q4 spend was ';
const rp = typing(REPLY_TEXT, 206, 3.1, 'rp');
const OLD = 300, PICK1 = 392, PICK2 = 472, REWIND = 548, OLD_END = 604; // the old way, then time runs backwards
const POP = 700, TAB = BAR * 5, DOT = TAB + 14; // Tab lands on the downbeat of bar 18
const OUTRO = WORK - 96;

const CAM: CamKey[] = [
  [0, 1, 960, 540], [REPLY - 10, 1.04, 960, 520], [REPLY + 40, 1.0, 960, 530], [OLD - 6, 1.22, 900, 700],
  [OLD + 30, 1, 960, 540], [REWIND, 1, 960, 540], [OLD_END + 10, 1.34, 900, 740],
  [POP + 30, 1.4, 960, 770], [TAB + 30, 1.4, 940, 760], [OUTRO, 1.08, 960, 600], [WORK, 1.06, 960, 590],
];

// rectangles: the notification banner grows into the mail card
const BANNER = { x: 650, y: 64, w: 620, h: 108, r: 26 }, CARD = { x: 400, y: 150, w: 1120, h: 430, r: 34 };
const REPLY_Y = 620;

const Banner: React.FC<{ o: number }> = ({ o }) => (
  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', gap: 20, padding: '0 24px', opacity: o, fontFamily: SANS }}>
    <span style={{ width: 60, height: 60, borderRadius: 15, background: 'linear-gradient(#63adff, #2b6df5)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 30, flex: 'none' }}>✉</span>
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ display: 'flex', fontSize: 23, fontWeight: 700, color: C.ink }}>Jordan Lee<span style={{ marginLeft: 'auto', fontWeight: 500, fontSize: 19, color: C.ink3 }}>now</span></div>
      <div style={{ fontSize: 21, color: C.ink2, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Q4 launch spend — Hey, what did we actually spend…</div>
    </div>
  </div>
);
const Mail: React.FC<{ o: number }> = ({ o }) => (
  <div style={{ position: 'absolute', inset: 0, padding: '46px 60px', opacity: o, fontFamily: SANS, color: C.ink }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
      <span style={{ width: 62, height: 62, borderRadius: 31, background: '#fbe1cb', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 23, color: 'rgba(20,32,26,.7)' }}>JL</span>
      <div><div style={{ fontSize: 25, fontWeight: 700 }}>Jordan Lee</div><div style={{ fontSize: 19, color: C.ink3, marginTop: 2 }}>to me · 9:41 AM</div></div>
    </div>
    <div style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 46, letterSpacing: '-0.015em', marginTop: 30 }}>Q4 launch spend</div>
    <div style={{ fontSize: 34, lineHeight: 1.45, marginTop: 14, maxWidth: 960 }}>Hey — what did we actually spend on the Q4 launch? I can’t find the final number.</div>
  </div>
);

/* the old way: files burst out of the caret, circle, get opened one by one, then everything rewinds */
const FILES: { type: any; name: string }[] = [
  { type: 'mail', name: 'Fwd: Re: budget' }, { type: 'xlsx', name: 'Budget_Final.xlsx' }, { type: 'xlsx', name: 'Budget_Final_v2.xlsx' }, { type: 'pdf', name: 'Q4_Recap.pdf' },
  { type: 'xlsx', name: 'Budget_Final_v3.xlsx' }, { type: 'docx', name: 'Launch_Notes.docx' }, { type: 'xlsx', name: 'Budget_Final (1).xlsx' }, { type: 'key', name: 'Board_v9.key' },
];
const ORIGIN = { x: 905, y: 742 };
const SheetPeek: React.FC<{ rows: [number, string, string][]; hl?: number; scroll?: number; tag?: React.ReactNode }> = ({ rows, hl, scroll = 0, tag }) => (
  <div style={{ width: 620, height: 330, background: C.paper, borderRadius: 22, boxShadow: SHADOW, overflow: 'hidden', fontFamily: SANS, position: 'relative' }}>
    <div style={{ height: 50, display: 'flex', alignItems: 'center', padding: '0 22px', borderBottom: `1px solid ${C.line}`, fontSize: 19, fontWeight: 600, color: C.ink2, gap: 10 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: C.greenD }} />{tag}</div>
    <div style={{ transform: `translateY(${-scroll}px)` }}>
      {rows.map(([n, a, v]) => (
        <div key={n} style={{ display: 'grid', gridTemplateColumns: '58px 1fr 160px', height: 46, alignItems: 'center', borderBottom: '1px solid #f1eeea', background: n === hl ? '#fff4cc' : undefined, fontWeight: n === hl ? 600 : 400, fontSize: 20 }}>
          <span style={{ textAlign: 'center', color: C.ink3, fontSize: 16 }}>{n}</span><span>{a}</span><span style={{ fontFamily: MONO, fontSize: 19, textAlign: 'right', paddingRight: 22 }}>{v}</span>
        </div>
      ))}
    </div>
  </div>
);
const LINES = ['Paid social', 'Search ads', 'Launch event', 'Venue deposit', 'Creative agency', 'Print', 'Swag', 'PR retainer', 'Video shoot', 'Travel'];
const rowsFrom = (a: number, n: number, seed: number, special?: [number, string, string]): [number, string, string][] =>
  Array.from({ length: n }, (_, i) => { const k = a + i; if (special && special[0] === k) return special; return [k, LINES[(k * 7 + seed) % LINES.length], `$${((((k * 7919 + seed * 31) % 900) * 97) + 4200).toLocaleString('en-US')}`]; });

const OldWay: React.FC<{ f: number }> = ({ f }) => {
  const rewind = ramp(f, REWIND, OLD_END - REWIND, EASE);
  const swirl = interpolate(f, [OLD, REWIND], [0, 0.55], clamp);
  const focus = (at: number) => life(f, at, at + 74, S, Q + 4);
  const timer = Math.round(interpolate(f, [OLD, REWIND], [0, 167], clamp) * (1 - rewind));
  const chip = life(f, OLD + 10, OLD_END - 6, S, Q);
  return (
    <>
      {FILES.map((file, i) => {
        // burst from the caret (closest first), circle the stage, fly back last-in first-out
        const out = ramp(f, OLD + i * 3, L, ENTER), back = ramp(f, REWIND + (7 - i) * 3, 30, EASE);
        const k = out * (1 - back);
        if (k < 0.002) return null;
        const a = (i / FILES.length) * Math.PI * 2 - Math.PI / 2 + swirl;
        let x = 960 + Math.cos(a) * 700, y = 540 + Math.sin(a) * 330;
        const isPick = (i === 1 && f < PICK2) || i === 4;
        const pf = i === 1 ? focus(PICK1) : i === 4 ? focus(PICK2) : 0;
        x = lerp(x, 960, isPick ? pf : 0); y = lerp(y, 360, isPick ? pf : 0);
        const shake = i === 1 && f > PICK1 + 44 && f < PICK1 + 62 ? Math.sin((f - PICK1 - 44) * 1.1) * 12 * (1 - (f - PICK1 - 44) / 18) : 0;
        const dim = (focus(PICK1) + focus(PICK2)) * (isPick ? 0 : 0.6);
        return (
          <FileTile key={i} type={file.type} name={file.name} size={170} mark={i === 1 && f > PICK1 + 40 ? 'x' : undefined}
            style={{ left: lerp(ORIGIN.x, x, k) - 85 + shake, top: lerp(ORIGIN.y, y, k) - 100, opacity: Math.min(1, k * 1.5) * (1 - dim), transform: `scale(${(lerp(0.2, 1, k) * (1 + pf * 0.15)).toFixed(3)}) rotate(${((random(`r${i}`) - 0.5) * 10 * (1 - pf)).toFixed(2)}deg)`, zIndex: isPick ? 3 : 1 }} />
        );
      })}
      {/* the two files that get opened */}
      {focus(PICK1) > 0.01 && (
        <div style={{ position: 'absolute', left: 650, top: 500, opacity: focus(PICK1), transform: `translateY(${((1 - focus(PICK1)) * 24).toFixed(1)}px) translateX(${f > PICK1 + 44 && f < PICK1 + 62 ? (Math.sin((f - PICK1 - 44) * 1.1) * 12 * (1 - (f - PICK1 - 44) / 18)).toFixed(1) : 0}px)`, zIndex: 4 }}>
          <SheetPeek rows={rowsFrom(20, 6, 3, [23, 'Q4 launch — total', '$391,200'])} hl={23} tag={<>Budget_Final.xlsx <span style={{ marginLeft: 'auto', color: C.red, background: '#fde6e6', padding: '4px 12px', borderRadius: 999, fontSize: 16 }}>Draft · Aug 2</span></>} />
        </div>
      )}
      {focus(PICK2) > 0.01 && (
        <div style={{ position: 'absolute', left: 650, top: 500, opacity: focus(PICK2), transform: `translateY(${((1 - focus(PICK2)) * 24).toFixed(1)}px)`, zIndex: 4 }}>
          <SheetPeek rows={rowsFrom(1, 50, 5, [47, 'Q4 launch — total', '$428,750'])} hl={f > PICK2 + 50 ? 47 : undefined} scroll={interpolate(f, [PICK2 + 14, PICK2 + 50], [0, 42 * 46], { ...clamp, easing: EASE })} tag={<>Budget_Final_v3.xlsx</>} />
        </div>
      )}
      {chip > 0.01 && (
        <div style={{ position: 'absolute', left: 0, right: 0, top: 96, display: 'flex', justifyContent: 'center', opacity: chip, transform: `translateY(${((1 - chip) * -14).toFixed(1)}px)` }}>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center', padding: '14px 26px', borderRadius: 999, background: C.ink, color: '#fff', fontFamily: SANS, fontSize: 24, fontWeight: 600 }}>
            <span style={{ opacity: 0.6 }}>The old way</span><span style={{ fontFamily: MONO, fontWeight: 400 }}>{Math.floor(timer / 60)}:{String(timer % 60).padStart(2, '0')}</span><span style={{ opacity: 0.6 }}>4 apps · 5 files</span>
          </div>
        </div>
      )}
    </>
  );
};

export const Work: React.FC = () => {
  const f = useCurrentFrame();
  // banner → card
  const bIn = ramp(f, 0, S + 6, ENTER), m = ramp(f, MORPH, 40, EASE);
  const lift = ramp(f, REPLY - 30, 40, EASE); // the card rises to make room for the reply
  const R = { x: lerp(BANNER.x, CARD.x, m), y: lerp(lerp(BANNER.y - 160 * (1 - bIn), CARD.y, m), 70, lift), w: lerp(BANNER.w, CARD.w, m), h: lerp(BANNER.h, CARD.h, m), r: lerp(BANNER.r, CARD.r, m) };
  const replyIn = ramp(f, REPLY - 6, S + 10, ENTER);
  const old = life(f, OLD - 4, OLD_END + 6, S, S);
  const n = count(rp, f);
  const pop = ramp(f, POP, 30, ENTER) * (1 - ramp(f, TAB, 8, EXIT));
  const dot = life(f, POP - 14, POP + 10, 8, 8);
  const ins = f >= TAB, glow = 1 - ramp(f, TAB + 6, 50);
  const tabOn = f >= TAB - 2 && f < TAB + 8;
  const src = life(f, TAB + 70, OUTRO + 10, S, Q);
  const exit = ramp(f, OUTRO + 16, 50, EXIT);
  const line = ramp(f, OUTRO + 30, 54, EASE);
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: 1 - exit, filter: exit > 0.01 ? `blur(${(exit * 8).toFixed(2)}px)` : undefined }}>
        <AbsoluteFill style={{ transformOrigin: '0 0', transform: camera(f, CAM) }}>
          <div style={{ position: 'absolute', inset: 0, opacity: 1 - old * 0.88, filter: old > 0.01 ? `blur(${(old * 8).toFixed(2)}px)` : undefined }}>
            {/* banner / mail card */}
            <div style={{ position: 'absolute', left: R.x, top: R.y, width: R.w, height: R.h, borderRadius: R.r, background: m < 0.5 ? 'rgba(255,255,255,.92)' : C.paper, boxShadow: SHADOW, overflow: 'hidden', opacity: bIn }}>
              <Banner o={1 - ramp(f, MORPH, Q)} />
              <Mail o={ramp(f, MORPH + 26, S)} />
            </div>
            {/* reply */}
            <div style={{ position: 'absolute', left: CARD.x, top: REPLY_Y, width: CARD.w, height: 250, borderRadius: 30, background: C.paper, boxShadow: SHADOW, opacity: replyIn, transform: `translateY(${((1 - replyIn) * 60).toFixed(1)}px)`, padding: '28px 48px', fontFamily: SANS }}>
              <div style={{ fontSize: 20, color: C.ink3, display: 'flex' }}>↩ To: <b style={{ color: C.ink2, marginLeft: 6 }}>Jordan Lee</b><span style={{ marginLeft: 'auto' }}>Re: Q4 launch spend</span></div>
              <div style={{ fontSize: 46, fontWeight: 500, letterSpacing: '-0.012em', marginTop: 40, color: C.ink, whiteSpace: 'pre' }}>
                {REPLY_TEXT.slice(0, n)}
                {ins && (
                  <span style={{ position: 'relative', borderRadius: 6, padding: '0 2px', background: `rgba(41,204,87,${(0.22 * glow).toFixed(3)})`, boxShadow: `inset 0 -4px 0 ${C.green}` }}>
                    $428,750
                    {src > 0.01 && <span style={{ position: 'absolute', left: 0, top: 70, fontFamily: MONO, fontSize: 18, color: C.ink3, opacity: src, whiteSpace: 'nowrap', transform: `translateY(${((1 - src) * 8).toFixed(1)}px)` }}>↳ Q4_Budget_Final.xlsx · Marketing · Row 47</span>}
                  </span>
                )}
                {f >= DOT ? '.' : ''}
                <span style={{ position: 'relative' }}>
                  {f >= REPLY + 20 && <Caret blink={f > rp[rp.length - 1] + 6 && f < POP - 14} />}
                  {dot > 0.01 && pop < 0.2 && <span style={{ position: 'absolute', left: -2, top: 62, width: 14, height: 14, borderRadius: 7, background: C.green, transform: `scale(${dot.toFixed(3)})` }} />}
                  {pop > 0.005 && (
                    <div style={{ position: 'absolute', left: -14, top: 64 }}>
                      <Suggestion value="$428,750" source="Q4_Budget_Final.xlsx · Marketing · Row 47" show={pop} tab={tabOn} />
                    </div>
                  )}
                </span>
              </div>
            </div>
          </div>
          {f >= OLD && f < OLD_END + 6 && <OldWay f={f} />}
        </AbsoluteFill>
      </AbsoluteFill>
      {/* the underline becomes a line across the frame, which the next scene picks up */}
      {line > 0.01 && <div style={{ position: 'absolute', top: 538, left: 960 - 960 * line, width: 1920 * line, height: 4, borderRadius: 2, background: C.green, opacity: ramp(f, OUTRO + 30, 10) }} />}
    </AbsoluteFill>
  );
};

export const workCues: Cue[] = [
  { f: 2, s: 'notify', v: 0.35 },
  ...rp.map((f) => ({ f, s: 'key', v: 0.28 })),
  { f: TAB, s: 'tab', v: 0.45 }, { f: DOT, s: 'key', v: 0.3 },
];
