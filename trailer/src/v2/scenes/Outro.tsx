import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { C, SERIF, SANS, MONO, BAR, BEAT, Caption, Liquid, LassoMark, smear, ramp, lerp, clamp, EASE, ENTER, EXIT, S } from '../kit';
import { PALS, HAND, charSVG, thrownRope, toWorld, blink, Char } from '../../characters';
import type { Cue } from '../cues';

/* ───────────── G · the wordmark (bars 27–30) ───────────── */
export const OUTRO = BAR * 3;
const THROW = BAR - BEAT, CINCH = BAR; // the loop cinches on the downbeat of bar 28, with the boom
const WORD = { x: 960, y: 450 };
const RELEASE = CINCH + 64, TAG = CINCH + 84, END = OUTRO - 50;

export const Outro: React.FC = () => {
  const f = useCurrentFrame();
  // half-speed character time keeps their motion the same as on the 30 fps site
  const ct = f / 2;
  const hop = ramp(f, 18, 50, EASE);
  const cbx = lerp(-120, 330, hop), lift = Math.abs(Math.sin(hop * Math.PI * 2)) * 40 * (1 - hop * 0.4);
  const twirl = f >= 70 && f < THROW, thrown = f >= THROW;
  const cinch = ramp(f, CINCH, 16, EASE);
  const recoil = f >= CINCH ? Math.sin((f - CINCH) * 0.25) * Math.exp(-(f - CINCH) / 20) : 0;
  const leave = ramp(f, END - 30, 40, EXIT);
  const cowboy: Char = {
    kind: 'cowboy', pal: PALS.bluegrass, x: cbx - leave * 500, y: 920, k: 2.3, lift, face: 1, seed: 3,
    hand: f < 70 ? HAND.idle : !thrown ? HAND.up : f < CINCH ? HAND.throw : f < RELEASE ? HAND.pull : HAND.idle,
    rope: f < 70 ? 'coil' : twirl ? 'twirl' : 'none', twirlA: f * 0.28,
    rot: f >= CINCH ? -6 * cinch + recoil * 4 : 0, eyeOpen: blink(ct, 1), mood: f >= CINCH + 8 ? 'happy' : 'normal', look: { x: 1, y: -0.4 },
  };
  const cgIn = ramp(f, 40, 50, EASE);
  const cgHop = f >= CINCH + 12 ? Math.abs(Math.sin((f - CINCH - 12) * 0.11)) * 26 * Math.exp(-(f - CINCH - 12) / 60) : 0;
  const cowgirl: Char = {
    kind: 'cowgirl', pal: PALS.rodeo, x: lerp(2080, 1600, cgIn) + leave * 500, y: 920, k: 2.15, face: -1, seed: 5, lift: cgHop + Math.abs(Math.sin(cgIn * Math.PI * 2)) * 30,
    hand: HAND.idle, rope: 'coil', eyeOpen: blink(ct, 4), mood: f >= CINCH + 12 ? 'happy' : 'normal', look: { x: 1, y: -0.5 },
  };
  let rope = '';
  const letGo = ramp(f, RELEASE - 10, 24, EASE), green = ramp(f, RELEASE, 40, EASE);
  if (thrown) {
    const H = toWorld(cowboy, HAND.throw.x, HAND.throw.y);
    const u = ramp(f, THROW, CINCH - THROW, EASE);
    const Lp = { x: lerp(H.x + 40, WORD.x, u), y: lerp(H.y - 60, WORD.y, u) - Math.sin(u * Math.PI) * 170 };
    const rx = lerp(lerp(40, 440, u), 382, cinch), ry = lerp(lerp(14, 160, u), 134, cinch);
    if (letGo < 1) rope += `<g opacity="${(1 - letGo).toFixed(3)}">${thrownRope(cowboy, Lp, rx, ry, f < CINCH ? 0.3 : lerp(0.3, 1, cinch), 7)}</g>`;
    const ell = (col: string, o: number, w: number) => `<ellipse cx="${Lp.x.toFixed(1)}" cy="${Lp.y.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="none" stroke="${col}" stroke-opacity="${o.toFixed(3)}" stroke-width="${w.toFixed(2)}"/>`;
    if (letGo > 0) rope += ell('#2b2622', letGo * (1 - green), 7) + ell(C.green, letGo * green, lerp(7, 5, green));
  }
  const squeeze = f >= CINCH ? 1 - 0.04 * Math.sin(Math.min(1, (f - CINCH) / 20) * Math.PI) : 1;
  const fin = ramp(f, OUTRO - 24, 24, EASE);
  return (
    <AbsoluteFill style={{ transform: `scale(${interpolate(f, [0, OUTRO], [1.03, 1], { ...clamp, easing: EASE })})` }}>
      <Liquid amt={smear(f, 6, 1, 30)} seed={21} style={{ position: 'absolute', left: 0, right: 0, top: WORD.y - 150, textAlign: 'center' }}>
        <div style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 250, letterSpacing: '-0.035em', lineHeight: 1, color: C.ink, opacity: ramp(f, 2, S, ENTER), transform: `scaleX(${squeeze})` }}>Lasso</div>
      </Liquid>
      <svg viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0, overflow: 'visible' }} dangerouslySetInnerHTML={{ __html:
        `<ellipse cx="${cowboy.x}" cy="924" rx="140" ry="15" fill="rgba(20,32,26,.06)"/><ellipse cx="${cowgirl.x}" cy="924" rx="130" ry="14" fill="rgba(20,32,26,.06)"/>`
        + charSVG(cowboy, ct) + charSVG(cowgirl, ct) + `${rope}` }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 690 }}>
        <Caption text="Find what you *need to say.*" start={TAG} step={8} size={60} />
        <div style={{ marginTop: 26, textAlign: 'center', fontFamily: SANS, fontWeight: 500, fontSize: 26, color: C.ink2, opacity: ramp(f, TAG + 50, S, ENTER), display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16 }}>
          <LassoMark size={30} draw={ramp(f, TAG + 50, 30)} /> Local-first · No API key · <span style={{ fontFamily: MONO, fontSize: 24 }}>github.com/jte700/Lasso</span>
        </div>
      </div>
      <AbsoluteFill style={{ background: C.bg, opacity: fin }} />
    </AbsoluteFill>
  );
};
export const outroCues: Cue[] = [];
