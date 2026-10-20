import React from 'react';
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from 'remotion';
import { C, SANS, MONO, BAR, Pill, LassoMark, KeyCombo, Cursor, Focus, sp, glide, ramp, lerp, clamp, EASE, EXIT, SHADOW, SHADOW_SM } from '../kit';
import type { Cue } from '../../v2/cues';

/* ───────────── 0:36–0:46 · four quick beats, one shortcut each ───────────── */
export const FEAT = BAR * 5; // 600
const B = 150, END = 166; // each beat runs 150 frames and overlaps the next by 16 while it blurs away
const press = (f: number, at: number) => (f >= at - 3 && f < at + 5 ? Math.sin(((f - at + 3) / 8) * Math.PI) : 0);
const DOCK = { y: -400, scale: 0.42 };

/* 1 · ↑↓ another source */
const SOURCES: [string, string, string][] = [
  ['$428,750', 'Q4_Budget_Final.xlsx · Row 47', 'final'],
  ['$428,750', 'Board_Deck_v9.key · Slide 12', 'matches'],
  ['$430,000', 'Launch_Recap.pdf · p. 3', 'estimate'],
];
const Arrows: React.FC = () => {
  const t = useCurrentFrame();
  const sel = t < 76 ? 0 : t < 104 ? 1 : 2;
  return (
    <>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}><KeyCombo keys={[{ big: '↑', w: 200 }, { big: '↓', w: 200 }]} at={2} press={30} out={END} h={200} dock={{ at: 42, ...DOCK }} /></AbsoluteFill>
      <Pill parts={[{ text: 'Every source,', at: 46 }, { text: 'one arrow away.', at: 92 }]} out={B + 8} top={210} />
      <Focus at={44} out={END} style={{ position: 'absolute', left: 460, top: 330 }}>
        <div style={{ position: 'relative', width: 1000, background: C.white, borderRadius: 30, boxShadow: SHADOW, padding: 18, fontFamily: SANS }}>
          <div style={{ position: 'absolute', left: 18, right: 18, top: 18 + lerp(0, 94, sp(t, 74, 18, 200)) + lerp(0, 94, sp(t, 102, 18, 200)), height: 94, borderRadius: 20, background: C.greenBg, boxShadow: `inset 0 0 0 2px ${C.green}` }} />
          {SOURCES.map(([v, s, tag], i) => (
            <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 20, height: 94, padding: '0 24px' }}>
              <LassoMark size={34} color={i === sel ? C.greenD : C.ink3} />
              <span style={{ fontWeight: 700, fontSize: 42, letterSpacing: '-0.025em', width: 220 }}>{v}</span>
              <span style={{ fontFamily: MONO, fontSize: 21, color: C.ink2 }}>{s}</span>
              <span style={{ marginLeft: 'auto', fontSize: 18, fontWeight: 600, padding: '5px 12px', borderRadius: 999, background: tag === 'final' ? C.green : C.sand, color: tag === 'final' ? '#fff' : C.ink2 }}>{tag}</span>
            </div>
          ))}
        </div>
      </Focus>
    </>
  );
};

/* 2 · ⌘↵ inserts with its source; click to trace it */
const Trace: React.FC = () => {
  const t = useCurrentFrame();
  const CLICK = 96;
  const cur = glide(t, [[50, 1700, 1000], [CLICK - 4, 1010, 492], [END, 1060, 520]]);
  const peek = sp(t, CLICK + 2, 18, 140);
  return (
    <>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}><KeyCombo keys={[{ glyph: '⌘', label: 'command', w: 240 }, { big: '↵', w: 200 }]} at={2} press={30} out={END} h={200} dock={{ at: 42, ...DOCK }} /></AbsoluteFill>
      <Pill parts={[{ text: 'Click any value', at: 50 }, { text: 'to see its source.', at: CLICK + 6 }]} out={B + 8} top={210} />
      <Focus at={44} out={END} style={{ position: 'absolute', left: 360, top: 380 }}>
        <div style={{ width: 1200, background: C.white, borderRadius: 30, boxShadow: SHADOW, padding: '40px 50px', fontFamily: SANS, fontSize: 50, fontWeight: 500, letterSpacing: '-0.02em', whiteSpace: 'pre' }}>
          The final Q4 spend was <span style={{ position: 'relative', boxShadow: `inset 0 -5px 0 ${C.green}`, background: t > CLICK ? 'rgba(41,204,87,.16)' : undefined, borderRadius: 6, padding: '0 3px' }}>$428,750</span>.
        </div>
        {peek > 0.01 && (
          <div style={{ position: 'absolute', left: 560, top: 150, width: 600, opacity: Math.min(1, peek * 1.4), transformOrigin: '20% 0', transform: `translateY(${((1 - peek) * 18).toFixed(1)}px) scale(${lerp(0.92, 1, peek).toFixed(3)})`, background: C.white, borderRadius: 24, boxShadow: SHADOW, overflow: 'hidden', fontFamily: SANS }}>
            <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 10, padding: '0 22px', borderBottom: `1px solid ${C.line}`, fontSize: 19, fontWeight: 600, color: C.ink2 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: C.greenD }} />Q4_Budget_Final.xlsx · Marketing</div>
            {[[46, 'Paid social', '$96,350'], [47, 'Q4 launch — total', '$428,750'], [48, 'Brand refresh', '$54,900']].map(([n, a, v]) => (
              <div key={n} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 160px', height: 52, alignItems: 'center', borderBottom: '1px solid #f1efec', background: n === 47 ? '#fff4cc' : undefined, fontWeight: n === 47 ? 600 : 400, fontSize: 21 }}>
                <span style={{ textAlign: 'center', color: C.ink3, fontSize: 17 }}>{n}</span><span>{a}</span><span style={{ fontFamily: MONO, fontSize: 20, textAlign: 'right', paddingRight: 22 }}>{v}</span>
              </div>
            ))}
          </div>
        )}
      </Focus>
      {t > 50 && t < END - 6 && <Cursor x={cur.x} y={cur.y} vx={cur.v} hand={t > CLICK - 24} press={press(t, CLICK)} scale={1.6} />}
    </>
  );
};

/* 3 · the same move in other work: the camera follows the cursor across three windows */
const Plan = () => (
  <svg viewBox="0 0 480 280" width="100%" height="100%" style={{ fontFamily: MONO }}>
    <rect x="20" y="20" width="440" height="240" fill="#fbfaf8" stroke="#2b2622" strokeWidth="5" />
    <path d="M190 20V150M20 150H300M300 20V260M380 150V260" stroke="#2b2622" strokeWidth="3.5" fill="none" />
    <rect x="300" y="20" width="160" height="130" fill="rgba(41,204,87,.22)" stroke={C.green} strokeWidth="4" />
    <text x="380" y="80" textAnchor="middle" fontSize="15" fontWeight="600" fill="#2b2622">KITCHEN</text>
    <text x="380" y="104" textAnchor="middle" fontSize="17" fontWeight="600" fill={C.greenD}>14.62 m²</text>
  </svg>
);
const Lease = () => (
  <div style={{ padding: '26px 30px', fontSize: 21, lineHeight: 1.5, color: C.ink2 }}>
    <div style={{ fontWeight: 700, fontSize: 24, color: C.ink }}>12. Termination</div>
    <div style={{ marginTop: 14, padding: '6px 8px', borderRadius: 8, background: 'rgba(246,196,69,.45)', color: C.ink }}>Either party may end this lease on <b>six (6) months’</b> written notice.</div>
    <div style={{ marginTop: 18, display: 'inline-block', fontWeight: 700, fontSize: 17, color: C.greenD, background: C.greenBg, padding: '5px 12px', borderRadius: 999 }}>✓ Signed copy</div>
  </div>
);
const Table = () => (
  <div style={{ padding: '22px 26px', fontSize: 21 }}>
    <div style={{ fontWeight: 700, fontSize: 22 }}>Table 2. Outcomes</div>
    {[['Mortality', '0.81'], ['Primary endpoint', '0.72'], ['Hospitalisation', '0.88']].map((r, i) => (
      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px', padding: '12px 10px', borderTop: `1px solid ${C.line}`, fontWeight: i === 1 ? 600 : 400, background: i === 1 ? 'rgba(41,204,87,.2)' : undefined, borderRadius: 8 }}>
        <span>{r[0]}</span><span style={{ fontFamily: MONO }}>{r[1]}</span>
      </div>
    ))}
  </div>
);
const WORKS = [
  { title: 'A-201_FloorPlan.pdf', label: 'Floor plans.', sentence: 'The kitchen is', value: '14.62 m²', Body: Plan },
  { title: 'Lease_2024_SIGNED.pdf', label: 'Signed leases.', sentence: 'Notice period:', value: 'six months', Body: Lease },
  { title: 'Okafor_2023_Trial.pdf', label: 'Research papers.', sentence: 'Hazard ratio:', value: '0.72', Body: Table },
];
const Work: React.FC = () => {
  const t = useCurrentFrame();
  const STEP = 50, GAP = 1300;
  const pan = interpolate(t, [0, 30, STEP + 4, STEP + 30, STEP * 2 + 4, STEP * 2 + 30], [0, 0, 0, 1, 1, 2], { ...clamp, easing: EASE });
  const away = ramp(t, B, 16, EXIT);
  const clickAt = (i: number) => i * STEP + 26;
  // the cursor clicks each value, then leads the camera on to the next window
  const cur = glide(t, [[0, 1500, 900], [clickAt(0) - 4, 1286, 446], [STEP + 26, 1500, 640], [clickAt(1) - 4, 1286, 446], [STEP * 2 + 26, 1500, 640], [clickAt(2) - 4, 1286, 446], [END, 1600, 760]]);
  return (
    <>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1920 * 3, height: 1080, transform: `translateX(${(-pan * GAP - away * 300).toFixed(1)}px)`, perspective: 2200, opacity: 1 - away, filter: away > 0.01 ? `blur(${(away * 16).toFixed(1)}px)` : undefined }}>
        {WORKS.map((w, i) => {
          const v = sp(t, i * STEP - 10, 20, 110), hit = t >= clickAt(i);
          const { Body } = w;
          return (
            <div key={i} style={{ position: 'absolute', left: 420 + i * GAP, top: 300, width: 1080, height: 600, transformStyle: 'preserve-3d', transform: `rotateY(${(-14 + (pan - i) * 12).toFixed(2)}deg) rotateX(4deg) translateY(${((1 - v) * 60).toFixed(1)}px)`, opacity: Math.max(0.2, v), filter: Math.abs(pan - i) > 0.6 ? `blur(${Math.min(10, (Math.abs(pan - i) - 0.6) * 14).toFixed(1)}px)` : undefined }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: 28, background: C.white, boxShadow: SHADOW, overflow: 'hidden', fontFamily: SANS }}>
                <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 8, padding: '0 22px', borderBottom: `1px solid ${C.line}`, fontSize: 19, fontWeight: 600, color: C.ink2 }}>
                  {['#ff5f57', '#febc2e', '#28c840'].map((c) => <i key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />)}<span style={{ marginLeft: 14 }}>{w.title}</span>
                </div>
                <div style={{ position: 'absolute', left: 30, top: 86, width: 520, height: 380, borderRadius: 18, background: '#fbfaf8', boxShadow: `inset 0 0 0 1px ${C.line}`, overflow: 'hidden' }}><Body /></div>
                <div style={{ position: 'absolute', left: 590, top: 120, right: 30, fontSize: 38, fontWeight: 600, letterSpacing: '-0.025em', lineHeight: 1.3 }}>
                  {w.sentence}<br /><span style={{ boxShadow: `inset 0 -5px 0 ${C.green}`, background: hit ? 'rgba(41,204,87,.2)' : undefined, borderRadius: 6 }}>{w.value}</span>
                  <div style={{ marginTop: 26, display: 'inline-flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderRadius: 14, background: C.white, boxShadow: SHADOW_SM, fontFamily: MONO, fontSize: 17, color: C.ink3, fontWeight: 400, opacity: sp(t, clickAt(i) + 2, 18, 160), letterSpacing: 0 }}><LassoMark size={20} />{w.title}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {WORKS.map((w, i) => <Pill key={i} parts={[{ text: w.label, at: i * STEP + 8 }]} out={i < 2 ? (i + 1) * STEP + 10 : B + 8} top={210} />)}
      {t < END - 4 && <Cursor x={cur.x} y={cur.y} vx={cur.v} hand press={press(t, clickAt(0)) + press(t, clickAt(1)) + press(t, clickAt(2))} scale={1.6} />}
    </>
  );
};

/* 4 · ⇧⌘↵ shares exactly what you used, in Messages */
const Share: React.FC = () => {
  const t = useCurrentFrame();
  const card = sp(t, 92, 18, 120), reply = sp(t, 118, 18, 140);
  return (
    <>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}><KeyCombo keys={[{ big: '⇧', w: 200 }, { glyph: '⌘', label: 'command', w: 240 }, { big: '↵', w: 200 }]} at={2} press={30} out={400} h={190} dock={{ at: 42, ...DOCK }} /></AbsoluteFill>
      <Pill parts={[{ text: 'Share exactly', at: 48 }, { text: 'what you used.', at: 96 }]} out={400} top={210} />
      <Focus at={44} style={{ position: 'absolute', left: 560, top: 300 }}>
        <div style={{ width: 800, height: 690, background: C.white, borderRadius: 36, boxShadow: SHADOW, fontFamily: SANS, padding: '28px 40px', position: 'relative' }}>
          <div style={{ textAlign: 'center' }}>
            <span style={{ display: 'inline-grid', placeItems: 'center', width: 76, height: 76, borderRadius: 38, background: '#fbe1cb', fontWeight: 700, fontSize: 26, color: 'rgba(17,21,17,.7)' }}>JL</span>
            <div style={{ fontWeight: 600, fontSize: 21, marginTop: 6 }}>Jordan Lee ›</div>
          </div>
          <div style={{ marginTop: 22, display: 'inline-block', padding: '14px 20px', borderRadius: 24, background: '#ececec', fontSize: 24 }}>where’s that number from?</div>
          {card > 0.01 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 22, opacity: Math.min(1, card * 1.4), transform: `translateY(${((1 - card) * 24).toFixed(1)}px) scale(${lerp(0.92, 1, card).toFixed(3)})`, transformOrigin: '100% 0' }}>
              <div style={{ width: 430, borderRadius: 24, overflow: 'hidden', boxShadow: SHADOW_SM }}>
                <div style={{ background: '#fbfaf8', padding: '14px 16px' }}>
                  {[45, 46, 47, 48].map((n) => (
                    <div key={n} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 110px', height: 30, alignItems: 'center', fontSize: 15, fontFamily: MONO, background: n === 47 ? '#fff4cc' : undefined, borderRadius: 4 }}>
                      <span style={{ color: C.ink3 }}>{n}</span>{n === 47 ? <><span style={{ fontFamily: SANS, fontWeight: 600 }}>Q4 launch — total</span><span>$428,750</span></> : <span style={{ gridColumn: 'span 2', height: 12, borderRadius: 3, background: C.ink }} />}
                    </div>
                  ))}
                </div>
                <div style={{ background: '#2f7bf0', color: '#fff', padding: '12px 16px' }}><div style={{ fontWeight: 600, fontSize: 19 }}>Q4_Budget_Final.xlsx</div><div style={{ fontSize: 15, opacity: 0.85, marginTop: 2 }}>Row 47 only · the rest redacted</div></div>
              </div>
            </div>
          )}
          {reply > 0.01 && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12, opacity: Math.min(1, reply * 1.4) }}><span style={{ padding: '12px 18px', borderRadius: 22, background: '#2f7bf0', color: '#fff', fontSize: 22 }}>here you go</span></div>}
        </div>
      </Focus>
    </>
  );
};

export const Features: React.FC = () => {
  const f = useCurrentFrame();
  const out = ramp(f, FEAT - 24, 24, EXIT);
  return (
    <AbsoluteFill style={{ opacity: 1 - out, filter: out > 0.01 ? `blur(${(out * 18).toFixed(1)}px)` : undefined, transform: `scale(${(1 + out * 0.06).toFixed(4)})` }}>
      {[Arrows, Trace, Work, Share].map((V, i) => (
        <Sequence key={i} from={i * B} durationInFrames={i < 3 ? END : FEAT - i * B}><V /></Sequence>
      ))}
    </AbsoluteFill>
  );
};
export const featCues: Cue[] = [
  { f: 30, s: 'tab', v: 0.4 }, { f: 76, s: 'key', v: 0.3 }, { f: 104, s: 'key', v: 0.3 },
  { f: B + 30, s: 'tab', v: 0.4 }, { f: B + 96, s: 'key', v: 0.4 },
  { f: 2 * B + 26, s: 'key', v: 0.35 }, { f: 2 * B + 76, s: 'key', v: 0.35 }, { f: 2 * B + 126, s: 'key', v: 0.35 },
  { f: 3 * B + 30, s: 'tab', v: 0.4 }, { f: 3 * B + 92, s: 'notify', v: 0.3 },
];
