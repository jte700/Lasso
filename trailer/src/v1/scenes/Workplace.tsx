import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, SERIF, SANS, MONO, Shot, Caret, Pointer, Win, LassoMark, WALLPAPER, ramp, lerp, clamp, schedule, typedCount, camera, easeInOut, Cue, Key } from '../lib';

export const WORK = 600;
const NOTE = 18, OPEN_MAIL = 46, REPLY = 150;
const REPLY_TEXT = 'The final Q4 spend was ';
const rp = schedule(REPLY_TEXT, 176, 2.3, 'rp');
const TYPED = rp[rp.length - 1];
const OLD = 246, OLD_END = 352; // the old-way montage, then the rewind
const POP = 384, TAB = 444, DOT = TAB + 16;

const CAM: Key[] = [
  [0, 1, 960, 540], [38, 1, 960, 540],
  [92, 1.62, 1215, 436], [140, 1.62, 1215, 446],
  [170, 1.42, 1160, 600], [204, 1.85, 1030, 690], [OLD, 1.85, 1040, 690],
  [POP - 14, 1.85, 1040, 690], [POP + 30, 1.8, 1170, 708], [TAB + 4, 1.82, 1170, 704], [TAB + 40, 2.0, 1040, 690],
  [WORK - 10, 1.38, 1110, 600], [WORK, 1.36, 1100, 596],
];

const MenuBar: React.FC = () => (
  <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 40, display: 'flex', alignItems: 'center', gap: 30, padding: '0 26px', background: 'rgba(255,255,255,.55)', backdropFilter: 'blur(20px)', fontFamily: SANS, fontSize: 19, fontWeight: 500, color: C.ink }}>
    <svg width="16" height="19" viewBox="0 0 16 19"><circle cx="8" cy="11" r="7" fill="#111" /><ellipse cx="10" cy="2.5" rx="2.4" ry="1.4" fill="#111" transform="rotate(-35 10 2.5)" /></svg>
    <b>Mail</b><span>File</span><span>Edit</span><span>View</span><span>Mailbox</span><span>Message</span>
    <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 26 }}><LassoMark size={22} color="#111" /><span>Tue 9:41 AM</span></span>
  </div>
);

const INBOX = [
  { from: 'Jordan Lee', sub: 'Q4 launch spend', pre: 'Hey — what did we actually spend on the…', time: '9:41', isNew: true },
  { from: 'Priya Shah', sub: 'Venue contract (signed)', pre: 'Attached the countersigned copy for…', time: '9:12' },
  { from: 'Marcus Webb', sub: 'Re: Board deck', pre: 'Slide 9 still has the old figures, can…', time: '8:57' },
  { from: 'Design Weekly', sub: 'Issue 214', pre: 'Five type pairings that work in…', time: '8:30' },
  { from: 'Calendar', sub: 'Launch retro moved', pre: 'Thursday 3:00 PM → Friday 11:00 AM', time: 'Mon' },
  { from: 'Ana Ruiz', sub: 'Photos from the event', pre: 'Shared album with 214 photos', time: 'Mon' },
];

const Avatar: React.FC<{ s: string; bg: string; size?: number }> = ({ s, bg, size = 64 }) => (
  <span style={{ width: size, height: size, borderRadius: size / 2, background: bg, display: 'grid', placeItems: 'center', fontFamily: SANS, fontWeight: 700, fontSize: size * 0.36, color: 'rgba(0,0,0,.7)', flex: 'none' }}>{s}</span>
);

/* ── the old way: windows pile up, then rewind ── */
const Sheet: React.FC<{ rows: [string, string, string][]; first: number; hl?: number; scroll?: number; h: number }> = ({ rows, first, hl, scroll = 0, h }) => (
  <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', fontFamily: SANS, fontSize: 21 }}>
    <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 170px 190px', height: 40, background: '#f6f5f3', borderBottom: '1px solid #e7e4e0', color: C.ink3, fontWeight: 600, alignItems: 'center', position: 'relative', zIndex: 2 }}>
      <span /><span style={{ paddingLeft: 12 }}>A</span><span style={{ paddingLeft: 12 }}>B</span><span style={{ paddingLeft: 12 }}>C</span>
    </div>
    <div style={{ transform: `translateY(${-scroll}px)` }}>
      {rows.map(([a, b, c], i) => {
        const n = first + i, on = n === hl;
        return (
          <div key={n} style={{ display: 'grid', gridTemplateColumns: '64px 1fr 170px 190px', height: 42, borderBottom: '1px solid #f0eeeb', alignItems: 'center', background: on ? '#fff4cc' : undefined, fontWeight: on ? 600 : 400 }}>
            <span style={{ textAlign: 'center', color: C.ink3, background: on ? '#f6c445' : '#f6f5f3', height: '100%', display: 'grid', placeItems: 'center', fontSize: 18 }}>{n}</span>
            <span style={{ paddingLeft: 12, whiteSpace: 'nowrap', overflow: 'hidden' }}>{a}</span>
            <span style={{ paddingLeft: 12, color: C.ink2 }}>{b}</span>
            <span style={{ paddingLeft: 12, textAlign: 'right', paddingRight: 16, fontFamily: MONO, fontSize: 19 }}>{c}</span>
          </div>
        );
      })}
    </div>
    <div style={{ height: h }} />
  </div>
);
const LINES = ['Paid social', 'Search ads', 'Launch event', 'Venue deposit', 'Creative agency', 'Print', 'Swag', 'PR retainer', 'Influencers', 'Video shoot', 'Travel', 'Web build'];
const sheetRows = (n0: number, n: number, seed: number): [string, string, string][] =>
  Array.from({ length: n }, (_, i) => {
    const k = n0 + i;
    if (k === 47) return ['Q4 launch — total', 'Marketing', '$428,750'];
    return [LINES[(k * 7 + seed) % LINES.length], ['Marketing', 'Brand', 'Events', 'Growth'][(k + seed) % 4], `$${(((k * 7919 + seed * 31) % 900) * 97 + 4200).toLocaleString('en-US')}`];
  });

const OldWay: React.FC<{ t: number }> = ({ t }) => {
  const { fps } = useVideoConfig();
  const rewind = ramp(t, OLD_END - 26, OLD_END - 4, easeInOut);
  const win = (i: number, at: number, node: React.ReactNode) => {
    if (t < at) return null;
    const s = spring({ frame: t - at, fps, config: { damping: 16, stiffness: 170 } });
    const back = ramp(t, OLD_END - 26 + (3 - i) * 3, OLD_END - 12 + (3 - i) * 3, easeInOut); // rewinds last-in first-out
    const k = s * (1 - back);
    return <div key={i} style={{ position: 'absolute', inset: 0, opacity: Math.min(1, k * 1.4), transform: `scale(${lerp(0.86, 1, k)}) translateY(${(1 - k) * 40}px)`, filter: back > 0.02 ? `blur(${(back * 10).toFixed(2)}px)` : undefined }}>{node}</div>;
  };
  const secs = Math.round(interpolate(t, [OLD, OLD + 82], [0, 167], clamp) * (1 - rewind));
  const chip = ramp(t, OLD, OLD + 10) * (1 - ramp(t, OLD_END - 8, OLD_END));
  const v3scroll = interpolate(t, [OLD + 68, OLD + 92], [0, 34 * 42], { ...clamp, easing: easeInOut });
  return (
    <AbsoluteFill>
      {win(0, OLD + 2, (
        <Win title="Mail — Search" w={800} h={430} x={120} y={150}>
          <div style={{ margin: 22, height: 50, borderRadius: 12, background: '#f4f2ef', display: 'flex', alignItems: 'center', padding: '0 18px', fontFamily: SANS, fontSize: 22, color: C.ink }}>⌕&nbsp;&nbsp;q4 launch budget final</div>
          {['Fwd: Re: Re: budget FINAL', 'Re: Q4 numbers (draft)', 'Budget_Final_v2 attached', 'Re: launch costs?'].map((s, i) => (
            <div key={s} style={{ padding: '14px 28px', borderTop: '1px solid #f0eeeb', fontFamily: SANS, fontSize: 22, color: i === 0 ? C.ink : C.ink2, fontWeight: i === 0 ? 600 : 400 }}>{s}</div>
          ))}
        </Win>
      ))}
      {win(1, OLD + 20, (
        <Win title="Finder — “Budget_Final”" w={820} h={460} x={600} y={140}>
          {['Budget_Final.xlsx', 'Budget_Final_v2.xlsx', 'Budget_Final_v3.xlsx', 'Budget_Final (1).xlsx', 'Q4_Budget_Final.xlsx', 'Budget_Final_OLD.xlsx'].map((s, i) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 26px', height: 58, background: i === (t > OLD + 56 ? 2 : 0) ? '#3b6cf6' : i % 2 ? '#faf9f7' : undefined, color: i === (t > OLD + 56 ? 2 : 0) ? '#fff' : C.ink, fontFamily: SANS, fontSize: 23 }}>
              <span style={{ width: 26, height: 32, borderRadius: 4, background: '#1f9d55', flex: 'none' }} />{s}<span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 19 }}>{['Aug 2', 'Sep 14', 'Oct 3', 'Aug 2', 'Oct 9', 'Jul 21'][i]}</span>
            </div>
          ))}
        </Win>
      ))}
      {win(2, OLD + 38, (
        <Win title="Budget_Final.xlsx" w={820} h={500} x={120} y={470}>
          <Sheet rows={[...sheetRows(18, 6, 3), ['Q4 launch — total', 'Marketing', '$391,200'], ...sheetRows(25, 3, 3)]} first={18} hl={24} h={0} />
          <div style={{ position: 'absolute', right: 26, bottom: 24, padding: '10px 18px', borderRadius: 999, background: C.pinkBg, color: '#c2255c', fontFamily: SANS, fontWeight: 600, fontSize: 21 }}>Draft from August — wrong version</div>
        </Win>
      ))}
      {win(3, OLD + 60, (
        <Win title="Budget_Final_v3.xlsx" w={900} h={540} x={960} y={420}>
          <Sheet rows={sheetRows(1, 54, 5)} first={1} hl={t > OLD + 92 ? 47 : undefined} scroll={v3scroll} h={0} />
        </Win>
      ))}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 54, display: 'flex', justifyContent: 'center', opacity: chip, zIndex: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '14px 26px', borderRadius: 999, background: 'rgba(0,0,0,.82)', color: '#fff', fontFamily: SANS, fontSize: 26, fontWeight: 600 }}>
          <span style={{ opacity: 0.6 }}>The old way</span>
          <span style={{ fontFamily: MONO, fontWeight: 400 }}>{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>
          <span style={{ opacity: 0.6 }}>4 apps · 3 files</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const Workplace: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const n = typedCount(rp, f);
  const note = spring({ frame: f - NOTE, fps, config: { damping: 18, stiffness: 140 } }) * (1 - ramp(f, 86, 100));
  const opened = f >= OPEN_MAIL;
  const replyIn = ramp(f, REPLY + 4, REPLY + 18);
  const old = ramp(f, OLD - 2, OLD + 10) * (1 - ramp(f, OLD_END - 22, OLD_END - 2, easeInOut));
  const pop = ramp(f, POP, POP + 12) * (1 - ramp(f, TAB, TAB + 7));
  const ins = f >= TAB;
  const glow = 1 - ramp(f, TAB + 4, TAB + 50);
  const tabP = f >= TAB && f < TAB + 6;
  // the pointer: clicks the new message, then Reply, then rests out of the way
  const p1 = ramp(f, 24, OPEN_MAIL - 2, easeInOut), p2 = ramp(f, 112, REPLY - 2, easeInOut), p3 = ramp(f, REPLY + 8, REPLY + 30, easeInOut);
  const px = lerp(lerp(lerp(1500, 430, p1), 1400, p2), 1820, p3), py = lerp(lerp(lerp(900, 262, p1), 180, p2), 1000, p3);
  const press = (f >= OPEN_MAIL - 2 && f < OPEN_MAIL + 2) || (f >= REPLY - 2 && f < REPLY + 2) ? 1 : 0;
  return (
    <Shot dur={WORK} bg="#efe9e2" outF={18}>
      <AbsoluteFill style={{ filter: old > 0.01 ? `blur(${(old * 7).toFixed(2)}px) saturate(${1 - old * 0.4})` : undefined }}>
        <AbsoluteFill style={{ transformOrigin: '0 0', transform: camera(f, CAM) }}>
          <AbsoluteFill style={{ background: WALLPAPER }} />
          <MenuBar />
          <Win title="Inbox" w={1640} h={920} x={140} y={92}>
            <div style={{ display: 'flex', height: '100%' }}>
              {/* message list */}
              <div style={{ width: 500, borderRight: '1px solid #edebe8', background: '#fcfbfa', overflow: 'hidden' }}>
                <div style={{ height: 70, display: 'flex', alignItems: 'center', padding: '0 28px', fontFamily: SERIF, fontWeight: 600, fontSize: 30 }}>Inbox <span style={{ marginLeft: 12, fontFamily: SANS, fontSize: 18, color: C.ink3, fontWeight: 500 }}>{f >= NOTE ? 6 : 5} messages</span></div>
                <div style={{ transform: `translateY(${f >= NOTE ? lerp(-118, 0, ramp(f, NOTE, NOTE + 14)) : -118}px)` }}>
                  {INBOX.map((m, i) => {
                    const sel = opened ? i === 0 : i === 2;
                    return (
                      <div key={m.from} style={{ height: 118, padding: '18px 28px 0 44px', position: 'relative', background: sel ? '#3b6cf6' : undefined, color: sel ? '#fff' : C.ink, fontFamily: SANS, borderBottom: '1px solid #f0eeeb', opacity: i === 0 && f < NOTE ? 0 : 1 }}>
                        {m.isNew && !opened && <i style={{ position: 'absolute', left: 18, top: 28, width: 12, height: 12, borderRadius: 6, background: '#3b6cf6' }} />}
                        <div style={{ display: 'flex', fontSize: 22, fontWeight: 700 }}>{m.from}<span style={{ marginLeft: 'auto', fontSize: 17, fontWeight: 500, opacity: 0.7 }}>{m.time}</span></div>
                        <div style={{ fontSize: 20, marginTop: 4, fontWeight: 500 }}>{m.sub}</div>
                        <div style={{ fontSize: 18, marginTop: 4, opacity: 0.65, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.pre}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* reading pane */}
              <div style={{ flex: 1, position: 'relative', fontFamily: SANS }}>
                <div style={{ height: 70, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 14, padding: '0 30px', borderBottom: '1px solid #f0eeeb' }}>
                  {['↩ Reply', '↪ Forward', '⌫ Archive'].map((b, i) => (
                    <span key={b} style={{ padding: '8px 18px', borderRadius: 999, fontSize: 19, fontWeight: 600, background: i === 0 && f >= REPLY - 2 && f < REPLY + 6 ? '#e3e0dc' : '#f4f2ef', color: C.ink2 }}>{b}</span>
                  ))}
                </div>
                {opened ? (
                  <div style={{ padding: '44px 60px', opacity: ramp(f, OPEN_MAIL, OPEN_MAIL + 8) }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                      <Avatar s="JL" bg="#fbe1cb" />
                      <div><div style={{ fontSize: 25, fontWeight: 700 }}>Jordan Lee</div><div style={{ fontSize: 19, color: C.ink3, marginTop: 2 }}>to me · 9:41 AM</div></div>
                    </div>
                    <div style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 42, marginTop: 30, letterSpacing: '-0.01em' }}>Q4 launch spend</div>
                    <div style={{ fontSize: 33, lineHeight: 1.45, marginTop: 16, color: C.ink, maxWidth: 1000 }}>Hey — what did we actually spend on the Q4 launch? I can’t find the final number.</div>
                    {/* the reply */}
                    <div style={{ marginTop: 44, borderRadius: 18, border: '1.5px solid #e7e4e0', background: C.white, padding: '22px 30px 30px', opacity: replyIn, transform: `translateY(${(1 - replyIn) * 16}px)`, boxShadow: '0 14px 40px rgba(0,0,0,.05)', height: 250 }}>
                      <div style={{ fontSize: 19, color: C.ink3, display: 'flex', gap: 10 }}>↩ <span>To: <b style={{ color: C.ink2 }}>Jordan Lee</b></span><span style={{ marginLeft: 'auto' }}>Re: Q4 launch spend</span></div>
                      <div style={{ fontSize: 40, fontWeight: 500, marginTop: 34, color: C.ink, whiteSpace: 'pre', letterSpacing: '-0.005em' }}>
                        {REPLY_TEXT.slice(0, n)}
                        {ins && (
                          <span style={{ background: `rgba(41,204,87,${(0.22 * glow).toFixed(3)})`, borderRadius: 6, boxShadow: `inset 0 -3px 0 rgba(41,204,87,${(0.25 + 0.75 * ramp(f, TAB + 10, TAB + 40)).toFixed(3)})`, padding: '0 2px' }}>$428,750</span>
                        )}
                        {f >= DOT ? '.' : ''}
                        <span style={{ position: 'relative' }}>
                          {f > REPLY + 18 && <Caret color={C.ink} on={f < TYPED + 4} />}
                          {pop > 0.005 && (
                            <div style={{ position: 'absolute', left: ins ? -150 : -6, top: 66, opacity: pop, transform: `translateY(${((1 - pop) * (ins ? -20 : 10)).toFixed(2)}px) scale(${lerp(ins ? 0.9 : 0.97, 1, pop).toFixed(3)})`, transformOrigin: '0 0', whiteSpace: 'nowrap',
                              background: C.white, borderRadius: 18, boxShadow: '0 0 0 1px rgba(0,0,0,.07), 0 18px 50px rgba(0,0,0,.12)', padding: '18px 22px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                                <LassoMark size={30} />
                                <span style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 40, letterSpacing: '-0.01em' }}>$428,750</span>
                                <span style={{ marginLeft: 26, fontFamily: SANS, fontSize: 17, fontWeight: 600, padding: '5px 11px', borderRadius: 8, background: tabP ? C.green : '#f4f2ef', color: tabP ? '#fff' : C.ink2 }}>Tab</span>
                              </div>
                              <div style={{ fontFamily: MONO, fontSize: 19, color: C.ink3 }}>Q4_Budget_Final.xlsx · Marketing · Row 47</div>
                            </div>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: '44px 60px', color: C.ink }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                      <Avatar s="MW" bg="#dfe8fb" />
                      <div><div style={{ fontSize: 25, fontWeight: 700 }}>Marcus Webb</div><div style={{ fontSize: 19, color: C.ink3, marginTop: 2 }}>to me · 8:57 AM</div></div>
                    </div>
                    <div style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 42, marginTop: 30 }}>Re: Board deck</div>
                    <div style={{ fontSize: 33, lineHeight: 1.45, marginTop: 16, color: C.ink2, maxWidth: 1000 }}>Slide 9 still has the old figures, can you swap in the final ones before Thursday?</div>
                  </div>
                )}
              </div>
            </div>
          </Win>
          <Pointer x={px} y={py} press={press} scale={1.4} />
        </AbsoluteFill>
        {/* notification banner (screen space) */}
        {note > 0.01 && (
          <div style={{ position: 'absolute', right: 30, top: 58, width: 520, padding: '18px 22px', borderRadius: 22, background: 'rgba(255,255,255,.86)', boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 20px 50px rgba(0,0,0,.14)', display: 'flex', gap: 16, fontFamily: SANS, transform: `translateX(${((1 - note) * 560).toFixed(1)}px)` }}>
            <span style={{ width: 52, height: 52, borderRadius: 13, background: 'linear-gradient(#5aa7ff, #2b6df5)', display: 'grid', placeItems: 'center', color: '#fff', fontSize: 28, flex: 'none' }}>✉</span>
            <div style={{ minWidth: 0 }}><div style={{ fontSize: 20, fontWeight: 700 }}>Jordan Lee <span style={{ fontWeight: 400, color: C.ink3, fontSize: 17 }}>· now</span></div><div style={{ fontSize: 19, fontWeight: 600, marginTop: 2 }}>Q4 launch spend</div><div style={{ fontSize: 18, color: C.ink2, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Hey — what did we actually spend on the Q4…</div></div>
          </div>
        )}
      </AbsoluteFill>
      {old > 0.001 && <AbsoluteFill style={{ background: `rgba(239,233,226,${(old * 0.35).toFixed(3)})` }} />}
      {f >= OLD && f < OLD_END && <OldWay t={f} />}
    </Shot>
  );
};

export const workCues: Cue[] = [
  { f: NOTE, s: 'notify', v: 0.6 },
  { f: OPEN_MAIL - 2, s: 'key', v: 0.45 }, { f: REPLY - 2, s: 'key', v: 0.45 },
  ...rp.map((f) => ({ f, s: 'key', v: 0.8 })),
  { f: OLD - 4, s: 'whoosh', v: 0.35 },
  { f: OLD + 2, s: 'key', v: 0.35 }, { f: OLD + 20, s: 'key', v: 0.35 }, { f: OLD + 38, s: 'key', v: 0.35 }, { f: OLD + 60, s: 'key', v: 0.35 },
  { f: OLD_END - 30, s: 'whoosh', v: 0.45 },
  { f: TAB, s: 'tab', v: 0.75 }, { f: TAB + 3, s: 'chime', v: 0.45 }, { f: DOT, s: 'key', v: 0.6 },
];
