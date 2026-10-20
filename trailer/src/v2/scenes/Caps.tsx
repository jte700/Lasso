import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { C, SERIF, SANS, MONO, BAR, Caption, Caret, Key, LassoMark, ramp, life, lerp, typing, count, EASE, ENTER, EXIT, Q, S, SHADOW, SHADOW_SM } from '../kit';
import type { Cue } from '../cues';

/* ───────────── F · what else Lasso finds (bars 22–27) ───────────── */
export const CAPS = BAR * 5;
const P = 200; // frames per panel; the camera glides to the next one on the beat
const ROPE = '#2b2622';

type Spec = { caption: string; doc: string; text: string; value: string; src: { x: number; y: number }; Source: React.FC<{ t: number; hot: number }> };
const PULL = 70, LAND = 120; // the value is lassoed at PULL and lands in the sentence at LAND

const Card: React.FC<{ x: number; y: number; w: number; h: number; rot?: number; title?: React.ReactNode; children?: React.ReactNode; style?: React.CSSProperties }> = ({ x, y, w, h, rot = 0, title, children, style }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: 28, background: C.paper, boxShadow: SHADOW, transform: `rotate(${rot}deg)`, overflow: 'hidden', ...style }}>
    {title && <div style={{ height: 54, display: 'flex', alignItems: 'center', gap: 10, padding: '0 24px', borderBottom: `1px solid ${C.line}`, fontFamily: SANS, fontSize: 19, fontWeight: 600, color: C.ink2 }}>{title}</div>}
    {children}
  </div>
);

const Plan: React.FC<{ t: number; hot: number }> = ({ hot }) => (
  <Card x={170} y={380} w={660} h={460} rot={-3} title="A-201_FloorPlan.pdf · Level 4">
    <svg viewBox="0 0 480 280" width={660} height={400} style={{ fontFamily: MONO }}>
      <rect x="20" y="20" width="440" height="240" fill="#fbfaf8" stroke="#2b2622" strokeWidth="5" />
      <path d="M190 20V150M20 150H300M300 20V260M380 150V260" stroke="#2b2622" strokeWidth="3.5" fill="none" />
      <rect x="300" y="20" width="160" height="130" fill={`rgba(41,204,87,${(0.06 + hot * 0.22).toFixed(3)})`} stroke={C.green} strokeWidth={hot * 4} />
      <text x="380" y="78" textAnchor="middle" fontSize="15" fontWeight="600" fill="#2b2622">KITCHEN</text>
      <text x="380" y="102" textAnchor="middle" fontSize="17" fontWeight="600" fill={C.greenD}>14.62 m²</text>
      {[['LIVING', 105, 90], ['DINING', 245, 90], ['BED 1', 160, 210], ['BATH', 340, 210], ['WC', 420, 210]].map(([s, x, y]) => <text key={s as string} x={x} y={y} textAnchor="middle" fontSize="14" fill="rgba(0,0,0,.4)">{s}</text>)}
    </svg>
  </Card>
);
const Lease: React.FC<{ t: number; hot: number }> = ({ hot }) => {
  const page = (draft: boolean) => (
    <div style={{ padding: '26px 34px', fontFamily: SERIF, fontSize: 21, color: C.ink2, lineHeight: 1.45 }}>
      <div style={{ fontWeight: 600, fontSize: 24, color: C.ink }}>12. Termination</div>
      {[0.92, 0.84].map((w, i) => <div key={i} style={{ height: 10, borderRadius: 5, background: '#ece9e5', width: `${w * 100}%`, marginTop: 16 }} />)}
      <div style={{ marginTop: 16, padding: '6px 8px', borderRadius: 8, background: draft ? undefined : `rgba(246,196,69,${(0.15 + hot * 0.45).toFixed(3)})`, color: C.ink }}>
        12.3 Either party may terminate on not less than <b style={{ textDecoration: draft ? 'line-through' : undefined }}>{draft ? 'three (3) months’' : 'six (6) months’'}</b> written notice.
      </div>
      {[0.88, 0.7].map((w, i) => <div key={i} style={{ height: 10, borderRadius: 5, background: '#ece9e5', width: `${w * 100}%`, marginTop: 16 }} />)}
    </div>
  );
  return (
    <>
      <Card x={290} y={340} w={580} h={460} rot={5} title="Lease_2024_DRAFT.pdf" style={{ opacity: 0.8 }}>
        {page(true)}
        <div style={{ position: 'absolute', right: 30, top: 80, transform: 'rotate(-12deg)', border: `3px solid ${C.red}`, color: C.red, fontFamily: SANS, fontWeight: 700, fontSize: 26, padding: '4px 14px', borderRadius: 8, opacity: 0.7 }}>DRAFT</div>
      </Card>
      <Card x={170} y={400} w={600} h={460} rot={-3} title="Lease_2024_SIGNED.pdf · §12.3">
        {page(false)}
        <div style={{ position: 'absolute', right: 22, bottom: 20, fontFamily: SANS, fontWeight: 700, fontSize: 18, color: C.greenD, background: C.greenBg, padding: '6px 14px', borderRadius: 999 }}>✓ Signed</div>
      </Card>
    </>
  );
};
const Paper: React.FC<{ t: number; hot: number }> = ({ hot }) => (
  <Card x={170} y={380} w={660} h={460} rot={-3} title="Okafor_2023_Trial.pdf · p. 6">
    <div style={{ padding: '24px 30px', fontFamily: SANS }}>
      <div style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 24 }}>Table 2. Primary and secondary outcomes</div>
      {[['Outcome', 'HR', '95% CI'], ['All-cause mortality', '0.81', '0.69–0.95'], ['Primary endpoint', '0.72', '0.61–0.85'], ['Hospitalisation', '0.88', '0.77–1.01']].map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 150px', padding: '14px 12px', marginTop: i ? 0 : 14, borderTop: i ? `1px solid ${C.line}` : undefined, fontSize: i ? 22 : 18, fontWeight: i === 0 || i === 2 ? 600 : 400, color: i ? C.ink : C.ink3, background: i === 2 ? `rgba(41,204,87,${(0.05 + hot * 0.2).toFixed(3)})` : undefined, borderRadius: 8 }}>
          <span>{r[0]}</span><span style={{ fontFamily: i ? MONO : SANS }}>{r[1]}</span><span style={{ fontFamily: i ? MONO : SANS }}>{r[2]}</span>
        </div>
      ))}
    </div>
  </Card>
);

const SPECS: Spec[] = [
  { caption: 'Areas, straight from *the drawings.*', doc: 'Design_Report.docx', text: 'Unit 4B’s kitchen is ', value: '14.62 m²', src: { x: 690, y: 500 }, Source: Plan },
  { caption: 'The signed lease. *Not the draft.*', doc: 'Lease_Summary.docx', text: 'The notice period is ', value: 'six months', src: { x: 470, y: 640 }, Source: Lease },
  { caption: 'Every number keeps *its table.*', doc: 'Literature_Review.md', text: 'The hazard ratio was ', value: '0.72 (CI 0.61–0.85)', src: { x: 560, y: 650 }, Source: Paper },
];
const sched = SPECS.map((s, i) => typing(s.text, 16, 1.9, `cap${i}`));
const DOC = { x: 980, y: 480, w: 800, h: 230 };

const Retrieval: React.FC<{ i: number; t: number }> = ({ i, t }) => {
  const s = SPECS[i], n = count(sched[i], t);
  const hot = ramp(t, PULL - 20, 20) * (1 - ramp(t, LAND + 30, 30));
  // where the caret sits (an estimate is enough: the chip dissolves into the text as it lands)
  const D = { x: DOC.x + 44 + s.text.length * 19.5, y: DOC.y + 128 };
  const grab = ramp(t, PULL, 16, ENTER), fly = ramp(t, PULL + 14, LAND - PULL - 14, EASE);
  const cx = lerp(s.src.x, D.x, fly), cy = lerp(s.src.y, D.y, fly) - Math.sin(fly * Math.PI) * 140;
  const chip = grab * (1 - ramp(t, LAND - 4, 10, EXIT));
  const ins = t >= LAND, glow = 1 - ramp(t, LAND, 40);
  const ropeO = grab * (1 - ramp(t, LAND - 20, 24));
  const { Source } = s;
  return (
    <>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 150 }}><Caption text={s.caption} start={8} step={7} size={66} /></div>
      <Source t={t} hot={hot} />
      <Card x={DOC.x} y={DOC.y} w={DOC.w} h={DOC.h} title={s.doc}>
        <div style={{ padding: '44px 44px', fontFamily: SANS, fontWeight: 500, fontSize: 40, letterSpacing: '-0.012em', whiteSpace: 'pre', color: C.ink }}>
          {s.text.slice(0, n)}
          {ins && <span style={{ background: `rgba(41,204,87,${(0.22 * glow).toFixed(3)})`, boxShadow: `inset 0 -4px 0 ${C.green}`, borderRadius: 5, padding: '0 2px' }}>{s.value}</span>}
          {ins && t > LAND + 10 ? '.' : ''}
          <Caret blink={t > sched[i][sched[i].length - 1] + 4 && t < PULL} />
        </div>
      </Card>
      {chip > 0.01 && (
        <svg width="1920" height="1080" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}>
          <path d={`M${s.src.x} ${s.src.y}Q${(s.src.x + cx) / 2} ${(s.src.y + cy) / 2 + 90 * (1 - fly)} ${cx} ${cy}`} fill="none" stroke={ROPE} strokeWidth="3" strokeLinecap="round" opacity={ropeO * 0.6} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - grab} />
          <ellipse cx={cx} cy={cy} rx={lerp(120, 96, fly)} ry={lerp(46, 38, fly)} fill="none" stroke={ROPE} strokeWidth="3" opacity={ropeO * 0.75} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - grab} />
        </svg>
      )}
      {chip > 0.01 && (
        <div style={{ position: 'absolute', left: cx, top: cy, transform: `translate(-50%, -50%) scale(${lerp(0.85, 1, grab).toFixed(3)})`, opacity: chip, padding: '10px 18px', borderRadius: 14, background: C.paper, boxShadow: SHADOW_SM, fontFamily: SERIF, fontWeight: 600, fontSize: 32, color: C.ink, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 10 }}>
          <LassoMark size={24} />{s.value}
        </div>
      )}
    </>
  );
};

/* share: ⇧⌘↵ sends exactly the part you used, the rest redacted */
const SH_KEY = 40, SH_SHEET = 54, SH_OPT = 74, SH_SWEEP = 84, SH_SEND = 128, SH_DONE = 150;
const Share: React.FC<{ t: number }> = ({ t }) => {
  const sheet = ramp(t, SH_SHEET, S, ENTER) * (1 - ramp(t, SH_SEND, 20, EXIT));
  const opt = t >= SH_OPT ? 2 : 0;
  const send = ramp(t, SH_SEND, 30, EASE), bubble = ramp(t, SH_DONE - 6, S, ENTER);
  const kd = t >= SH_KEY - 2 && t < SH_KEY + 7 ? Math.sin(Math.min(1, (t - SH_KEY + 2) / 9) * Math.PI) : 0;
  const keys = life(t, SH_KEY - 20, SH_KEY + 26, S, Q);
  const rows: [number, string, string][] = [[45, 'Creative agency', '$118,400'], [46, 'Paid social', '$96,350'], [47, 'Q4 launch — total', '$428,750'], [48, 'Brand refresh', '$54,900']];
  return (
    <>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 150 }}><Caption text="Share exactly *what you used.*" start={8} step={7} size={66} /></div>
      <Card x={170} y={400} w={900} h={190} title="Re: Q4 launch spend">
        <div style={{ padding: '30px 44px', fontFamily: SANS, fontWeight: 500, fontSize: 40, whiteSpace: 'pre' }}>The final Q4 spend was <span style={{ boxShadow: `inset 0 -4px 0 ${C.green}`, background: t > SH_KEY ? 'rgba(41,204,87,.14)' : undefined, borderRadius: 5 }}>$428,750</span>.</div>
      </Card>
      {keys > 0.01 && (
        <div style={{ position: 'absolute', left: 170, width: 900, top: 640, display: 'flex', justifyContent: 'center', gap: 14, opacity: keys }}>
          {['⇧', '⌘', '↵'].map((k) => <Key key={k} label={k} down={kd} size={80} />)}
        </div>
      )}
      {sheet > 0.01 && (
        <div style={{ position: 'absolute', left: 330, top: 620, width: 640, opacity: sheet, transform: `translateY(${((1 - sheet) * 16 + send * -40).toFixed(1)}px) scale(${(1 - send * 0.1).toFixed(3)})`, background: C.paper, borderRadius: 24, boxShadow: SHADOW, padding: 22, fontFamily: SANS }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700, fontSize: 22 }}><LassoMark size={24} /> Share source<span style={{ marginLeft: 'auto', fontFamily: MONO, fontWeight: 400, fontSize: 16, color: C.ink3 }}>Q4_Budget_Final.xlsx</span></div>
          <div style={{ display: 'flex', gap: 10, margin: '16px 0' }}>
            {['Row 47', 'Whole file', 'Redact the rest'].map((o, k) => <span key={o} style={{ padding: '8px 16px', borderRadius: 999, fontWeight: 600, fontSize: 18, background: k === opt ? C.ink : C.sand, color: k === opt ? '#fff' : C.ink2 }}>{o}</span>)}
          </div>
          <div style={{ borderRadius: 12, overflow: 'hidden', border: `1px solid ${C.line}`, fontFamily: MONO, fontSize: 18 }}>
            {rows.map(([r, a, v], k) => {
              const w = r !== 47 ? ramp(t, SH_SWEEP + k * 4, 22, EASE) : 0;
              return (
                <div key={r} style={{ position: 'relative', display: 'grid', gridTemplateColumns: '50px 1fr 130px', padding: '10px 14px', borderTop: k ? '1px solid #f1eeea' : undefined, background: r === 47 ? '#fff4cc' : undefined, fontWeight: r === 47 ? 600 : 400 }}>
                  <span style={{ color: C.ink3 }}>{r}</span><span style={{ fontFamily: SANS, fontSize: 19 }}>{a}</span><span style={{ textAlign: 'right' }}>{v}</span>
                  {w > 0.001 && <span style={{ position: 'absolute', left: 60, top: 9, bottom: 9, width: `calc(${(w * 100).toFixed(1)}% - 74px)`, background: C.ink, borderRadius: 4 }} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {/* the recipient */}
      <Card x={1180} y={400} w={600} h={420} title="Messages · Jordan Lee">
        <div style={{ padding: 28, fontFamily: SANS, fontSize: 22 }}>
          <div style={{ display: 'inline-block', padding: '12px 18px', borderRadius: 20, background: C.sand, color: C.ink }}>Can you send me the source?</div>
          {bubble > 0.01 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 22, opacity: bubble, transform: `translateY(${((1 - bubble) * 20).toFixed(1)}px)` }}>
              <div style={{ padding: '14px 18px', borderRadius: 20, background: '#2f7bf0', color: '#fff', maxWidth: 420 }}>
                <div style={{ fontWeight: 600 }}>Q4_Budget_Final.xlsx</div>
                <div style={{ fontFamily: MONO, fontSize: 17, opacity: 0.85, marginTop: 4 }}>Row 47 · everything else redacted</div>
              </div>
            </div>
          )}
        </div>
      </Card>
      {send > 0.01 && send < 0.99 && (
        <div style={{ position: 'absolute', left: lerp(650, 1480, send), top: lerp(640, 560, send) - Math.sin(send * Math.PI) * 120, transform: 'translate(-50%,-50%)', width: 56, height: 56, borderRadius: 16, background: C.paper, boxShadow: SHADOW_SM, display: 'grid', placeItems: 'center' }}><LassoMark size={30} /></div>
      )}
    </>
  );
};

export const Caps: React.FC = () => {
  const f = useCurrentFrame();
  let pan = 0;
  for (let i = 1; i < 4; i++) pan += ramp(f, i * P - 20, 40, EASE);
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1920 * 4, height: 1080, transform: `translateX(${(-pan * 1920).toFixed(2)}px)` }}>
        {[0, 1, 2, 3].map((i) => {
          const t = f - i * P;
          if (t < -60 || t > P + 40) return null;
          const v = life(f, i * P - 30, (i + 1) * P + 30, S, S);
          return (
            <div key={i} style={{ position: 'absolute', left: i * 1920, top: 0, width: 1920, height: 1080, opacity: i === 0 ? ramp(f, 0, S, ENTER) : v }}>
              {i < 3 ? <Retrieval i={i} t={t} /> : <Share t={t} />}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
export const capCues: Cue[] = [
  ...sched.flatMap((sc, i) => [...sc.filter((_, k) => k % 2 === 0).map((f) => ({ f: i * P + f, s: 'key', v: 0.22 })), { f: i * P + LAND, s: 'tab', v: 0.3 }]),
  { f: 3 * P + SH_KEY, s: 'tab', v: 0.35 }, { f: 3 * P + SH_DONE, s: 'notify', v: 0.22 },
];
