import React from 'react';
import { AbsoluteFill, interpolate, random, useCurrentFrame } from 'remotion';
import { C, SANS, BAR, BEAT, Words, LassoMark, ramp, lerp, clamp, EASE, ENTER, EXIT, S } from '../kit';
import { ellipse, boilAt } from '../sketch';
import { PALS, HAND, charSVG, thrownRope, toWorld, blink, Char } from '../../characters';
import type { Cue } from '../../v2/cues';

/* ───────────── G · the ending (bars 27–30) ───────────── */
export const END = BAR * 3;
const GREEN = 110, WORD = BAR - 40, CINCH = BAR, DARK = 300;

const Pixels: React.FC<{ color: string; dim?: number }> = ({ color, dim = 1 }) => {
  const f = useCurrentFrame();
  const cells = [];
  for (let i = 0; i < 80; i++) {
    const x = Math.floor(random(`px${i}`) * 24) * 80, y = Math.floor(random(`py${i}`) * 14) * 80;
    const o = (0.5 + 0.5 * Math.sin(f * 0.05 + random(`pp${i}`) * 9)) * 0.14 * dim;
    cells.push(<div key={i} style={{ position: 'absolute', left: x, top: y, width: 80, height: 80, background: color, opacity: o }} />);
  }
  return <>{cells}</>;
};

export const End: React.FC = () => {
  const f = useCurrentFrame();
  // 1 · a full-bleed green beat
  const green = 1 - ramp(f, GREEN - 14, 16, EXIT);
  // 2 · the wordmark, lassoed on the downbeat
  const word = ramp(f, WORD - 50, S, ENTER) * (1 - ramp(f, DARK - 14, 16, EXIT));
  const ct = f / 2, hop = ramp(f, WORD - 60, 40, EASE), thrown = f >= CINCH - BEAT;
  const cinch = ramp(f, CINCH, 14, EASE), leave = ramp(f, CINCH + 70, 40, EXIT);
  const cowboy: Char = {
    kind: 'cowboy', pal: PALS.bluegrass, x: lerp(-160, 380, hop) - leave * 600, y: 930, k: 2.1, lift: Math.abs(Math.sin(hop * Math.PI * 2)) * 36, face: 1, seed: 3,
    hand: f < WORD - 20 ? HAND.idle : !thrown ? HAND.up : f < CINCH ? HAND.throw : f < CINCH + 50 ? HAND.pull : HAND.idle,
    rope: f < WORD - 20 ? 'coil' : !thrown ? 'twirl' : 'none', twirlA: f * 0.3, eyeOpen: blink(ct, 2), mood: f >= CINCH + 6 ? 'happy' : 'normal', look: { x: 1, y: -0.4 },
  };
  let rope = '';
  const W = { x: 960, y: 500 };
  if (thrown && f < CINCH + 50) {
    const H = toWorld(cowboy, HAND.throw.x, HAND.throw.y), u = ramp(f, CINCH - BEAT, BEAT, EASE);
    const Lp = { x: lerp(H.x + 40, W.x, u), y: lerp(H.y - 60, W.y, u) - Math.sin(u * Math.PI) * 160 };
    rope = thrownRope(cowboy, Lp, lerp(lerp(40, 440, u), 400, cinch), lerp(lerp(14, 160, u), 140, cinch), f < CINCH ? 0.3 : lerp(0.3, 1, cinch), 6);
  }
  const loopP = ramp(f, CINCH + 40, 30, EASE);
  // 3 · the dark end card
  const dark = ramp(f, DARK - 10, 24, EASE), fin = ramp(f, END - 30, 30, EASE);
  return (
    <AbsoluteFill style={{ background: C.white }}>
      {green > 0.01 && (
        <AbsoluteFill style={{ background: `linear-gradient(135deg, ${C.greenD}, ${C.green})`, opacity: green }}>
          <Pixels color="#ffffff" />
          <div style={{ position: 'absolute', left: 0, right: 0, top: 470 }}>
            <Words text="Every number. Every clause." start={4} step={7} size={56} color="#fff" accent="#d6ffe3" />
            <Words text="One tab away." start={46} step={8} size={56} color="#fff" accent="#d6ffe3" />
          </div>
        </AbsoluteFill>
      )}
      {word > 0.01 && (
        <AbsoluteFill style={{ opacity: word, transform: `scale(${interpolate(f, [WORD - 50, DARK], [1.04, 1], { ...clamp, easing: EASE })})` }}>
          <div style={{ position: 'absolute', left: 0, right: 0, top: W.y - 130, textAlign: 'center', fontFamily: SANS, fontWeight: 700, fontSize: 240, letterSpacing: '-0.055em', lineHeight: 1, color: C.greenD, filter: word < 0.99 ? `blur(${((1 - word) * 16).toFixed(1)}px)` : undefined }}>Lasso</div>
          <svg viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0, overflow: 'visible' }} dangerouslySetInnerHTML={{ __html:
            `<ellipse cx="${cowboy.x}" cy="934" rx="130" ry="14" fill="rgba(0,0,0,.06)"/>` + charSVG(cowboy, ct) + rope
            + ellipse(W.x, W.y, 410, 146, loopP, 5150, boilAt(f), -0.03, 6).map((s) => `<path d="${s.d}" fill="none" stroke="${C.green}" stroke-opacity="${s.o}" stroke-width="${s.w}" stroke-linecap="round"/>`).join('') }} />
        </AbsoluteFill>
      )}
      {dark > 0.01 && (
        <AbsoluteFill style={{ background: '#090c0a', opacity: dark }}>
          <Pixels color={C.green} dim={0.6} />
          <div style={{ position: 'absolute', left: 0, right: 0, top: 330, display: 'flex', justifyContent: 'center', opacity: ramp(f, DARK + 6, S, ENTER), filter: `drop-shadow(0 0 30px rgba(41,204,87,.8))` }}>
            <div style={{ width: 120, height: 120, borderRadius: 30, background: 'linear-gradient(160deg, #1d2a22, #0e1611)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,.12)', display: 'grid', placeItems: 'center' }}><LassoMark size={78} draw={ramp(f, DARK + 10, 40)} stroke={2.8} /></div>
          </div>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 500 }}>
            <Words text="Find what you need to say." start={DARK + 24} step={6} size={52} color="#fff" accent="#9cf0b6" />
            <Words text="Right where you type." start={DARK + 60} step={6} size={52} color="rgba(255,255,255,.62)" accent="#9cf0b6" />
          </div>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 690, textAlign: 'center', fontFamily: SANS, fontSize: 22, fontWeight: 500, color: 'rgba(255,255,255,.4)', opacity: ramp(f, DARK + 96, S) }}>Local-first · No API key · github.com/jte700/Lasso</div>
        </AbsoluteFill>
      )}
      {fin > 0.01 && <AbsoluteFill style={{ background: '#000', opacity: fin }} />}
    </AbsoluteFill>
  );
};
export const endCues: Cue[] = [];
