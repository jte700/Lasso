import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { C, SERIF, BAR, Caption, Liquid, Caret, smear, ramp, life, clamp, EASE, EXIT } from '../kit';

/* ───────────── C · the interruption (bars 10–13): the music stops ───────────── */
export const PAUSE = BAR * 3;
export const Pause: React.FC = () => {
  const f = useCurrentFrame();
  const caret = life(f, 0, 44, 1, 10);
  const FIND = BAR - 10; // "Finding didn't." lands on the electric piano note at bar 11
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      {caret > 0.01 && <div style={{ position: 'absolute', fontFamily: SERIF, fontSize: 120, opacity: caret }}><Caret blink /></div>}
      <div style={{ position: 'absolute', top: 360, left: 0, right: 0, transform: `scale(${interpolate(f, [0, 290], [1, 1.03], clamp)})` }}>
        <Caption text="Typing got faster." start={50} step={11} size={116} color={f > FIND ? 'rgba(20,32,26,.34)' : C.ink} out={262} />
        <Liquid amt={smear(f, FIND + 6, 1, 22)} seed={9}>
          <Caption text="Finding *didn’t.*" start={FIND} step={14} size={116} out={262} />
        </Liquid>
      </div>
      <div style={{ position: 'absolute', top: 390, left: 0, right: 0 }}>
        <Caption text="The modern bottleneck isn’t typing anymore." start={286} step={6} size={52} color={C.ink2} out={PAUSE - 22} />
        <div style={{ height: 22 }} />
        <Caption text="It’s *finding* what you need to type." start={340} step={9} size={96} out={PAUSE - 18} />
      </div>
    </AbsoluteFill>
  );
};

/* ───────────── E · the leap (bars 20–22) ───────────── */
export const LEAP = BAR * 2;
export const Leap: React.FC = () => {
  const f = useCurrentFrame();
  const line = 1 - ramp(f, 0, 30, EASE); // the green underline from the last shot retracts
  const loop = ramp(f, 150, 34, EASE), tail = ramp(f, 178, 14, EASE);
  return (
    <AbsoluteFill>
      {line > 0.01 && <div style={{ position: 'absolute', top: 538, left: 960 - 960 * line, width: 1920 * line, height: 4, borderRadius: 2, background: C.green }} />}
      <div style={{ position: 'absolute', top: 380, left: 0, right: 0, transform: `scale(${interpolate(f, [0, LEAP], [1, 1.04], clamp)})` }}>
        <Caption text="Autocomplete predicted what you wanted to say." start={22} step={6} size={58} color={C.ink3} out={LEAP - 20} />
        <div style={{ height: 30 }} />
        <div style={{ position: 'relative' }}>
          <Caption text="Lasso *finds* what you need to say." start={110} step={9} size={104} out={LEAP - 16} mark={
          <svg viewBox="0 0 400 200" preserveAspectRatio="none" style={{ position: 'absolute', left: '-14%', top: '-22%', width: '120%', height: '150%', overflow: 'visible', opacity: 1 - ramp(f, LEAP - 18, 14, EXIT) }}>
            <path d="M200 26C110 18 22 42 20 102C18 160 120 186 214 180C312 174 392 144 386 92C380 44 300 20 214 24C178 26 150 32 132 40" fill="none" stroke={C.green} strokeWidth="6" strokeLinecap="round" vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - loop} />
            <path d="M300 172C330 196 356 214 392 236" fill="none" stroke={C.green} strokeWidth="6" strokeLinecap="round" vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - tail} />
          </svg>} />
        </div>
      </div>
    </AbsoluteFill>
  );
};
