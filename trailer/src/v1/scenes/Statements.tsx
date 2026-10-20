import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { C, SERIF, Shot, Words, Caret, ramp, easeInOut, clamp } from '../lib';

/* "Typing got faster. / Finding didn't." then the thesis */
export const BREAK = 246;
export const Interruption: React.FC = () => {
  const f = useCurrentFrame();
  const a = 1 - ramp(f, 118, 136, easeInOut); // first card leaves
  const b = ramp(f, 132, 150);
  const dim = ramp(f, 58, 76);
  return (
    <Shot dur={BREAK} bg={C.white} cut>
      {/* a lone caret holds the silence before the words */}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: 1 - ramp(f, 12, 18) }}>
        <div style={{ fontFamily: SERIF, fontSize: 100 }}><Caret color={C.ink} on={false} /></div>
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: a, filter: a < 1 ? `blur(${((1 - a) * 12).toFixed(2)}px)` : undefined, transform: `scale(${interpolate(f, [0, 136], [1, 1.04])})` }}>
        <div style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 118, letterSpacing: '-0.025em', lineHeight: 1.12, textAlign: 'center' }}>
          <div style={{ color: `rgba(0,0,0,${(1 - dim * 0.62).toFixed(3)})` }}><Words text="Typing got faster." start={16} per={5} dur={20} /></div>
          <div style={{ color: C.ink }}><Words text="Finding didn’t." start={58} per={7} dur={22} /></div>
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: b, transform: `scale(${interpolate(f, [132, BREAK], [1.02, 1.06], clamp)})` }}>
        <div style={{ textAlign: 'center', fontFamily: SERIF, fontWeight: 600, letterSpacing: '-0.02em' }}>
          <div style={{ fontSize: 56, color: C.ink3, lineHeight: 1.2 }}><Words text="The modern bottleneck isn’t typing anymore." start={136} per={3} dur={20} /></div>
          <div style={{ fontSize: 96, color: C.ink, marginTop: 26, lineHeight: 1.1 }}><Words text="It’s finding what you need to type." start={168} per={5} dur={22} /></div>
        </div>
      </AbsoluteFill>
    </Shot>
  );
};

/* "Autocomplete predicted…" / "Lasso finds…" with a hand-drawn lasso around "finds" */
export const LEAP = 170;
export const Leap: React.FC = () => {
  const f = useCurrentFrame();
  const loop = ramp(f, 82, 112, easeInOut);
  const dim = ramp(f, 54, 70);
  return (
    <Shot dur={LEAP} bg={C.white} outF={18}>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', transform: `scale(${interpolate(f, [0, LEAP], [1, 1.05])})` }}>
        <div style={{ textAlign: 'center', fontFamily: SERIF, fontWeight: 600, letterSpacing: '-0.02em' }}>
          <div style={{ fontSize: 64, lineHeight: 1.2, color: `rgba(0,0,0,${(0.85 - dim * 0.45).toFixed(3)})` }}><Words text="Autocomplete predicted what you wanted to say." start={8} per={3} dur={20} /></div>
          <div style={{ fontSize: 100, color: C.ink, marginTop: 34, lineHeight: 1.1 }}>
            <Words text="Lasso" start={52} dur={22} />{' '}
            <span style={{ position: 'relative', display: 'inline-block' }}>
              <Words text="finds" start={58} dur={22} />
              <svg viewBox="0 0 400 200" style={{ position: 'absolute', left: -34, top: -28, width: 330, height: 180, overflow: 'visible' }} preserveAspectRatio="none">
                <path d="M200 26C110 18 22 42 20 102C18 160 120 186 214 180C312 174 392 144 386 92C380 44 300 20 214 24C178 26 150 32 132 40" fill="none" stroke={C.green} strokeWidth="6" strokeLinecap="round" vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - loop} />
                <path d="M300 172C330 196 356 214 392 236" fill="none" stroke={C.green} strokeWidth="6" strokeLinecap="round" vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - ramp(f, 108, 122)} />
              </svg>
            </span>{' '}
            <Words text="what you need to say." start={64} per={4} dur={22} />
          </div>
        </div>
      </AbsoluteFill>
    </Shot>
  );
};

