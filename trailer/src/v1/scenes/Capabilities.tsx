import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { C, SERIF, SANS, MONO, Shot, Caret, Keycap, Win, LassoMark, ramp, lerp, schedule, typedCount, camera, easeInOut, Cue, Key } from '../lib';

export const CAP = 426;
const CW = 1280, CH = 800;
const POS = [[0, 0], [1400, 0], [1400, 900], [0, 900]]; // visited in this order
const S = [10, 102, 194, 286]; // when each card becomes active
const centre = (i: number) => [POS[i][0] + CW / 2, POS[i][1] + CH / 2] as const;
const CAM: Key[] = [
  [0, 1.24, ...centre(0)], [12, 1.36, ...centre(0)],
  ...[1, 2, 3].flatMap((i) => [[S[i] - 16, 1.36, ...centre(i - 1)], [S[i] + 2, 1.36, ...centre(i)]] as Key[]),
  [S[3] + 74, 1.36, ...centre(3)], [S[3] + 108, 0.6, 1340, 878], [CAP, 0.585, 1340, 878],
];

/* ── previews shown inside the Lasso popup ── */
const FloorPlan: React.FC<{ on: number }> = ({ on }) => (
  <svg viewBox="0 0 480 220" width={480} height={220} style={{ fontFamily: MONO }}>
    <rect x="8" y="8" width="464" height="204" fill="#fbfaf8" stroke="#2b2622" strokeWidth="5" />
    <path d="M190 8V130M8 130H300M300 8V212M380 130V212" stroke="#2b2622" strokeWidth="3.5" fill="none" />
    <path d="M300 60h-18M190 90h18" stroke="#fbfaf8" strokeWidth="6" />
    <rect x="300" y="8" width="172" height="122" fill={`rgba(41,204,87,${0.08 + on * 0.2})`} stroke={C.green} strokeWidth={on * 4} />
    <text x="386" y="64" textAnchor="middle" fontSize="15" fill="#2b2622" fontWeight="600">KITCHEN</text>
    <text x="386" y="88" textAnchor="middle" fontSize="16" fill={C.greenD} fontWeight="600">14.62 m²</text>
    <text x="98" y="72" textAnchor="middle" fontSize="14" fill="rgba(0,0,0,.45)">LIVING</text>
    <text x="245" y="72" textAnchor="middle" fontSize="14" fill="rgba(0,0,0,.45)">DINING</text>
    <text x="150" y="176" textAnchor="middle" fontSize="14" fill="rgba(0,0,0,.45)">BED 1</text>
    <text x="340" y="176" textAnchor="middle" fontSize="14" fill="rgba(0,0,0,.45)">BATH</text>
    <text x="426" y="176" textAnchor="middle" fontSize="14" fill="rgba(0,0,0,.45)">WC</text>
  </svg>
);
const LeasePage: React.FC<{ on: number }> = ({ on }) => (
  <div style={{ width: 480, height: 220, background: '#fbfaf8', borderRadius: 8, padding: '16px 22px', fontFamily: SERIF, fontSize: 17, color: C.ink2, position: 'relative', overflow: 'hidden' }}>
    <div style={{ fontWeight: 600, color: C.ink, fontSize: 19 }}>12. Termination</div>
    {[0.94, 0.86, 0.9].map((w, i) => <div key={i} style={{ height: 8, borderRadius: 4, background: '#e8e5e1', width: `${w * 100}%`, marginTop: 13 }} />)}
    <div style={{ marginTop: 12, padding: '4px 6px', borderRadius: 5, background: `rgba(246,196,69,${0.15 + on * 0.4})`, color: C.ink, lineHeight: 1.35 }}>12.3 Either party may terminate on not less than <b>six (6) months’</b> written notice.</div>
    {[0.8, 0.88].map((w, i) => <div key={i} style={{ height: 8, borderRadius: 4, background: '#e8e5e1', width: `${w * 100}%`, marginTop: 13 }} />)}
    <div style={{ position: 'absolute', right: 14, bottom: 12, fontFamily: SANS, fontSize: 15, fontWeight: 700, color: C.greenD, background: C.greenBg, padding: '5px 10px', borderRadius: 999 }}>✓ Signed copy · the draft said 3 months</div>
  </div>
);
const PaperTable: React.FC<{ on: number }> = ({ on }) => (
  <div style={{ width: 480, height: 220, background: '#fbfaf8', borderRadius: 8, padding: '14px 18px', fontFamily: SANS, fontSize: 17, color: C.ink2 }}>
    <div style={{ fontFamily: SERIF, fontWeight: 600, color: C.ink, fontSize: 18, marginBottom: 8 }}>Table 2. Primary and secondary outcomes</div>
    {[['Outcome', 'HR', '95% CI'], ['All-cause mortality', '0.81', '0.69–0.95'], ['Primary endpoint', '0.72', '0.61–0.85'], ['Hospitalisation', '0.88', '0.77–1.01']].map((r, i) => (
      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 120px', padding: '7px 8px', borderTop: i ? '1px solid #ecebe8' : undefined, fontWeight: i === 0 || i === 2 ? 600 : 400, color: i === 0 ? C.ink3 : C.ink, background: i === 2 ? `rgba(41,204,87,${0.06 + on * 0.18})` : undefined, borderRadius: 4, fontFamily: i ? MONO : SANS, fontSize: i ? 16 : 15 }}>
        <span style={{ fontFamily: SANS, fontSize: 16 }}>{r[0]}</span><span>{r[1]}</span><span>{r[2]}</span>
      </div>
    ))}
  </div>
);

type Spec = { label: string; sub: string; bg: string; title: string; text: string; value: string; src: string; popX: number; Preview: React.FC<{ on: number }> };
const SPECS: Spec[] = [
  { label: 'Architecture', sub: 'Areas and specs, straight from the drawings.', bg: '#e9effb', title: 'Design_Report.docx', text: 'The kitchen in Unit 4B measures ', value: '14.62 m²', src: 'A-201_FloorPlan.pdf · Level 4 · Kitchen', popX: -190, Preview: FloorPlan },
  { label: 'Legal', sub: 'The signed version, not the draft.', bg: '#f0ecf8', title: 'Lease_Summary.docx', text: 'The notice period in the signed lease is ', value: 'six months', src: 'Lease_2024_SIGNED.pdf · §12.3 · p. 14', popX: -360, Preview: LeasePage },
  { label: 'Research', sub: 'Every number keeps its table and page.', bg: '#ecf3e8', title: 'Literature_Review.md', text: 'The trial’s hazard ratio was ', value: '0.72 (95% CI 0.61–0.85)', src: 'Okafor_2023_Trial.pdf · Table 2 · Row 3', popX: -110, Preview: PaperTable },
];
const sched = SPECS.map((s, i) => schedule(s.text, S[i] + 6, 0.8, `cap${i}`));
const POP_AT = (i: number) => sched[i][sched[i].length - 1] + 5;
const TAB_AT = (i: number) => POP_AT(i) + 24;

const CardFrame: React.FC<{ i: number; label: string; sub: string; bg: string; children: React.ReactNode }> = ({ i, label, sub, bg, children }) => (
  <div style={{ position: 'absolute', left: POS[i][0], top: POS[i][1], width: CW, height: CH, borderRadius: 44, background: bg, overflow: 'hidden' }}>
    <div style={{ position: 'absolute', left: 64, top: 44, display: 'flex', alignItems: 'baseline', gap: 22 }}>
      <span style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 52, letterSpacing: '-0.02em', color: C.ink }}>{label}</span>
      <span style={{ fontFamily: SANS, fontSize: 26, color: C.ink2 }}>{sub}</span>
    </div>
    {children}
  </div>
);

const RetrievalCard: React.FC<{ i: number; f: number }> = ({ i, f }) => {
  const s = SPECS[i], n = typedCount(sched[i], f), P = POP_AT(i), T = TAB_AT(i);
  const pop = ramp(f, P, P + 10) * (1 - ramp(f, T, T + 7));
  const ins = f >= T, glow = 1 - ramp(f, T + 4, T + 40), tabP = f >= T && f < T + 6;
  const { Preview } = s;
  return (
    <CardFrame i={i} label={s.label} sub={s.sub} bg={s.bg}>
      <Win title={s.title} w={1120} h={600} x={80} y={150}>
        <div style={{ padding: '56px 60px', fontFamily: SANS, fontSize: 36, fontWeight: 500, color: C.ink, whiteSpace: 'pre' }}>
          {s.text.slice(0, n)}
          {ins && <span style={{ background: `rgba(41,204,87,${(0.22 * glow).toFixed(3)})`, boxShadow: `inset 0 -3px 0 ${C.green}`, borderRadius: 5, padding: '0 2px' }}>{s.value}</span>}
          {ins && f >= T + 10 ? '.' : ''}
          <span style={{ position: 'relative' }}>
            <Caret color={C.ink} on={f < P + 2} />
            {pop > 0.005 && (
              <div style={{ position: 'absolute', left: s.popX, top: 58, opacity: pop, transform: `translateY(${((1 - pop) * 10).toFixed(2)}px)`, background: C.white, borderRadius: 20, boxShadow: '0 0 0 1px rgba(0,0,0,.07), 0 22px 60px rgba(0,0,0,.14)', padding: '18px 20px 20px', whiteSpace: 'nowrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <LassoMark size={28} />
                  <span style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 34 }}>{s.value}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 16, fontWeight: 600, padding: '5px 10px', borderRadius: 8, background: tabP ? C.green : '#f4f2ef', color: tabP ? '#fff' : C.ink2 }}>Tab</span>
                </div>
                <div style={{ fontFamily: MONO, fontSize: 17, color: C.ink3, margin: '6px 0 14px' }}>{s.src}</div>
                <Preview on={ramp(f, P + 8, P + 20)} />
              </div>
            )}
          </span>
        </div>
      </Win>
    </CardFrame>
  );
};

/* ── share: ⇧⌘↵ sends exactly the part you used ── */
const SH = S[3];
const SH_KEY = SH + 20, SH_SHEET = SH + 26, SH_REDACT = SH + 38, SH_SWEEP = SH + 44, SH_DONE = SH + 66;
const ShareCard: React.FC<{ f: number }> = ({ f }) => {
  const keysOn = ramp(f, SH_KEY - 10, SH_KEY - 4) * (1 - ramp(f, SH_KEY + 10, SH_KEY + 16));
  const kp = f >= SH_KEY && f < SH_KEY + 6 ? 1 : 0;
  const sheet = ramp(f, SH_SHEET, SH_SHEET + 10);
  const opt = f >= SH_REDACT ? 2 : 0;
  const done = ramp(f, SH_DONE, SH_DONE + 10);
  const rows: [number, string, string][] = [[44, 'Venue deposit', '$62,000'], [45, 'Creative agency', '$118,400'], [46, 'Paid social', '$96,350'], [47, 'Q4 launch — total', '$428,750'], [48, 'Brand refresh', '$54,900']];
  return (
    <CardFrame i={3} label="Share" sub="Send exactly the source you used." bg="#fbf0e6">
      <Win title="Re: Q4 launch spend" w={1120} h={600} x={80} y={150}>
        <div style={{ padding: '50px 60px', fontFamily: SANS, fontSize: 36, fontWeight: 500, color: C.ink, whiteSpace: 'pre', position: 'relative' }}>
          The final Q4 spend was <span style={{ position: 'relative', boxShadow: `inset 0 -3px 0 ${C.green}`, background: f >= SH_KEY ? 'rgba(41,204,87,.14)' : undefined, borderRadius: 5, padding: '0 2px' }}>$428,750
            {sheet > 0.005 && (
              <div style={{ position: 'absolute', left: -230, top: 60, width: 660, opacity: sheet, transform: `translateY(${((1 - sheet) * 10).toFixed(2)}px)`, background: C.white, borderRadius: 20, boxShadow: '0 0 0 1px rgba(0,0,0,.07), 0 22px 60px rgba(0,0,0,.14)', padding: 20, fontSize: 20, whiteSpace: 'normal' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700, fontSize: 21 }}><LassoMark size={24} /> Share source<span style={{ marginLeft: 'auto', fontFamily: MONO, fontWeight: 400, fontSize: 16, color: C.ink3 }}>Q4_Budget_Final.xlsx</span></div>
                <div style={{ display: 'flex', gap: 10, margin: '14px 0' }}>
                  {['Row 47', 'Whole file', 'Redact the rest'].map((o, k) => (
                    <span key={o} style={{ padding: '8px 16px', borderRadius: 999, fontWeight: 600, fontSize: 18, background: k === opt ? C.ink : '#f4f2ef', color: k === opt ? '#fff' : C.ink2 }}>{o}</span>
                  ))}
                </div>
                <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid #ecebe8', fontFamily: MONO, fontSize: 17 }}>
                  {rows.map(([r, a, v], k) => {
                    const hide = r !== 47, w = hide ? ramp(f, SH_SWEEP + k * 2, SH_SWEEP + k * 2 + 12, easeInOut) : 0;
                    return (
                      <div key={r} style={{ position: 'relative', display: 'grid', gridTemplateColumns: '50px 1fr 130px', padding: '8px 12px', borderTop: k ? '1px solid #f0eeeb' : undefined, background: r === 47 ? '#fff4cc' : undefined, fontWeight: r === 47 ? 600 : 400 }}>
                        <span style={{ color: C.ink3 }}>{r}</span><span style={{ fontFamily: SANS, fontSize: 18 }}>{a}</span><span style={{ textAlign: 'right' }}>{v}</span>
                        {w > 0 && <span style={{ position: 'absolute', left: 58, top: 7, bottom: 7, width: `calc(${(w * 100).toFixed(1)}% - 70px)`, background: '#111', borderRadius: 3 }} />}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </span>.
        </div>
        {done > 0.005 && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 34, display: 'flex', justifyContent: 'center', opacity: done, transform: `translateY(${((1 - done) * 16).toFixed(1)}px)` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 24px', borderRadius: 999, background: C.ink, color: '#fff', fontFamily: SANS, fontSize: 22, fontWeight: 600 }}>
              <span style={{ width: 28, height: 28, borderRadius: 14, background: C.green, display: 'grid', placeItems: 'center', fontSize: 16 }}>✓</span>
              Link copied <span style={{ fontFamily: MONO, fontWeight: 400, opacity: 0.7, fontSize: 19 }}>Row 47 · everything else redacted</span>
            </div>
          </div>
        )}
      </Win>
      {keysOn > 0.01 && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 70, display: 'flex', justifyContent: 'center', gap: 12, opacity: keysOn }}>
          <Keycap label="⇧" pressed={kp} size={30} /><Keycap label="⌘" pressed={kp} size={30} /><Keycap label="↵" pressed={kp} size={30} />
        </div>
      )}
    </CardFrame>
  );
};

export const Capabilities: React.FC = () => {
  const f = useCurrentFrame();
  const label = ramp(f, S[3] + 96, S[3] + 116);
  return (
    <Shot dur={CAP} bg={C.white} outF={16}>
      <AbsoluteFill style={{ transformOrigin: '0 0', transform: camera(f, CAM) }}>
        {[0, 1, 2].map((i) => <RetrievalCard key={i} i={i} f={f} />)}
        <ShareCard f={f} />
      </AbsoluteFill>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 28, textAlign: 'center', fontFamily: SANS, fontSize: 26, fontWeight: 600, color: C.ink2, opacity: label }}>Any file on your machine. Any field you write in.</div>
    </Shot>
  );
};
export const capCues: Cue[] = [
  ...[1, 2, 3].map((i) => ({ f: S[i] - 18, s: 'whoosh', v: 0.3 })),
  ...sched.flatMap((sc, i) => [...sc.filter((_, k) => k % 2 === 0).map((f) => ({ f, s: 'key', v: 0.55 })), { f: TAB_AT(i), s: 'tab', v: 0.6 }, { f: TAB_AT(i) + 2, s: 'chime', v: 0.18 }]),
  { f: SH_KEY, s: 'tab', v: 0.6 }, { f: SH_REDACT, s: 'key', v: 0.4 }, { f: SH_DONE, s: 'notify', v: 0.3 },
  { f: S[3] + 72, s: 'whoosh', v: 0.35 },
];
