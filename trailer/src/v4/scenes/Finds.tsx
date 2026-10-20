import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { C, SANS, Cursor, Selected, sp, glide, ramp, EXIT } from '../kit';
import { PAN, panU, HANDOFF_CURSOR } from './Demo';

/* ───────────── 0:32–0:36 · "Lasso finds what you need to say." ─────────────
   Arrives from the right as the camera follows the cursor out of the email; the cursor then selects "finds". */
export const FINDS = 260; // includes the PAN frames shared with the email scene
const SEL = PAN + 96;
export const Finds: React.FC = () => {
  const f = useCurrentFrame();
  const pan = panU(f);
  const w = (s: string, at: number, extra?: React.CSSProperties) => {
    const k = sp(f, at, 20, 160);
    return <span style={{ display: 'inline-block', whiteSpace: 'pre', opacity: Math.min(1, k * 1.4), transform: `translateY(${((1 - k) * 0.3).toFixed(3)}em)`, filter: k < 0.98 ? `blur(${((1 - k) * 10).toFixed(1)}px)` : undefined, ...extra }}>{s}</span>;
  };
  const gone = ramp(f, FINDS - 26, 26, EXIT);
  // the cursor continues from the email scene, then sweeps across "finds"
  const cur = glide(f, [[PAN, HANDOFF_CURSOR.x, HANDOFF_CURSOR.y], [SEL - 4, 440, 494], [SEL + 16, 694, 498], [FINDS, 960, 760]]);
  const dragging = f >= SEL - 4 && f < SEL + 18;
  return (
    <AbsoluteFill style={{ transform: `translateX(${((1 - pan) * 1920).toFixed(1)}px) scale(${(1 + gone * 0.08).toFixed(4)})`, opacity: 1 - gone, filter: gone > 0.01 ? `blur(${(gone * 20).toFixed(1)}px)` : undefined }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 380, textAlign: 'center', fontFamily: SANS, letterSpacing: '-0.03em', color: '#fff' }}>
        <div style={{ fontSize: 50, fontWeight: 600, color: 'rgba(255,255,255,.72)' }}>{w('Autocomplete ', PAN - 30)}{w('predicted ', PAN - 24)}{w('what you wanted to say.', PAN - 18)}</div>
        <div style={{ fontSize: 104, fontWeight: 700, marginTop: 18, letterSpacing: '-0.04em', textShadow: '0 6px 30px rgba(0,0,0,.18)' }}>
          {w('Lasso ', PAN + 34)}{w('', PAN)}<span style={{ display: 'inline-block', opacity: Math.min(1, sp(f, PAN + 42, 20, 160) * 1.4) }}><Selected at={SEL} dur={18} color={C.green}>finds</Selected></span>{w(' what you need to say.', PAN + 52)}
        </div>
      </div>
      {f >= PAN && <div style={{ transform: `translateX(${(-(1 - pan) * 1920).toFixed(1)}px)` }}><Cursor x={cur.x} y={cur.y} vx={cur.v} press={dragging ? 0.6 : 0} scale={1.6} /></div>}
    </AbsoluteFill>
  );
};
