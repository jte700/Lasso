import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { C, SANS, MONO, BAR, Words, Selected, Wallpaper, Focus, KeyCombo, Cursor, LassoMark, Caret, sp, glide, ramp, lerp, life, clamp, camera, typing, count, EASE, ENTER, EXIT, S, Q, SHADOW } from '../kit';
import type { CamKey } from '../kit';
import { ellipse, curve, boilAt } from '../sketch';
import type { Cue } from '../../v2/cues';

/* ───────────── C · the interruption (bars 10–13): the music stops ───────────── */
export const PAUSE = BAR * 3;
const reveal = (f: number, a: number) => { const v = ramp(f, a, S, ENTER); return { opacity: v, display: 'inline-block', whiteSpace: 'pre', transform: `translateY(${((1 - v) * 0.25).toFixed(3)}em)`, filter: v < 0.99 ? `blur(${((1 - v) * 12).toFixed(1)}px)` : undefined } as React.CSSProperties; };
export const Pause: React.FC = () => {
  const f = useCurrentFrame();
  const FIND = BAR - 12;
  const g1 = ramp(f, 252, S, EXIT), g2 = ramp(f, PAUSE - 24, S, EXIT);
  return (
    <AbsoluteFill style={{ background: C.white, alignItems: 'center', justifyContent: 'center' }}>
      {f < 46 && <div style={{ position: 'absolute', fontFamily: SANS, fontSize: 110, opacity: 1 - ramp(f, 34, 10) }}><Caret blink /></div>}
      <div style={{ position: 'absolute', top: 380, left: 0, right: 0, textAlign: 'center', fontFamily: SANS, fontWeight: 600, fontSize: 112, letterSpacing: '-0.03em', lineHeight: 1.1, opacity: 1 - g1, filter: g1 > 0.01 ? `blur(${(g1 * 14).toFixed(1)}px)` : undefined }}>
        <Words text="Typing got faster." start={46} step={11} size={112} color={f > FIND ? 'rgba(17,21,17,.3)' : C.ink} />
        <div><span style={reveal(f, FIND)}>Finding </span><span style={reveal(f, FIND + 12)}><Selected at={FIND + 40} dur={16}>didn’t.</Selected></span></div>
      </div>
      <div style={{ position: 'absolute', top: 400, left: 0, right: 0, opacity: 1 - g2, filter: g2 > 0.01 ? `blur(${(g2 * 14).toFixed(1)}px)` : undefined }}>
        <Words text="The modern bottleneck isn’t typing anymore." start={282} step={5} size={50} weight={500} color={C.ink2} />
        <div style={{ height: 20 }} />
        <div style={{ textAlign: 'center', fontFamily: SANS, fontWeight: 600, fontSize: 96, letterSpacing: '-0.03em' }}>
          <span style={reveal(f, 330)}>It’s </span><span style={reveal(f, 338)}><Selected at={372} dur={14}>finding</Selected> </span><span style={reveal(f, 346)}>what you need to type.</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ───────────── D · the workplace (bars 13–20) ───────────── */
export const WORK = BAR * 7;
const NEW = 40, CLICK1 = 132, CLICK2 = 268, OPEN = 272;
const REPLY_TEXT = 'The final Q4 spend was ';
const rp = typing(REPLY_TEXT, 300, 2.8, 'rp');
const DIG = 392, PICK1 = 448, PICK2 = 512, DIG_END = 596;
const POP = 700, TAB = BAR * 5, AFTER = TAB + 30, OUT = WORK - 64;
// the Mail window, in stage coordinates
const WIN = { x: 210, y: 110, w: 1500, h: 860 }, LIST_W = 480, ROW = 108, ROW0 = WIN.y + 56 + 70;
const PANE = { x: WIN.x + LIST_W, y: WIN.y + 56 };
const CAM: CamKey[] = [
  [0, 1, 960, 540], [74, 1, 960, 540], [CLICK1 - 2, 1.85, 470, 300], [CLICK1 + 10, 1.85, 470, 300], [CLICK1 + 56, 1, 960, 540],
  [CLICK1 + 66, 1, 960, 540], [236, 1.45, 1180, 430], [250, 1.45, 1190, 420], [CLICK2 - 2, 1.8, 1340, 240], [CLICK2 + 8, 1.8, 1340, 240],
  [OPEN + 34, 1.32, 1190, 640], [345, 1.6, 1130, 760], [DIG - 6, 1.6, 1130, 760], [DIG + 34, 1, 960, 540], [DIG_END - 10, 1, 960, 540],
  [DIG_END + 34, 1.62, 1130, 770], [POP + 40, 1.62, 1180, 800], [TAB + 40, 1.6, 1160, 790], [OUT - 30, 1, 960, 540], [WORK, 0.98, 960, 540],
];
const INBOX = [
  { from: 'Jordan Lee', sub: 'Q4 launch spend', pre: 'Hey — what did we actually spend…', time: '9:41', isNew: true },
  { from: 'Priya Shah', sub: 'Venue contract (signed)', pre: 'Attached the countersigned copy…', time: '9:12' },
  { from: 'Marcus Webb', sub: 'Re: Board deck', pre: 'Slide 9 still has the old figures…', time: '8:57' },
  { from: 'Design Weekly', sub: 'Issue 214', pre: 'Five type pairings that work…', time: '8:30' },
  { from: 'Calendar', sub: 'Launch retro moved', pre: 'Thursday 3 PM → Friday 11 AM', time: 'Mon' },
  { from: 'Ana Ruiz', sub: 'Photos from the event', pre: 'Shared album with 214 photos', time: 'Mon' },
];
const FinderRow: React.FC<{ name: string; date: string; on?: boolean }> = ({ name, date, on }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 16, height: 62, padding: '0 26px', background: on ? '#2f7bf0' : undefined, color: on ? '#fff' : C.ink, fontSize: 24, fontWeight: 500 }}>
    <span style={{ width: 28, height: 34, borderRadius: 5, background: C.greenD, flex: 'none' }} />{name}<span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 20 }}>{date}</span>
  </div>
);
const SHEET_ROWS = (a: number, n: number, special: [number, string, string]): [number, string, string][] => Array.from({ length: n }, (_, i) => { const k = a + i; if (k === special[0]) return special; return [k, ['Paid social', 'Search ads', 'Venue deposit', 'Creative agency', 'Print', 'Swag', 'PR retainer'][k % 7], `$${(((k * 7919) % 900) * 97 + 4200).toLocaleString('en-US')}`]; });
const Sheet: React.FC<{ title: React.ReactNode; rows: [number, string, string][]; hl?: number; scroll?: number }> = ({ title, rows, hl, scroll = 0 }) => (
  <div style={{ width: 640, height: 340, background: C.white, borderRadius: 24, boxShadow: SHADOW, overflow: 'hidden', fontFamily: SANS }}>
    <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '0 22px', borderBottom: `1px solid ${C.line}`, fontSize: 20, fontWeight: 600, color: C.ink2 }}>{title}</div>
    <div style={{ transform: `translateY(${-scroll}px)` }}>
      {rows.map(([n, a, v]) => (
        <div key={n} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 170px', height: 48, alignItems: 'center', borderBottom: '1px solid #f1efec', background: n === hl ? '#fff4cc' : undefined, fontWeight: n === hl ? 600 : 400, fontSize: 21 }}>
          <span style={{ textAlign: 'center', color: C.ink3, fontSize: 17 }}>{n}</span><span>{a}</span><span style={{ fontFamily: MONO, fontSize: 20, textAlign: 'right', paddingRight: 24 }}>{v}</span>
        </div>
      ))}
    </div>
  </div>
);
const Btn: React.FC<{ label: string; down?: boolean }> = ({ label, down }) => (
  <span style={{ padding: '8px 18px', borderRadius: 999, fontSize: 19, fontWeight: 600, background: down ? '#dcd9d4' : C.sand, color: C.ink2, transform: `scale(${down ? 0.95 : 1})`, display: 'inline-block' }}>{label}</span>
);

export const Work: React.FC = () => {
  const f = useCurrentFrame();
  const wall = ramp(f, 0, 30, EASE), win = sp(f, 4, 20, 100);
  const arrive = sp(f, NEW + 4, 18, 120); // the new email slides in and pushes the inbox down
  const opened = f >= CLICK1 + 2, pane = sp(f, CLICK1 + 4, 20, 110);
  const compose = sp(f, OPEN, 20, 110), n = count(rp, f);
  const dig = sp(f, DIG - 4, 22, 110) * (1 - sp(f, DIG_END - 40, 22, 110));
  const pop = sp(f, POP, 18, 140) * (1 - ramp(f, TAB - 30, 10, EXIT));
  const keyOn = f >= TAB - 46 && f < AFTER + 40;
  const ins = f >= TAB, glow = 1 - ramp(f, AFTER, 50);
  const behind = life(f, TAB - 40, AFTER + 4, Q + 4, 18);
  const src = life(f, AFTER + 60, OUT + 20, S, Q);
  const exit = ramp(f, OUT, 50, EXIT);
  const note = sp(f, NEW, 18, 140) * (1 - ramp(f, CLICK1 - 10, 20, EXIT));
  // one cursor for the whole scene
  const cur = glide(f, [[70, 1760, 1000], [CLICK1 - 4, 452, 288], [190, 470, 310], [CLICK2 - 4, 1312, 188], [300, 1520, 330], [DIG + 20, 1400, 900],
    [PICK1 - 4, 1150, 380], [PICK2 - 4, 1150, 504], [DIG_END - 20, 1300, 980], [DIG_END + 40, 1900, 1100]]);
  const pressAt = (at: number) => (f >= at - 3 && f < at + 5 ? Math.sin(((f - at + 3) / 8) * Math.PI) : 0);
  const press = Math.max(pressAt(CLICK1), pressAt(CLICK2), pressAt(PICK1), pressAt(PICK2));
  const showCursor = f > 66 && f < DIG_END + 30;
  const timer = Math.round(interpolate(f, [DIG, DIG_END - 40], [0, 167], clamp) * (1 - ramp(f, DIG_END - 40, 40, EASE)));
  return (
    <AbsoluteFill style={{ background: C.white }}>
      <div style={{ position: 'absolute', inset: 0, opacity: wall * (1 - exit) }}><Wallpaper blur={(1 - wall) * 30} /></div>
      <AbsoluteFill style={{ opacity: 1 - exit, filter: exit > 0.01 ? `blur(${(exit * 18).toFixed(1)}px)` : undefined }}>
        <AbsoluteFill style={{ transformOrigin: '0 0', transform: camera(f, CAM), filter: behind > 0.01 ? `blur(${(behind * 16).toFixed(1)}px)` : undefined, opacity: 1 - behind * 0.25 }}>
          {/* Mail */}
          <div style={{ position: 'absolute', left: WIN.x, top: WIN.y, width: WIN.w, height: WIN.h, borderRadius: 26, background: C.white, boxShadow: SHADOW, overflow: 'hidden', fontFamily: SANS, opacity: Math.min(1, win * 1.4),
            transform: `translateY(${((1 - win) * 60).toFixed(1)}px) translateX(${(-dig * 240).toFixed(1)}px) scale(${(lerp(0.96, 1, win) * (1 - dig * 0.08)).toFixed(4)})`, filter: dig > 0.01 ? `blur(${(dig * 7).toFixed(1)}px)` : undefined }}>
            <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '0 22px', background: '#fbfaf9', borderBottom: `1px solid ${C.line}` }}>
              {['#ff5f57', '#febc2e', '#28c840'].map((c) => <i key={c} style={{ width: 15, height: 15, borderRadius: 8, background: c }} />)}
              <span style={{ marginLeft: 20, fontWeight: 700, fontSize: 21 }}>Inbox</span><span style={{ marginLeft: 10, fontSize: 17, color: C.ink3 }}>{f > NEW ? 6 : 5} messages</span>
            </div>
            {/* the list */}
            <div style={{ position: 'absolute', left: 0, top: 56, width: LIST_W, bottom: 0, borderRight: `1px solid ${C.line}`, background: '#fcfbfa', overflow: 'hidden' }}>
              <div style={{ height: 70, display: 'flex', alignItems: 'center', padding: '0 26px', fontWeight: 700, fontSize: 30, letterSpacing: '-0.02em' }}>Inbox</div>
              <div style={{ transform: `translateY(${((arrive - 1) * ROW).toFixed(1)}px)` }}>
                {INBOX.map((m, i) => {
                  const sel = opened ? i === 0 : false;
                  return (
                    <div key={m.from} style={{ height: ROW, padding: '18px 26px 0 42px', position: 'relative', background: sel ? '#2f7bf0' : undefined, color: sel ? '#fff' : C.ink, borderBottom: `1px solid ${C.line}`, opacity: i === 0 ? Math.min(1, arrive * 1.5) : 1 }}>
                      {m.isNew && !opened && <i style={{ position: 'absolute', left: 16, top: 28, width: 12, height: 12, borderRadius: 6, background: '#2f7bf0' }} />}
                      <div style={{ display: 'flex', fontSize: 21, fontWeight: 700 }}>{m.from}<span style={{ marginLeft: 'auto', fontSize: 16, fontWeight: 500, opacity: 0.7 }}>{m.time}</span></div>
                      <div style={{ fontSize: 19, marginTop: 3, fontWeight: 500 }}>{m.sub}</div>
                      <div style={{ fontSize: 17, marginTop: 3, opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.pre}</div>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* the reading pane */}
            <div style={{ position: 'absolute', left: LIST_W, top: 56, right: 0, bottom: 0 }}>
              <div style={{ height: 60, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, padding: '0 28px', borderBottom: `1px solid ${C.line}` }}>
                <Btn label="↩ Reply" down={f >= CLICK2 - 3 && f < CLICK2 + 6} /><Btn label="↪ Forward" /><Btn label="⌫ Archive" />
              </div>
              {!opened ? (
                <div style={{ position: 'absolute', inset: '60px 0 0 0', display: 'grid', placeItems: 'center', color: C.ink3, fontSize: 22 }}>No message selected</div>
              ) : (
                <div style={{ padding: '40px 52px', opacity: Math.min(1, pane * 1.4), transform: `translateY(${((1 - pane) * 24).toFixed(1)}px)` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                    <span style={{ width: 60, height: 60, borderRadius: 30, background: '#fbe1cb', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 22, color: 'rgba(17,21,17,.7)' }}>JL</span>
                    <div><div style={{ fontSize: 24, fontWeight: 700 }}>Jordan Lee</div><div style={{ fontSize: 18, color: C.ink3 }}>to me · 9:41 AM</div></div>
                  </div>
                  <div style={{ fontSize: 42, fontWeight: 700, letterSpacing: '-0.025em', marginTop: 26 }}>Q4 launch spend</div>
                  <div style={{ fontSize: 31, lineHeight: 1.42, marginTop: 10, maxWidth: 900 }}>Hey — what did we actually spend on the Q4 launch? I can’t find the final number.</div>
                  {/* the reply grows open under the message */}
                  <div style={{ marginTop: 34, height: lerp(0, 230, compose), opacity: Math.min(1, compose * 1.6), borderRadius: 22, border: `1.5px solid ${C.line}`, padding: '22px 34px', overflow: 'visible', position: 'relative' }}>
                    <div style={{ fontSize: 18, color: C.ink3, display: 'flex' }}>↩ To: <b style={{ color: C.ink2, marginLeft: 6 }}>Jordan Lee</b></div>
                    <div style={{ fontSize: 42, fontWeight: 500, letterSpacing: '-0.02em', marginTop: 30, whiteSpace: 'pre' }}>
                      {REPLY_TEXT.slice(0, n)}
                      {ins && (
                        <span style={{ position: 'relative', borderRadius: 6, padding: '0 2px', background: `rgba(41,204,87,${(0.24 * glow).toFixed(3)})`, boxShadow: `inset 0 -4px 0 ${C.green}` }}>$428,750
                          {src > 0.01 && <span style={{ position: 'absolute', left: 0, top: 64, fontFamily: MONO, fontSize: 17, color: C.ink3, opacity: src, whiteSpace: 'nowrap' }}>↳ Q4_Budget_Final.xlsx · Marketing · Row 47</span>}
                        </span>
                      )}
                      {f >= AFTER + 10 ? '.' : ''}
                      <span style={{ position: 'relative' }}>
                        {f >= OPEN + 10 && <Caret blink={f > rp[rp.length - 1] + 6 && f < POP} />}
                        {pop > 0.005 && (
                          <div style={{ position: 'absolute', left: -14, top: 60, transformOrigin: '0 0', transform: `translateY(${((1 - pop) * -14).toFixed(1)}px) scale(${lerp(0.9, 1, pop).toFixed(3)})`, opacity: Math.min(1, pop * 1.5), background: C.white, borderRadius: 22, boxShadow: SHADOW, padding: '18px 22px 16px', whiteSpace: 'nowrap', zIndex: 5 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                              <LassoMark size={30} draw={ramp(f, POP + 6, 30)} />
                              <span style={{ fontWeight: 700, fontSize: 40, letterSpacing: '-0.025em' }}>$428,750</span>
                              <span style={{ marginLeft: 28, fontWeight: 600, fontSize: 17, padding: '5px 11px', borderRadius: 8, background: C.sand, color: C.ink2 }}>tab</span>
                            </div>
                            <div style={{ fontFamily: MONO, fontSize: 18, color: C.ink3, marginTop: 8 }}>Q4_Budget_Final.xlsx · Marketing · Row 47</div>
                          </div>
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          {/* the old way: Finder, the wrong file, the right one */}
          {dig > 0.01 && (
            <>
              <div style={{ position: 'absolute', left: 960, top: 300, opacity: Math.min(1, dig * 1.4), transform: `translateY(${((1 - dig) * 80).toFixed(1)}px) scale(${lerp(0.94, 1, dig).toFixed(3)})` }}>
                <div style={{ width: 760, background: C.white, borderRadius: 24, boxShadow: SHADOW, overflow: 'hidden', fontFamily: SANS }}>
                  <div style={{ height: 58, display: 'flex', alignItems: 'center', padding: '0 22px', borderBottom: `1px solid ${C.line}`, fontSize: 20, fontWeight: 600, color: C.ink2 }}>⌕&nbsp; Budget_Final</div>
                  <FinderRow name="Budget_Final.xlsx" date="Aug 2" on={f >= PICK1 - 2 && f < PICK2 - 2} />
                  <FinderRow name="Budget_Final_v2.xlsx" date="Sep 14" />
                  <FinderRow name="Budget_Final_v3.xlsx" date="Oct 3" on={f >= PICK2 - 2} />
                  <FinderRow name="Budget_Final (1).xlsx" date="Aug 2" />
                  <FinderRow name="FINAL_final_budget.xlsx" date="Jul 21" />
                </div>
              </div>
              <Focus at={PICK1 + 6} out={PICK2 - 6} style={{ position: 'absolute', left: 240, top: 420 }}>
                <Sheet title={<>Budget_Final.xlsx<span style={{ marginLeft: 'auto', color: C.red, background: '#fde6e6', padding: '4px 12px', borderRadius: 999, fontSize: 16 }}>Draft · wrong version</span></>} rows={SHEET_ROWS(20, 6, [23, 'Q4 launch — total', '$391,200'])} hl={23} />
              </Focus>
              <Focus at={PICK2 + 6} out={DIG_END - 30} style={{ position: 'absolute', left: 240, top: 420 }}>
                <Sheet title="Budget_Final_v3.xlsx" rows={SHEET_ROWS(1, 50, [47, 'Q4 launch — total', '$428,750'])} hl={f > PICK2 + 58 ? 47 : undefined} scroll={interpolate(f, [PICK2 + 16, PICK2 + 58], [0, 42 * 48], { ...clamp, easing: EASE })} />
              </Focus>
              <div style={{ position: 'absolute', left: 0, right: 0, top: 200, display: 'flex', justifyContent: 'center', opacity: Math.min(1, dig * 1.4) }}>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '12px 24px', borderRadius: 999, background: 'rgba(10,20,14,.82)', color: '#fff', fontFamily: SANS, fontSize: 24, fontWeight: 600 }}>
                  <span style={{ fontFamily: MONO, fontWeight: 400 }}>{Math.floor(timer / 60)}:{String(timer % 60).padStart(2, '0')}</span><span style={{ opacity: 0.6 }}>4 apps · 5 files</span>
                </div>
              </div>
            </>
          )}
          {showCursor && <Cursor x={cur.x} y={cur.y} vx={cur.v} press={press} scale={1.6} />}
        </AbsoluteFill>
        {/* the macOS notification, in screen space */}
        {note > 0.01 && (
          <div style={{ position: 'absolute', right: 26, top: 26, width: 520, padding: '18px 22px', borderRadius: 22, background: 'rgba(250,250,250,.86)', boxShadow: SHADOW, display: 'flex', gap: 16, fontFamily: SANS, transform: `translateX(${((1 - note) * 560).toFixed(1)}px)` }}>
            <span style={{ width: 54, height: 54, borderRadius: 13, background: 'linear-gradient(#63adff, #2b6df5)', display: 'grid', placeItems: 'center', color: '#fff', fontSize: 28, flex: 'none' }}>✉</span>
            <div style={{ minWidth: 0 }}><div style={{ fontSize: 20, fontWeight: 700 }}>Jordan Lee <span style={{ fontWeight: 400, color: C.ink3, fontSize: 17 }}>· now</span></div><div style={{ fontSize: 19, color: C.ink2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Q4 launch spend — what did we actually spend…</div></div>
          </div>
        )}
        <div style={{ position: 'absolute', left: 0, right: 0, top: 60, zIndex: 20 }}><Words text="Jordan needs a number." start={50} step={7} size={44} color="#fff" accent="#9cf0b6" out={CLICK1 + 50} /></div>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 60, zIndex: 20 }}><Words text="So you go digging." start={DIG + 6} step={7} size={44} color="#fff" accent="#9cf0b6" out={DIG_END} /></div>
        {keyOn && (
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
            <KeyCombo keys={[{ glyph: '⇥', label: 'tab', w: 380 }]} at={TAB - 40} press={TAB} out={AFTER + 8} h={250} />
          </AbsoluteFill>
        )}
        <div style={{ position: 'absolute', left: 0, right: 0, top: 60, zIndex: 20 }}><Words text="Found, sourced, and filled in." start={AFTER + 24} step={7} size={44} color="#fff" accent="#9cf0b6" out={OUT} /></div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
export const workCues: Cue[] = [
  { f: NEW, s: 'notify', v: 0.35 }, { f: CLICK1, s: 'key', v: 0.45 }, { f: CLICK2, s: 'key', v: 0.45 }, ...rp.map((f) => ({ f, s: 'key', v: 0.26 })),
  { f: PICK1, s: 'key', v: 0.4 }, { f: PICK2, s: 'key', v: 0.4 }, { f: TAB, s: 'tab', v: 0.5 },
];

/* ───────────── E · the leap (bars 20–22) ───────────── */
export const LEAP = BAR * 2;
export const Leap: React.FC = () => {
  const f = useCurrentFrame();
  const loop = ramp(f, 150, 34, EASE), b = boilAt(f);
  const gone = ramp(f, LEAP - 22, 20, EXIT);
  return (
    <AbsoluteFill style={{ background: C.white }}>
      <div style={{ position: 'absolute', top: 390, left: 0, right: 0, opacity: 1 - gone, filter: gone > 0.01 ? `blur(${(gone * 16).toFixed(1)}px)` : undefined, transform: `scale(${interpolate(f, [0, LEAP], [1, 1.04], clamp)})` }}>
        <Words text="Autocomplete predicted what you wanted to say." start={20} step={5} size={54} weight={500} color={C.ink3} />
        <div style={{ height: 28 }} />
        <Words text="Lasso *finds* what you need to say." start={104} step={8} size={104} mark={
          <svg width="1" height="1" style={{ position: 'absolute', left: '50%', top: '50%', overflow: 'visible' }}>
            <g>{[...ellipse(26, 4, 178, 80, loop, 4242, b, -0.06, 5), ...curve([[140, 68], [168, 98], [194, 130]], ramp(f, 178, 14), 4243, b, 5)].map((s, i) => <path key={i} d={s.d} fill="none" stroke={C.green} strokeOpacity={s.o} strokeWidth={s.w} strokeLinecap="round" />)}</g>
          </svg>} />
      </div>
    </AbsoluteFill>
  );
};
