import React from 'react';
import { AbsoluteFill, Img, OffthreadVideo, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CustomTransitionProps, TransitionParamSchema, TransitionMeta } from '../types';

const Crossfade: React.FC<CustomTransitionProps> = ({ fromSrc, toSrc, fromAssetType, toAssetType }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = Math.min(1, Math.max(0, frame / Math.max(1, durationInFrames - 1)));

  return (
    <AbsoluteFill>
      {fromSrc && (
        <AbsoluteFill style={{ opacity: 1 - progress }}>
          {fromAssetType === 'video' ? (
            <OffthreadVideo src={fromSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <Img src={fromSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
        </AbsoluteFill>
      )}
      {toSrc && (
        <AbsoluteFill style={{ opacity: progress }}>
          {toAssetType === 'video' ? (
            <OffthreadVideo src={toSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <Img src={toSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

export const params: TransitionParamSchema = {};

export const meta: TransitionMeta = {
  name: 'Crossfade',
  description: 'Simple opacity crossfade between two clips',
};

export default Crossfade;
