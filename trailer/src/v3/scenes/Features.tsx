import React from 'react';
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame } from 'remotion';
import { C, SANS, MONO, BAR, Words, Wallpaper, Focus, KeyCombo, Cursor, LassoMark, ramp, lerp, clamp, EASE, ENTER, EXIT, S, SHADOW, SHADOW_SM } from '../kit';
import type { Cue } from '../../v2/cues';

/* ───────────── F · what else Lasso does (bars 22–27), one shortcut per beat ───────────── */
export const FEAT = BAR * 5;
const B1 = 0, B2 = 200, B3 = 400, B4 = 600;
const cap = (text: string, at: number, out: number) => (
  <div style={{ position: 'absolute', left: 0, right: 0, top: 200, zIndex: 20 }}>
    <Words text={text} start={at} step={6} size={50} weight={600} color="#fff" accent="#9cf0b6" out={out} />
  </div>
);

/* 1 · ↑↓ look at another source */
const SOURCES: [string, string, string][] = [
  ['$428,750', 'Q4_Budget_Final.xlsx · Marketing · Row 47', 'final'],
  ['$428,750', 'Board_Deck_v9.key · Slide 12', 'matches'],
  ['$430,000', 'Launch_Recap.pdf · p. 3 · estimate', 'estimate'],
];
const Arrows: React.FC<{ t: number }> = ({ t }) => {
  const sel = t < 104 ? 0 : t < 140 ? 1 : t < 172 ? 2 : 0;
  return (
    <>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <KeyCombo keys={[{ big: '↑', w: 200 }, { big: '↓', w: 200 }]} at={6} press={44} out={214} h={200} dock={{ at: 60, y: -400, scale: 0.42 }} />
      </AbsoluteFill>
      {cap('Look at another source.', 76, 214)}
      <Focus at={74} out={216} style={{ position: 'absolute', left: 460, top: 320 }}>
        <div style={{ width: 1000, background: C.white, borderRadius: 30, boxShadow: SHADOW, padding: 18, fontFamily: SANS }}>
          {SOURCES.map(([v, s, tag], i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '20px 24px', borderRadius: 20, background: i === sel ? C.greenBg : undefined, boxShadow: i === sel ? `inset 0 0 0 2px ${C.green}` : undefined }}>
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

/* 2 · ⌘↵ insert with its source; click to inspect */
const Insert: React.FC<{ t: number }> = ({ t }) => {
  const CLICK = 130;
  const cx = interpolate(t, [80, CLICK - 4], [1500, 990], { ...clamp, easing: EASE }), cy = interpolate(t, [80, CLICK - 4], [900, 520], { ...clamp, easing: EASE });
  const peek = ramp(t, CLICK + 2, S, ENTER);
  return (
    <>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <KeyCombo keys={[{ glyph: '⌘', label: 'command', w: 240 }, { big: '↵', w: 200 }]} at={6} press={44} out={214} h={200} dock={{ at: 60, y: -400, scale: 0.42 }} />
      </AbsoluteFill>
      {cap('Every value keeps its source.', 76, 214)}
      <Focus at={74} out={216} style={{ position: 'absolute', left: 360, top: 380 }}>
        <div style={{ width: 1200, background: C.white, borderRadius: 30, boxShadow: SHADOW, padding: '40px 50px', fontFamily: SANS, fontSize: 50, fontWeight: 500, letterSpacing: '-0.02em', whiteSpace: 'pre' }}>
          The final Q4 spend was <span style={{ position: 'relative', boxShadow: `inset 0 -5px 0 ${C.green}`, background: t > CLICK ? 'rgba(41,204,87,.16)' : undefined, borderRadius: 6, padding: '0 3px' }}>$428,750
            <span style={{ position: 'absolute', right: -34, top: -14, width: 30, height: 30, borderRadius: 15, background: C.green, display: 'grid', placeItems: 'center' }}><LassoMark size={20} color="#fff" stroke={3} /></span>
          </span>.
        </div>
        {peek > 0.01 && (
          <div style={{ position: 'absolute', left: 520, top: 170, width: 600, opacity: peek, transform: `translateY(${((1 - peek) * 16).toFixed(1)}px) scale(${lerp(0.96, 1, peek).toFixed(3)})`, transformOrigin: '20% 0', background: C.white, borderRadius: 24, boxShadow: SHADOW, overflow: 'hidden', fontFamily: SANS }}>
            <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 10, padding: '0 22px', borderBottom: `1px solid ${C.line}`, fontSize: 19, fontWeight: 600, color: C.ink2 }}><span style={{ width: 14, height: 14, borderRadius: 4, background: C.greenD }} />Q4_Budget_Final.xlsx · Marketing</div>
            {[[46, 'Paid social', '$96,350'], [47, 'Q4 launch — total', '$428,750'], [48, 'Brand refresh', '$54,900']].map(([n, a, v]) => (
              <div key={n} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 160px', height: 52, alignItems: 'center', borderBottom: '1px solid #f1efec', background: n === 47 ? '#fff4cc' : undefined, fontWeight: n === 47 ? 600 : 400, fontSize: 21 }}>
                <span style={{ textAlign: 'center', color: C.ink3, fontSize: 17 }}>{n}</span><span>{a}</span><span style={{ fontFamily: MONO, fontSize: 20, textAlign: 'right', paddingRight: 22 }}>{v}</span>
              </div>
            ))}
          </div>
        )}
      </Focus>
      {t > 80 && t < 210 && <Cursor x={cx} y={cy} hand={t > CLICK - 20} press={t >= CLICK - 2 && t < CLICK + 4 ? 1 : 0} />}
    </>
  );
};

/* 3 · the same move in other kinds of work: three tilted windows the camera glides past */
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
    <div style={{ height: 10, borderRadius: 5, background: '#ece9e5', width: '90%', marginTop: 16 }} />
    <div style={{ marginTop: 14, padding: '6px 8px', borderRadius: 8, background: 'rgba(246,196,69,.45)', color: C.ink }}>12.3 Either party may end this lease on <b>six (6) months’</b> written notice.</div>
    <div style={{ height: 10, borderRadius: 5, background: '#ece9e5', width: '80%', marginTop: 16 }} />
    <div style={{ marginTop: 18, display: 'inline-block', fontWeight: 700, fontSize: 17, color: C.greenD, background: C.greenBg, padding: '5px 12px', borderRadius: 999 }}>✓ Signed copy</div>
  </div>
);
const Table = () => (
  <div style={{ padding: '22px 26px', fontSize: 21 }}>
    <div style={{ fontWeight: 700, fontSize: 22 }}>Table 2. Outcomes</div>
    {[['Outcome', 'HR', '95% CI'], ['Mortality', '0.81', '0.69–0.95'], ['Primary endpoint', '0.72', '0.61–0.85'], ['Hospitalisation', '0.88', '0.77–1.01']].map((r, i) => (
      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 140px', padding: '12px 10px', borderTop: i ? `1px solid ${C.line}` : undefined, fontWeight: i === 0 || i === 2 ? 600 : 400, color: i ? C.ink : C.ink3, background: i === 2 ? 'rgba(41,204,87,.2)' : undefined, borderRadius: 8, fontFamily: i ? MONO : SANS }}>
        <span style={{ fontFamily: SANS }}>{r[0]}</span><span>{r[1]}</span><span>{r[2]}</span>
      </div>
    ))}
  </div>
);
const WORKS: { title: string; label: string; sentence: string; value: string; Body: React.FC }[] = [
  { title: 'A-201_FloorPlan.pdf', label: 'Floor plans.', sentence: 'Unit 4B’s kitchen is', value: '14.62 m²', Body: Plan },
  { title: 'Lease_2024_SIGNED.pdf', label: 'Signed leases.', sentence: 'The notice period is', value: 'six months', Body: Lease },
  { title: 'Okafor_2023_Trial.pdf', label: 'Research papers.', sentence: 'The hazard ratio was', value: '0.72', Body: Table },
];
const Work: React.FC<{ t: number }> = ({ t }) => {
  const away = ramp(t, 200, 20, EXIT);
  const pan = interpolate(t, [0, 66, 74, 132, 140, 200], [0, 0, 1, 1, 2, 2], { ...clamp, easing: EASE });
  return (
    <>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1920 * 3, height: 1080, transform: `translateX(${(-pan * 1300 - away * 300).toFixed(1)}px)`, perspective: 2200, opacity: 1 - away, filter: away > 0.01 ? `blur(${(away * 16).toFixed(1)}px)` : undefined }}>
        {WORKS.map((w, i) => {
          const local = t - i * 70, v = ramp(local, 0, S, ENTER), chip = ramp(local, 24, S, ENTER);
          const { Body } = w;
          return (
            <div key={i} style={{ position: 'absolute', left: 420 + i * 1300, top: 300, width: 1080, height: 640, transformStyle: 'preserve-3d', transform: `rotateY(${(-16 + (pan - i) * 10).toFixed(2)}deg) rotateX(4deg)`, opacity: Math.max(0.25, v), filter: Math.abs(pan - i) > 0.6 ? `blur(${Math.min(10, (Math.abs(pan - i) - 0.6) * 14).toFixed(1)}px)` : undefined }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: 28, background: C.white, boxShadow: SHADOW, overflow: 'hidden', fontFamily: SANS }}>
                <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 8, padding: '0 22px', borderBottom: `1px solid ${C.line}`, fontSize: 19, fontWeight: 600, color: C.ink2 }}>
                  <i style={{ width: 13, height: 13, borderRadius: 7, background: '#ff5f57' }} /><i style={{ width: 13, height: 13, borderRadius: 7, background: '#febc2e' }} /><i style={{ width: 13, height: 13, borderRadius: 7, background: '#28c840' }} /><span style={{ marginLeft: 14 }}>{w.title}</span>
                </div>
                <div style={{ position: 'absolute', left: 30, top: 86, width: 560, height: 400, borderRadius: 18, background: '#fbfaf8', boxShadow: `inset 0 0 0 1px ${C.line}`, overflow: 'hidden' }}><Body /></div>
                <div style={{ position: 'absolute', left: 620, top: 120, right: 30, fontSize: 34, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.35 }}>
                  {w.sentence} <span style={{ boxShadow: `inset 0 -4px 0 ${C.green}`, background: `rgba(41,204,87,${(0.2 * chip).toFixed(3)})`, borderRadius: 5, opacity: chip }}>{w.value}</span>{chip > 0.5 ? '.' : ''}
                  <div style={{ marginTop: 26, display: 'inline-flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderRadius: 14, background: C.white, boxShadow: SHADOW_SM, fontFamily: MONO, fontSize: 17, color: C.ink3, opacity: chip }}><LassoMark size={20} />{w.title}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {WORKS.map((w, i) => <React.Fragment key={i}>{cap(w.label, i * 70 + 6, i < 2 ? (i + 1) * 70 + 4 : 214)}</React.Fragment>)}
    </>
  );
};

/* 4 · ⇧⌘↵ share exactly what you used, in Messages */
const Share: React.FC<{ t: number }> = ({ t }) => {
  const card = ramp(t, 108, S, ENTER), reply = ramp(t, 138, S, ENTER);
  return (
    <>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <KeyCombo keys={[{ big: '⇧', w: 200 }, { glyph: '⌘', label: 'command', w: 240 }, { big: '↵', w: 200 }]} at={6} press={48} out={400} h={190} dock={{ at: 64, y: -400, scale: 0.42 }} />
      </AbsoluteFill>
      {cap('Share exactly what you used.', 80, 400)}
      <Focus at={78} style={{ position: 'absolute', left: 560, top: 290 }}>
        <div style={{ width: 800, height: 700, background: C.white, borderRadius: 36, boxShadow: SHADOW, fontFamily: SANS, padding: '28px 40px', position: 'relative' }}>
          <div style={{ textAlign: 'center' }}>
            <span style={{ display: 'inline-grid', placeItems: 'center', width: 76, height: 76, borderRadius: 38, background: '#fbe1cb', fontWeight: 700, fontSize: 26, color: 'rgba(17,21,17,.7)' }}>JL</span>
            <div style={{ fontWeight: 600, fontSize: 21, marginTop: 6 }}>Jordan Lee ›</div>
            <div style={{ fontSize: 16, color: C.ink3, marginTop: 14 }}>Today 9:44 AM</div>
          </div>
          <div style={{ marginTop: 18, display: 'inline-block', padding: '14px 20px', borderRadius: 24, background: '#ececec', fontSize: 24 }}>can you send me where that’s from?</div>
          {card > 0.01 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 22, opacity: card, transform: `translateY(${((1 - card) * 24).toFixed(1)}px) scale(${lerp(0.94, 1, card).toFixed(3)})`, transformOrigin: '100% 0' }}>
              <div style={{ width: 430, borderRadius: 24, overflow: 'hidden', boxShadow: SHADOW_SM }}>
                <div style={{ background: '#fbfaf8', padding: '14px 16px' }}>
                  {[45, 46, 47, 48].map((n) => (
                    <div key={n} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 110px', height: 30, alignItems: 'center', fontSize: 15, fontFamily: MONO, background: n === 47 ? '#fff4cc' : undefined, borderRadius: 4 }}>
                      <span style={{ color: C.ink3 }}>{n}</span>{n === 47 ? <><span style={{ fontFamily: SANS, fontWeight: 600 }}>Q4 launch — total</span><span>$428,750</span></> : <span style={{ gridColumn: 'span 2', height: 12, borderRadius: 3, background: C.ink }} />}
                    </div>
                  ))}
                </div>
                <div style={{ background: '#2f7bf0', color: '#fff', padding: '12px 16px' }}>
                  <div style={{ fontWeight: 600, fontSize: 19 }}>Q4_Budget_Final.xlsx</div>
                  <div style={{ fontSize: 15, opacity: 0.85, marginTop: 2 }}>Row 47 only · lasso.link</div>
                </div>
              </div>
            </div>
          )}
          {reply > 0.01 && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12, opacity: reply }}><span style={{ padding: '12px 18px', borderRadius: 22, background: '#2f7bf0', color: '#fff', fontSize: 22 }}>here you go</span></div>}
        </div>
      </Focus>
    </>
  );
};

const Beat: React.FC<{ View: React.FC<{ t: number }> }> = ({ View }) => <View t={useCurrentFrame()} />;
export const Features: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill>
      <Wallpaper />
      <AbsoluteFill style={{ opacity: ramp(f, 0, 12) }}>
        {[Arrows, Insert, Work, Share].map((V, i) => (
          <Sequence key={i} from={[B1, B2, B3, B4][i]} durationInFrames={i < 3 ? 222 : 200}><Beat View={V} /></Sequence>
        ))}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
export const featCues: Cue[] = [
  { f: B1 + 50, s: 'tab', v: 0.4 }, { f: B1 + 104, s: 'key', v: 0.3 }, { f: B1 + 140, s: 'key', v: 0.3 }, { f: B1 + 172, s: 'key', v: 0.3 },
  { f: B2 + 44, s: 'tab', v: 0.4 }, { f: B2 + 128, s: 'key', v: 0.35 },
  { f: B4 + 52, s: 'tab', v: 0.4 }, { f: B4 + 108, s: 'notify', v: 0.3 },
];
