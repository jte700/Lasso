import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { C, SANS, BAR, BEAT, LassoMark, sp, ramp, lerp, clamp, EASE, EXIT } from '../kit';
import { PALS, HAND, charSVG, thrownRope, toWorld, blink, Char } from '../../characters';

/* ───────────── 0:46–0:50 · the wordmark, lassoed on the downbeat ───────────── */
export const END = BAR * 2; // 240
const CINCH = BAR, RELEASE = CINCH + 46, TAG = CINCH + 30;
export const End: React.FC = () => {
  const f = useCurrentFrame();
  const word = sp(f, 4, 20, 120);
  const ct = f / 2, hop = sp(f, 10, 20, 110), thrown = f >= CINCH - BEAT;
  const cinch = ramp(f, CINCH, 12, EASE), leave = ramp(f, RELEASE + 20, 40, EXIT);
  const cowboy: Char = {
    kind: 'cowboy', pal: PALS.bluegrass, x: lerp(-160, 360, hop) - leave * 600, y: 920, k: 2.0, lift: Math.abs(Math.sin(hop * Math.PI * 2)) * 30, face: 1, seed: 3,
    hand: f < 40 ? HAND.idle : !thrown ? HAND.up : f < CINCH ? HAND.throw : f < RELEASE ? HAND.pull : HAND.idle,
    rope: f < 40 ? 'coil' : !thrown ? 'twirl' : 'none', twirlA: f * 0.32, eyeOpen: blink(ct, 2), mood: f >= CINCH + 4 ? 'happy' : 'normal', look: { x: 1, y: -0.4 },
  };
  const W = { x: 960, y: 470 };
  let rope = '';
  if (thrown && f < RELEASE) {
    const H = toWorld(cowboy, HAND.throw.x, HAND.throw.y), u = ramp(f, CINCH - BEAT, BEAT, EASE);
    const Lp = { x: lerp(H.x + 40, W.x, u), y: lerp(H.y - 60, W.y, u) - Math.sin(u * Math.PI) * 150 };
    rope = thrownRope(cowboy, Lp, lerp(lerp(40, 440, u), 400, cinch), lerp(lerp(14, 160, u), 140, cinch), f < CINCH ? 0.3 : lerp(0.3, 1, cinch), 6);
  }
  // after the cowboy lets go, a clean green loop stays around the wordmark
  const loop = sp(f, RELEASE - 6, 22, 140);
  const fin = ramp(f, END - 22, 22, EASE);
  const tag = (s: string, at: number) => { const k = sp(f, at, 20, 160); return <span style={{ display: 'inline-block', whiteSpace: 'pre', opacity: Math.min(1, k * 1.4), transform: `translateY(${((1 - k) * 0.3).toFixed(3)}em)`, filter: k < 0.98 ? `blur(${((1 - k) * 10).toFixed(1)}px)` : undefined }}>{s}</span>; };
  return (
    <AbsoluteFill style={{ background: `rgba(255,255,255,${ramp(f, 0, 18).toFixed(3)})` }}>
      <AbsoluteFill style={{ transform: `scale(${interpolate(f, [0, END], [1.04, 1], { ...clamp, easing: EASE })})` }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: W.y - 130, textAlign: 'center', fontFamily: SANS, fontWeight: 700, fontSize: 240, letterSpacing: '-0.055em', lineHeight: 1, color: C.greenD, opacity: Math.min(1, word * 1.4), filter: word < 0.98 ? `blur(${((1 - word) * 16).toFixed(1)}px)` : undefined, transform: `translateY(${((1 - word) * 40).toFixed(1)}px) scaleX(${f >= CINCH ? (1 - 0.04 * Math.sin(Math.min(1, (f - CINCH) / 16) * Math.PI)).toFixed(4) : 1})` }}>Lasso</div>
        <svg viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0, overflow: 'visible' }} dangerouslySetInnerHTML={{ __html:
          `<ellipse cx="${cowboy.x}" cy="924" rx="120" ry="13" fill="rgba(0,0,0,.06)"/>` + charSVG(cowboy, ct) + rope
          + (loop > 0.01 ? `<ellipse cx="${W.x}" cy="${W.y}" rx="400" ry="140" fill="none" stroke="${C.green}" stroke-width="7" pathLength="1" stroke-dasharray="1" stroke-dashoffset="${(1 - loop).toFixed(4)}" transform="rotate(-3 ${W.x} ${W.y})"/>` : '') }} />
        <div style={{ position: 'absolute', left: 0, right: 0, top: 690, textAlign: 'center', fontFamily: SANS, fontWeight: 700, fontSize: 60, letterSpacing: '-0.035em', color: C.ink }}>
          {tag('Find ', TAG)}{tag('what you ', TAG + 6)}<span style={{ color: C.greenD }}>{tag('need to say.', TAG + 12)}</span>
        </div>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 790, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, fontFamily: SANS, fontSize: 24, fontWeight: 500, color: C.ink3, opacity: sp(f, TAG + 40, 20, 140) }}>
          <LassoMark size={26} /> Local-first · No API key · github.com/jte700/Lasso
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: C.white, opacity: fin }} />
    </AbsoluteFill>
  );
};
