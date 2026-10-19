import React from 'react';
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile } from 'remotion';
import { C, Cue } from './lib';
import { Open, OPEN, ERA, Handwriting, Typewriter, WordProcessor, Autocomplete, IntelliSense, typewriterCues, wordCues, autoCues, intelliCues } from './scenes/History';
import { Interruption, BREAK, Leap, LEAP } from './scenes/Statements';
import { Workplace, WORK, workCues } from './scenes/Workplace';
import { Capabilities, CAP, capCues } from './scenes/Capabilities';
import { Outro, OUTRO, outroCues } from './scenes/Outro';

export const FPS = 30;
export const DURATION = 2400; // 1:20

// Scenes in order. `x` is how many frames a scene dissolves over the one before it (0 = hard cut).
const PLAN: { C: React.FC; dur: number; x: number; cues?: Cue[]; whoosh?: boolean; pen?: boolean }[] = [
  { C: Open, dur: OPEN, x: 0 },
  { C: Handwriting, dur: ERA, x: 14, whoosh: true, pen: true },
  { C: Typewriter, dur: ERA, x: 0, cues: typewriterCues },
  { C: WordProcessor, dur: ERA, x: 14, cues: wordCues, whoosh: true },
  { C: Autocomplete, dur: ERA, x: 14, cues: autoCues, whoosh: true },
  { C: IntelliSense, dur: ERA, x: 14, cues: intelliCues, whoosh: true },
  { C: Interruption, dur: BREAK, x: 0 },
  { C: Workplace, dur: WORK, x: 14, cues: workCues, whoosh: true },
  { C: Leap, dur: LEAP, x: 14, whoosh: true },
  { C: Capabilities, dur: CAP, x: 14, cues: capCues, whoosh: true },
  { C: Outro, dur: OUTRO, x: 14, cues: outroCues, whoosh: true },
];
const TIMELINE = (() => {
  let at = 0;
  return PLAN.map((p, i) => { const from = i === 0 ? 0 : at - p.x; at = from + p.dur; return { ...p, from }; });
})();
const END = TIMELINE[TIMELINE.length - 1].from + TIMELINE[TIMELINE.length - 1].dur;
if (END !== DURATION) console.warn(`Timeline is ${END} frames, composition is ${DURATION}`);
const MUSIC_AT = TIMELINE[6].from; // the music enters with "Typing got faster."

const LEN: Record<string, number> = { key: 4, tab: 5, clack: 6, ding: 54, carriage: 22, chime: 48, notify: 36, whoosh: 27, hit: 96 };
const Sfx: React.FC<{ cue: Cue; at: number; i: number }> = ({ cue, at }) => (
  <Sequence from={at + cue.f} durationInFrames={LEN[cue.s] ?? 30} layout="none">
    <Audio src={staticFile(`sfx/${cue.s}.wav`)} volume={cue.v ?? 1} />
  </Sequence>
);

export const Trailer: React.FC = () => (
  <AbsoluteFill style={{ background: C.white }}>
    {TIMELINE.map(({ C: Scene, from, dur }, i) => (
      <Sequence key={i} from={from} durationInFrames={dur}>
        <Scene />
      </Sequence>
    ))}
    {/* sound */}
    {TIMELINE.flatMap((s, i) => [
      ...(s.cues ?? []).map((c, k) => <Sfx key={`${i}-${k}`} cue={c} at={s.from} i={k} />),
      ...(s.whoosh ? [<Sfx key={`${i}-w`} cue={{ f: -12, s: 'whoosh', v: 0.32 }} at={s.from} i={0} />] : []),
      ...(s.pen ? [<Sequence key={`${i}-pen`} from={s.from + 8} durationInFrames={s.dur - 8} layout="none"><Audio src={staticFile('sfx/pen.wav')} volume={0.7} /></Sequence>] : []),
    ])}
    <Sequence from={MUSIC_AT} durationInFrames={DURATION - MUSIC_AT} layout="none">
      <Audio src={staticFile('sfx/pad.wav')} volume={(f) => interpolate(f, [0, 60, DURATION - MUSIC_AT - 70, DURATION - MUSIC_AT], [0, 0.55, 0.55, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })} />
    </Sequence>
  </AbsoluteFill>
);
