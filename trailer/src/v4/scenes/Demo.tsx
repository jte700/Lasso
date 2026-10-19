import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { C, SANS, MONO, BAR, Pill, LassoCard, KeyCombo, Cursor, Caret, Focus, smoothCam, sp, glide, ramp, lerp, life, clamp, typing, count, EASE, EXIT, Q, SHADOW } from '../kit';
import type { CamKey } from '../kit';
import type { Cue } from '../../v2/cues';

/* ───────────── 0:17–0:33 · the email ───────────── */
export const DEMO = BAR * 8; // 960 frames; the last 80 hand off to "Lasso finds" with a camera pan
export const PAN = 80;
const NEW = 30, CLICK1 = 108, CLICK2 = 230, OPEN = 234;
const REPLY_TEXT = 'The final Q4 spend was ';
const rp = typing(REPLY_TEXT, 252, 2.2, 'rp');
const DIG = 330, PICK1 = 418, PICK2 = 480, DIG_END = 580;
const POP = 650, TAB = 780, AFTER = TAB + 26, LEAVE = DEMO - PAN;
const WIN = { x: 210, y: 110, w: 1500, h: 860 }, LIST_W = 480, ROW = 108;
const CAM: CamKey[] = [
  [0, 1, 960, 540], [52, 1, 960, 540], [CLICK1 - 2, 1.8, 470, 300], [CLICK1 + 10, 1.8, 470, 300], [CLICK1 + 52, 1, 960, 540],
  [172, 1, 960, 540], [204, 1.42, 1190, 430], [216, 1.42, 1200, 420], [CLICK2 - 2, 1.75, 1340, 240], [CLICK2 + 6, 1.75, 1340, 240],
  [OPEN + 32, 1.34, 1190, 640], [300, 1.6, 1130, 760], [DIG - 6, 1.6, 1130, 760], [DIG + 36, 1, 960, 540], [DIG_END - 30, 1, 960, 540],
  [DIG_END + 30, 1.55, 1130, 770], [POP + 40, 1.28, 1170, 860], [TAB + 10, 1.28, 1170, 860], [AFTER + 30, 1.5, 1110, 760], [LEAVE, 1.04, 960, 560], [DEMO, 1.0, 960, 560],
];
const INBOX = [
  { from: 'Jordan Lee', sub: 'Q4 launch spend', pre: 'Hey — what did we actually spend…', time: '9:41' },
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
const rowsOf = (a: number, n: number, special: [number, string, string]): [number, string, string][] => Array.from({ length: n }, (_, i) => { const k = a + i; if (k === special[0]) return special; return [k, ['Paid social', 'Search ads', 'Venue deposit', 'Creative agency', 'Print', 'Swag', 'PR retainer'][k % 7], `$${(((k * 7919) % 900) * 97 + 4200).toLocaleString('en-US')}`]; });
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
  <span style={{ padding: '8px 18px', borderRadius: 999, fontSize: 19, fontWeight: 600, background: down ? '#dcd9d4' : C.sand, color: C.ink2, transform: `scale(${down ? 0.94 : 1})`, display: 'inline-block' }}>{label}</span>
);

/** the hand-off: the cursor glides right, the camera follows, and the next scene slides in from the right */
export const panU = (f: number) => interpolate(f, [0, PAN], [0, 1], { ...clamp, easing: EASE });
export const HANDOFF_CURSOR = { x: 1480, y: 600 };

export const Demo: React.FC = () => {
  const f = useCurrentFrame();
  const cam = smoothCam(f, CAM);
  const win = sp(f, 2, 20, 100), arrive = sp(f, NEW + 4, 18, 120);
  const opened = f >= CLICK1 + 2, pane = sp(f, CLICK1 + 4, 20, 110);
  const compose = sp(f, OPEN, 20, 110), n = count(rp, f);
  const dig = sp(f, DIG - 4, 22, 110) * (1 - sp(f, DIG_END - 40, 22, 110));
  const pop = sp(f, POP, 18, 120) * (1 - ramp(f, TAB - 24, 10, EXIT));
  const keyOn = f >= TAB - 46 && f < AFTER + 34;
  const ins = f >= TAB, glow = 1 - ramp(f, AFTER, 50);
  const behind = life(f, TAB - 40, AFTER + 2, Q + 4, 18);
  const src = life(f, AFTER + 40, DEMO + 20, 24, Q);
  const note = sp(f, NEW, 18, 140) * (1 - ramp(f, CLICK1 - 10, 20, EXIT));
  const pan = panU(f - LEAVE);
  // one cursor for the whole scene (stage coordinates until the hand-off, then screen)
  const cur = glide(f, [[52, 1760, 1000], [CLICK1 - 4, 452, 288], [150, 480, 330], [CLICK2 - 4, 1312, 188], [262, 1500, 330], [DIG + 24, 1400, 900],
    [PICK1 - 4, 1150, 380], [PICK2 - 4, 1150, 504], [DIG_END - 30, 1300, 980], [DIG_END + 10, 1900, 1120]]);
  const pressAt = (at: number) => (f >= at - 3 && f < at + 5 ? Math.sin(((f - at + 3) / 8) * Math.PI) : 0);
  const press = Math.max(pressAt(CLICK1), pressAt(CLICK2), pressAt(PICK1), pressAt(PICK2));
  const lead = glide(f, [[LEAVE - 40, 1180, 980], [LEAVE + 10, 1000, 640], [DEMO, HANDOFF_CURSOR.x, HANDOFF_CURSOR.y]]);
  const timer = Math.round(interpolate(f, [DIG, DIG_END - 40], [0, 167], clamp) * (1 - ramp(f, DIG_END - 40, 40, EASE)));
  return (
    <AbsoluteFill style={{ transform: `translateX(${(-pan * 1920).toFixed(1)}px)` }}>
      <AbsoluteFill style={{ transformOrigin: '0 0', transform: cam.css, filter: behind > 0.01 ? `blur(${(behind * 16).toFixed(1)}px)` : undefined, opacity: 1 - behind * 0.2 }}>
        {/* Mail */}
        <div style={{ position: 'absolute', left: WIN.x, top: WIN.y, width: WIN.w, height: WIN.h, borderRadius: 26, background: C.white, boxShadow: SHADOW, overflow: 'visible', fontFamily: SANS, opacity: Math.min(1, win * 1.4),
          transform: `translateY(${((1 - win) * 70).toFixed(1)}px) translateX(${(-dig * 240).toFixed(1)}px) scale(${(lerp(0.95, 1, win) * (1 - dig * 0.08)).toFixed(4)})`, filter: dig > 0.01 ? `blur(${(dig * 7).toFixed(1)}px)` : undefined }}>
          <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '0 22px', background: '#fbfaf9', borderBottom: `1px solid ${C.line}`, borderRadius: '26px 26px 0 0' }}>
            {['#ff5f57', '#febc2e', '#28c840'].map((c) => <i key={c} style={{ width: 15, height: 15, borderRadius: 8, background: c }} />)}
            <span style={{ marginLeft: 20, fontWeight: 700, fontSize: 21 }}>Inbox</span><span style={{ marginLeft: 10, fontSize: 17, color: C.ink3 }}>{f > NEW ? 6 : 5} messages</span>
          </div>
          <div style={{ position: 'absolute', left: 0, top: 56, width: LIST_W, bottom: 0, borderRight: `1px solid ${C.line}`, background: '#fcfbfa', overflow: 'hidden', borderRadius: '0 0 0 26px' }}>
            <div style={{ height: 70, display: 'flex', alignItems: 'center', padding: '0 26px', fontWeight: 700, fontSize: 30, letterSpacing: '-0.02em' }}>Inbox</div>
            <div style={{ transform: `translateY(${((arrive - 1) * ROW).toFixed(1)}px)` }}>
              {INBOX.map((m, i) => {
                const sel = opened && i === 0;
                return (
                  <div key={m.from} style={{ height: ROW, padding: '18px 26px 0 42px', position: 'relative', background: sel ? '#2f7bf0' : undefined, color: sel ? '#fff' : C.ink, borderBottom: `1px solid ${C.line}`, opacity: i === 0 ? Math.min(1, arrive * 1.5) : 1 }}>
                    {i === 0 && !opened && <i style={{ position: 'absolute', left: 16, top: 28, width: 12, height: 12, borderRadius: 6, background: '#2f7bf0' }} />}
                    <div style={{ display: 'flex', fontSize: 21, fontWeight: 700 }}>{m.from}<span style={{ marginLeft: 'auto', fontSize: 16, fontWeight: 500, opacity: 0.7 }}>{m.time}</span></div>
                    <div style={{ fontSize: 19, marginTop: 3, fontWeight: 500 }}>{m.sub}</div>
                    <div style={{ fontSize: 17, marginTop: 3, opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.pre}</div>
                  </div>
                );
              })}
            </div>
          </div>
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
                <div style={{ marginTop: 34, height: lerp(0, 230, compose), opacity: Math.min(1, compose * 1.6), borderRadius: 22, border: `1.5px solid ${C.line}`, padding: '22px 34px', position: 'relative' }}>
                  <div style={{ fontSize: 18, color: C.ink3, display: 'flex' }}>↩ To: <b style={{ color: C.ink2, marginLeft: 6 }}>Jordan Lee</b></div>
                  <div style={{ fontSize: 42, fontWeight: 500, letterSpacing: '-0.02em', marginTop: 30, whiteSpace: 'pre' }}>
                    {REPLY_TEXT.slice(0, n)}
                    {ins && (
                      <span style={{ position: 'relative', borderRadius: 6, padding: '0 2px', background: `rgba(41,204,87,${(0.24 * glow).toFixed(3)})`, boxShadow: `inset 0 -4px 0 ${C.green}` }}>$428,750
                        {src > 0.01 && <span style={{ position: 'absolute', left: 0, top: 64, fontFamily: MONO, fontSize: 17, color: C.ink3, opacity: src, whiteSpace: 'nowrap' }}>↳ Q4_Budget_Final.xlsx · Row 47</span>}
                      </span>
                    )}
                    {f >= AFTER + 8 ? '.' : ''}
                    <span style={{ position: 'relative' }}>
                      {f >= OPEN + 10 && <Caret blink={f > rp[rp.length - 1] + 6 && f < POP} />}
                      {pop > 0.005 && <div style={{ position: 'absolute', left: -14, top: 60, zIndex: 5 }}><LassoCard show={pop} tab={f >= TAB - 2} /></div>}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
        {/* the old way */}
        {dig > 0.01 && (
          <>
            <div style={{ position: 'absolute', left: 960, top: 300, opacity: Math.min(1, dig * 1.4), transform: `translateY(${((1 - dig) * 90).toFixed(1)}px) scale(${lerp(0.94, 1, dig).toFixed(3)})` }}>
              <div style={{ width: 760, background: C.white, borderRadius: 24, boxShadow: SHADOW, overflow: 'hidden', fontFamily: SANS }}>
                <div style={{ height: 58, display: 'flex', alignItems: 'center', padding: '0 22px', borderBottom: `1px solid ${C.line}`, fontSize: 20, fontWeight: 600, color: C.ink2 }}>⌕&nbsp; Budget_Final</div>
                <FinderRow name="Budget_Final.xlsx" date="Aug 2" on={f >= PICK1 - 2 && f < PICK2 - 2} />
                <FinderRow name="Budget_Final_v2.xlsx" date="Sep 14" />
                <FinderRow name="Budget_Final_v3.xlsx" date="Oct 3" on={f >= PICK2 - 2} />
                <FinderRow name="Budget_Final (1).xlsx" date="Aug 2" />
                <FinderRow name="FINAL_final_budget.xlsx" date="Jul 21" />
              </div>
            </div>
            <Focus at={PICK1 + 4} out={PICK2 - 4} style={{ position: 'absolute', left: 240, top: 420 }}>
              <Sheet title={<>Budget_Final.xlsx<span style={{ marginLeft: 'auto', color: C.red, background: '#fde6e6', padding: '4px 12px', borderRadius: 999, fontSize: 16 }}>Draft · wrong version</span></>} rows={rowsOf(20, 6, [23, 'Q4 launch — total', '$391,200'])} hl={23} />
            </Focus>
            <Focus at={PICK2 + 4} out={DIG_END - 34} style={{ position: 'absolute', left: 240, top: 420 }}>
              <Sheet title="Budget_Final_v3.xlsx" rows={rowsOf(1, 50, [47, 'Q4 launch — total', '$428,750'])} hl={f > PICK2 + 50 ? 47 : undefined} scroll={interpolate(f, [PICK2 + 12, PICK2 + 50], [0, 42 * 48], { ...clamp, easing: EASE })} />
            </Focus>
            <div style={{ position: 'absolute', left: 0, right: 0, top: 210, display: 'flex', justifyContent: 'center', opacity: Math.min(1, dig * 1.4) }}>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '12px 24px', borderRadius: 999, background: 'rgba(10,20,14,.82)', color: '#fff', fontFamily: SANS, fontSize: 24, fontWeight: 600 }}>
                <span style={{ fontFamily: MONO, fontWeight: 400 }}>{Math.floor(timer / 60)}:{String(timer % 60).padStart(2, '0')}</span><span style={{ opacity: 0.6 }}>4 apps · 5 files</span>
              </div>
            </div>
          </>
        )}
        {f > 48 && f < DIG_END + 10 && <Cursor x={cur.x} y={cur.y} vx={cur.v} press={press} scale={1.6} />}
      </AbsoluteFill>
      {/* screen space: notification, captions, the Tab key, the cursor that leads out */}
      {note > 0.01 && (
        <div style={{ position: 'absolute', right: 26, top: 26, width: 520, padding: '18px 22px', borderRadius: 22, background: 'rgba(250,250,250,.9)', boxShadow: SHADOW, display: 'flex', gap: 16, fontFamily: SANS, transform: `translateX(${((1 - note) * 560).toFixed(1)}px)` }}>
          <span style={{ width: 54, height: 54, borderRadius: 13, background: 'linear-gradient(#63adff, #2b6df5)', display: 'grid', placeItems: 'center', color: '#fff', fontSize: 28, flex: 'none' }}>✉</span>
          <div style={{ minWidth: 0 }}><div style={{ fontSize: 20, fontWeight: 700 }}>Jordan Lee <span style={{ fontWeight: 400, color: C.ink3, fontSize: 17 }}>· now</span></div><div style={{ fontSize: 19, color: C.ink2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Q4 launch spend — what did we actually spend…</div></div>
        </div>
      )}
      <Pill parts={[{ text: 'Jordan needs', at: 40 }, { text: 'a number.', at: 96 }]} out={CLICK1 + 60} />
      <Pill parts={[{ text: 'The old way:', at: DIG + 6 }, { text: 'search,', at: DIG + 50 }, { text: 'open,', at: PICK1 - 4 }, { text: 'wrong file,', at: PICK1 + 30 }, { text: 'again.', at: PICK2 }]} out={DIG_END - 10} />
      <Pill parts={[{ text: 'With Lasso,', at: DIG_END + 24 }, { text: 'just press tab.', at: TAB - 60 }]} out={TAB + 6} />
      {keyOn && (
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
          <KeyCombo keys={[{ glyph: '⇥', label: 'tab', w: 380 }]} at={TAB - 40} press={TAB} out={AFTER + 14} h={250} />
        </AbsoluteFill>
      )}
      <Pill parts={[{ text: 'Found.', at: AFTER + 14 }, { text: 'Sourced.', at: AFTER + 34 }, { text: 'Filled in.', at: AFTER + 54 }]} out={LEAVE + 30} />
      {f > LEAVE - 40 && <Cursor x={lead.x + pan * 1920} y={lead.y} vx={lead.v} scale={1.6} />}
    </AbsoluteFill>
  );
};
export const demoCues: Cue[] = [
  { f: NEW, s: 'notify', v: 0.35 }, { f: CLICK1, s: 'key', v: 0.45 }, { f: CLICK2, s: 'key', v: 0.45 }, ...rp.map((f) => ({ f, s: 'key', v: 0.24 })),
  { f: PICK1, s: 'key', v: 0.4 }, { f: PICK2, s: 'key', v: 0.4 }, { f: TAB, s: 'tab', v: 0.5 },
];
