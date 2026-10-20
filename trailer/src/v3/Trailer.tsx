import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { C, BAR } from './kit';
import type { Cue } from '../v2/cues';
import { Intro, INTRO, Eras, ERAS_LEN, eraCues } from './scenes/History';
import { Pause, PAUSE, Work, WORK, workCues, Leap, LEAP } from './scenes/Modern';
import { Features, FEAT, featCues } from './scenes/Features';
import { End, END, endCues } from './scenes/End';

export const FPS = 60;
export const DURATION = BAR * 30; // 80 s at 90 BPM

const PLAN: { C: React.FC; dur: number; cues?: Cue[] }[] = [
  { C: Intro, dur: INTRO },
  { C: Eras, dur: ERAS_LEN, cues: eraCues },
  { C: Pause, dur: PAUSE },
  { C: Work, dur: WORK, cues: workCues },
  { C: Leap, dur: LEAP },
  { C: Features, dur: FEAT, cues: featCues },
  { C: End, dur: END, cues: endCues },
];
if (PLAN.reduce((a, p) => a + p.dur, 0) !== DURATION) console.warn('timeline length mismatch');
const TIMELINE = (() => { let at = 0; return PLAN.map((p) => { const from = at; at += p.dur; return { ...p, from }; }); })();
const LEN: Record<string, number> = { key: 6, tab: 9, clack: 12, ding: 100, notify: 72, chime: 96 };

export const Trailer: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    {TIMELINE.map(({ C: Scene, from, dur }, i) => (
      <Sequence key={i} from={from} durationInFrames={dur}><Scene /></Sequence>
    ))}
    <Audio src={staticFile('sfx/score.wav')} volume={0.9} />
    {TIMELINE.flatMap((s, i) => (s.cues ?? []).map((c, k) => (
      <Sequence key={`${i}-${k}`} from={s.from + c.f} durationInFrames={LEN[c.s] ?? 60} layout="none">
        <Audio src={staticFile(`sfx/${c.s}.wav`)} volume={c.v ?? 1} />
      </Sequence>
    )))}
  </AbsoluteFill>
);
