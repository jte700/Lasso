// The link preview for mylasso.ca (og:video, with a still of it as og:image). An 8-second seamless loop:
// the cowboy lassoes the wordmark, the cowgirl cheers, and both clear the stage so the loop's end meets its start.
// The file begins at the celebration and ends on it, so a player that doesn't loop still stops on the best shot.
// `npm run render:og` writes it to website/og/: the video, and frame 440 (mid-twirl) as the still.
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { C, SANS, BEAT, sp, ramp, lerp, EASE, EXIT, ENTER } from '../v4/kit';
import { PALS, HAND, charSVG, thrownRope, toWorld, blink, Char } from '../characters';

export const FPS = 60;
export const OG_W = 1200, OG_H = 630; // 1.91:1, the Open Graph large-image size
export const DURATION = 480;

/* drawn on a 1920×1008 stage, then scaled down to the output size */
const SW = 1920, SH = 1008, K = OG_W / SW;
const W = { x: 960, y: 320 }; // the wordmark, and the loop around it
const G = 970;                // the ground line, with both characters standing under the wordmark
const RX = 650, RY = 240, CK = 2.3;

/* the loop's own clock: 0 is the empty stage where the loop joins */
const THROW = 120, CINCH = THROW + BEAT, RELEASE = CINCH + 46, GIRL = CINCH + 6, LEAVE = 400;
const START = 330; // file frame 0 sits here on the loop's clock, in the celebration

const CHEER = { x: 60, y: -132 }; // a raised arm low enough that her twirl clears the loop
const jump = (t: number, at: number, d = 24, h = 50) => (t >= at && t < at + d ? Math.sin(((t - at) / d) * Math.PI) * h : 0);
const shadow = (c: Char) => `<ellipse cx="${c.x.toFixed(1)}" cy="${G + 5}" rx="${(150 * (1 - Math.min(0.5, (c.lift ?? 0) / 200))).toFixed(1)}" ry="16" fill="rgba(0,0,0,.06)"/>`;

export const Preview: React.FC = () => {
  const t = (useCurrentFrame() + START) % DURATION;
  const ct = t / 2;

  // the cowboy: hops in, twirls, throws on the beat, cinches, celebrates, hops off
  const hop = sp(t, 6, 20, 110), leave = ramp(t, LEAVE, 44, EXIT), thrown = t >= THROW && t < LEAVE;
  const cinch = ramp(t, CINCH, 12, EASE);
  const cowboy: Char = {
    kind: 'cowboy', pal: PALS.bluegrass, x: lerp(-220, 520, hop) - leave * 900, y: G, k: CK, seed: 3, face: t >= LEAVE ? -1 : 1,
    lift: Math.abs(Math.sin(hop * Math.PI * 3)) * 46 + Math.abs(Math.sin(leave * Math.PI * 3)) * 46 + jump(t, 262, 24, 60),
    hand: t < 40 ? HAND.idle : t < THROW ? HAND.up : t < CINCH ? HAND.throw : t < RELEASE ? HAND.pull : HAND.idle,
    rope: t < 40 ? 'coil' : t < THROW ? 'twirl' : 'none', twirlA: t * 0.32,
    eyeOpen: blink(ct, 2), mood: t >= CINCH + 4 && t < LEAVE ? 'happy' : 'normal', look: { x: 0.6, y: -1 },
  };

  // the cowgirl: arrives as the rope cinches, hops twice, then twirls her rope overhead
  const hopG = sp(t, GIRL, 20, 110), leaveG = ramp(t, LEAVE + 8, 44, EXIT), cheer = t >= 250 && t < 330;
  const lean = jump(t, 214, 24, 1) + jump(t, 238, 24, 1);
  const cowgirl: Char = {
    kind: 'cowgirl', pal: PALS.rodeo, x: lerp(2180, 1400, hopG) + leaveG * 900, y: G, k: CK, seed: 5, face: t >= LEAVE + 8 ? 1 : -1,
    lift: Math.abs(Math.sin(hopG * Math.PI * 3)) * 46 + Math.abs(Math.sin(leaveG * Math.PI * 3)) * 46 + jump(t, 214, 24, 44) + jump(t, 238, 24, 44),
    sx: 1 - lean * 0.04, sy: 1 + lean * 0.06,
    hand: cheer ? CHEER : HAND.idle, rope: cheer ? 'twirl' : 'coil', twirlA: t * 0.36,
    eyeOpen: blink(ct, 5), mood: t >= GIRL + 30 && t < LEAVE ? 'happy' : 'normal', look: { x: 0.6, y: -1 },
  };

  // the thrown rope arcs from the hand to the wordmark, opens wide, then cinches
  let rope = '';
  if (thrown && t < RELEASE) {
    const H = toWorld(cowboy, HAND.throw.x, HAND.throw.y), u = ramp(t, THROW, BEAT, EASE);
    const L = { x: lerp(H.x + 40, W.x, u), y: lerp(H.y - 60, W.y, u) - Math.sin(u * Math.PI) * 150 };
    rope = thrownRope(cowboy, L, lerp(lerp(40, RX + 50, u), RX, cinch), lerp(lerp(14, RY + 24, u), RY, cinch), t < CINCH ? 0.3 : lerp(0.3, 1, cinch), 8);
  }

  // once he lets go, a green loop stays around the wordmark; on the way out its tail chases its head away
  const out = ramp(t, LEAVE + 20, 48, EASE), loop = t >= LEAVE ? 1 - out : sp(t, RELEASE - 6, 22, 140);
  const green = loop > 0.003 ? `<ellipse cx="${W.x}" cy="${W.y}" rx="${RX}" ry="${RY}" fill="none" stroke="${C.green}" stroke-width="11" stroke-linecap="round" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="${(t >= LEAVE ? -out : Math.max(0, 1 - loop)).toFixed(4)}"/>` : '';

  // the cinch: rays burst off the loop, the wordmark squashes, and the camera kicks in
  const burst = ramp(t, CINCH + 3, 20, ENTER), fade = 1 - ramp(t, CINCH + 10, 18, EASE);
  let rays = '';
  if (t >= CINCH + 3 && fade > 0.01)
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.26, bx = W.x + RX * Math.cos(a), by = W.y + RY * Math.sin(a);
      const nx = Math.cos(a) / RX, ny = Math.sin(a) / RY, n = Math.hypot(nx, ny), d0 = lerp(44, 100, burst), d1 = d0 + 58 * fade;
      rays += `<path d="M${(bx + (nx / n) * d0).toFixed(1)} ${(by + (ny / n) * d0).toFixed(1)}L${(bx + (nx / n) * d1).toFixed(1)} ${(by + (ny / n) * d1).toFixed(1)}" stroke="${C.green}" stroke-width="10" stroke-linecap="round"/>`;
    }
  const squash = t >= CINCH && t < CINCH + 16 ? Math.sin(((t - CINCH) / 16) * Math.PI) : 0;
  const kick = t >= CINCH && t < CINCH + 30 ? Math.sin(((t - CINCH) / 30) * Math.PI) * 0.03 : 0;

  return (
    <AbsoluteFill style={{ background: C.white }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: SW, height: SH, transformOrigin: '0 0', transform: `scale(${K})` }}>
        <div style={{ position: 'absolute', inset: 0, transformOrigin: `${W.x}px ${W.y}px`, transform: `scale(${(1 + kick).toFixed(4)})` }}>
          <div style={{ position: 'absolute', left: 0, right: 0, top: W.y - 175, textAlign: 'center', fontFamily: SANS, fontWeight: 700, fontSize: 360, letterSpacing: '-0.055em', lineHeight: 1, color: C.greenD, transform: `scale(${(1 - 0.05 * squash).toFixed(4)}, ${(1 + 0.03 * squash).toFixed(4)})` }}>Lasso</div>
          <svg viewBox={`0 0 ${SW} ${SH}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} dangerouslySetInnerHTML={{ __html:
            shadow(cowboy) + shadow(cowgirl) + charSVG(cowboy, ct) + charSVG(cowgirl, ct) + rope
            + `<g transform="rotate(-2 ${W.x} ${W.y})">${green}${rays}</g>` }} />
        </div>
      </div>
    </AbsoluteFill>
  );
};
