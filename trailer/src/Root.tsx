import React from 'react';
import { Composition } from 'remotion';
import * as V1 from './v1/Trailer';
import * as V2 from './v2/Trailer';
import * as V3 from './v3/Trailer';
import * as V4 from './v4/Trailer';

export const Root: React.FC = () => (
  <>
    <Composition id="LassoTrailer" component={V4.Trailer} durationInFrames={V4.DURATION} fps={V4.FPS} width={1920} height={1080} />
    <Composition id="LassoTrailerV3" component={V3.Trailer} durationInFrames={V3.DURATION} fps={V3.FPS} width={1920} height={1080} />
    <Composition id="LassoTrailerV2" component={V2.Trailer} durationInFrames={V2.DURATION} fps={V2.FPS} width={1920} height={1080} />
    <Composition id="LassoTrailerV1" component={V1.Trailer} durationInFrames={V1.DURATION} fps={V1.FPS} width={1920} height={1080} />
  </>
);
