import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { C, BAR } from './kit';
import type { Cue } from '../v2/cues';
import { Story, STORY, storyCues } from './scenes/Story';
import { Demo, DEMO, PAN, demoCues } from './scenes/Demo';
import { Finds, FINDS } from './scenes/Finds';
import { Features, FEAT, featCues } from './scenes/Features';
import { End, END } from './scenes/End';
import { Wallpaper, ramp } from './kit';

export const FPS = 60;
export const DURATION = BAR * 25; // 50 s at 120 BPM

// scenes in order; `x` frames of overlap with the previous scene (for camera-led hand-offs)
const PLAN: { C: React.FC; dur: number; x?: number; cues?: Cue[] }[] = [
  { C: Story, dur: STORY, cues: storyCues },
  { C: Demo, dur: DEMO, cues: demoCues },
  { C: Finds, dur: FINDS, x: PAN },
  { C: Features, dur: FEAT, cues: featCues },
  { C: End, dur: END },
];
const TIMELINE = (() => { let at = 0; return PLAN.map((p) => { const from = at - (p.x ?? 0); at = from + p.dur; return { ...p, from }; }); })();
const WallLayer: React.FC<{ len: number }> = ({ len }) => {
  const f = useCurrentFrame();
  const a = ramp(f, 0, 40), z = ramp(f, len - 40, 40);
  return <AbsoluteFill style={{ opacity: a * (1 - z) }}><Wallpaper blur={(1 - a) * 30 + z * 30} /></AbsoluteFill>;
};
if (TIMELINE[TIMELINE.length - 1].from + TIMELINE[TIMELINE.length - 1].dur !== DURATION) console.warn('timeline length mismatch');
const LEN: Record<string, number> = { key: 6, tab: 9, clack: 12, ding: 100, notify: 72, chime: 96 };

export const Trailer: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    {/* one wallpaper under the whole product section, so hand-offs between scenes stay continuous */}
    <Sequence from={TIMELINE[1].from - 30} durationInFrames={TIMELINE[4].from - TIMELINE[1].from + 60}><WallLayer len={TIMELINE[4].from - TIMELINE[1].from + 60} /></Sequence>
    {TIMELINE.map(({ C: Scene, from, dur }, i) => (
      <Sequence key={i} from={from} durationInFrames={dur}><Scene /></Sequence>
    ))}
    <Audio src={staticFile('sfx/score50.wav')} volume={0.9} />
    {TIMELINE.flatMap((s, i) => (s.cues ?? []).map((c, k) => (
      <Sequence key={`${i}-${k}`} from={s.from + c.f} durationInFrames={LEN[c.s] ?? 60} layout="none">
        <Audio src={staticFile(`sfx/${c.s}.wav`)} volume={c.v ?? 1} />
      </Sequence>
    )))}
  </AbsoluteFill>
);
