import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { C, SERIF, SANS, MONO, Shot, Words, ramp, lerp, clamp, easeInOut, Cue } from '../lib';
import { PALS, HAND, charSVG, thrownRope, toWorld, blink, Char } from '../../characters';

export const OUTRO = 164;
const THROW = 52, LAND = 72, CINCH = 80;
const WORD = { x: 960, y: 452 };

export const Outro: React.FC = () => {
  const f = useCurrentFrame();
  // the cowboy hops in from the left, twirls, throws, pulls
  const hop = ramp(f, 0, 22, easeInOut);
  const cbx = lerp(130, 330, hop), lift = Math.abs(Math.sin(hop * Math.PI * 2)) * 34 * (1 - hop * 0.3);
  const thrown = f >= THROW;
  const cinch = ramp(f, CINCH, CINCH + 8, easeInOut);
  const recoil = f >= CINCH ? Math.sin((f - CINCH) * 0.5) * Math.exp(-(f - CINCH) / 10) : 0;
  const cowboy: Char = {
    kind: 'cowboy', pal: PALS.bluegrass, x: cbx, y: 900, k: 2.5, lift, face: 1, seed: 3,
    hand: f < 16 ? HAND.idle : !thrown ? HAND.up : f < CINCH ? HAND.throw : HAND.pull,
    rope: f < 16 ? 'coil' : !thrown ? 'twirl' : 'none', twirlA: f * 0.55,
    rot: f >= CINCH ? -6 * cinch + recoil * 4 : 0, eyeOpen: blink(f, 1), mood: f >= CINCH + 4 ? 'happy' : 'normal', look: { x: 1, y: -0.4 },
  };
  const cgIn = ramp(f, 8, 30, easeInOut);
  const cgHop = f >= CINCH + 6 ? Math.abs(Math.sin((f - CINCH - 6) * 0.22)) * 26 * Math.exp(-(f - CINCH - 6) / 30) : 0;
  const cowgirl: Char = {
    kind: 'cowgirl', pal: PALS.rodeo, x: lerp(1800, 1610, cgIn), y: 900, k: 2.3, face: -1, seed: 5, lift: cgHop + Math.abs(Math.sin(cgIn * Math.PI * 2)) * 30,
    hand: HAND.idle, rope: 'coil', eyeOpen: blink(f, 4), mood: f >= CINCH + 6 ? 'happy' : 'normal', look: { x: 1, y: -0.5 },
  };
  // the loop: flies from the hand in an arc, opens wide, then cinches around the word
  let rope = '';
  if (thrown) {
    const H = toWorld(cowboy, HAND.throw.x, HAND.throw.y);
    const u = ramp(f, THROW, LAND, easeInOut);
    const L = { x: lerp(H.x + 40, WORD.x, u), y: lerp(H.y - 60, WORD.y, u) - Math.sin(u * Math.PI) * 170 };
    const rx = lerp(lerp(40, 400, u), 352, cinch), ry = lerp(lerp(14, 150, u), 122, cinch);
    rope = thrownRope(cowboy, L, rx, ry, f < LAND ? 0.3 : lerp(0.3, 1, cinch), 7);
  }
  const squeeze = f >= CINCH ? 1 - 0.04 * Math.sin(Math.min(1, (f - CINCH) / 10) * Math.PI) : 1;
  const wordIn = ramp(f, 4, 26);
  const tag = ramp(f, CINCH + 18, CINCH + 40);
  return (
    <Shot dur={OUTRO} bg={C.sand} outF={1}>
      <AbsoluteFill style={{ transform: `scale(${interpolate(f, [0, OUTRO], [1.04, 1], { ...clamp, easing: easeInOut })})` }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: WORD.y - 150, textAlign: 'center', fontFamily: SERIF, fontWeight: 600, fontSize: 236, letterSpacing: '-0.035em', color: C.ink, lineHeight: 1, opacity: wordIn, filter: wordIn < 1 ? `blur(${((1 - wordIn) * 12).toFixed(2)}px)` : undefined, transform: `scaleX(${squeeze})` }}>Lasso</div>
        <svg viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0 }} dangerouslySetInnerHTML={{ __html: `<ellipse cx="${cowboy.x}" cy="904" rx="150" ry="16" fill="rgba(0,0,0,.06)"/><ellipse cx="${cowgirl.x}" cy="904" rx="140" ry="15" fill="rgba(0,0,0,.06)"/>` + charSVG(cowboy, f) + charSVG(cowgirl, f) + rope }} />
        <div style={{ position: 'absolute', left: 0, right: 0, top: 690, textAlign: 'center' }}>
          <div style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 56, letterSpacing: '-0.015em', color: C.ink }}><Words text="Find what you need to say." start={CINCH + 16} per={4} dur={20} /></div>
          <div style={{ marginTop: 22, fontFamily: SANS, fontSize: 25, fontWeight: 500, color: C.ink2, opacity: tag }}>Local-first · No API key · <span style={{ fontFamily: MONO, fontSize: 23 }}>github.com/jte700/Lasso</span></div>
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: C.sand, opacity: ramp(f, OUTRO - 14, OUTRO, easeInOut) }} />
    </Shot>
  );
};
export const outroCues: Cue[] = [{ f: THROW - 2, s: 'whoosh', v: 0.4 }, { f: CINCH, s: 'hit', v: 0.9 }];
