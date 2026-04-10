import React from 'react';
import { AbsoluteFill, Img, OffthreadVideo, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CustomTransitionProps, TransitionParamSchema, TransitionMeta } from '../types';

const Crossfade: React.FC<CustomTransitionProps> = ({ fromSrc, toSrc, fromAssetType, toAssetType, fromStartFrom, toStartFrom }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = Math.min(1, Math.max(0, frame / Math.max(1, durationInFrames - 1)));

  return (
    <AbsoluteFill>
      {fromSrc && (
        <AbsoluteFill style={{ opacity: 1 - progress }}>
          {fromAssetType === 'video' ? (
            <OffthreadVideo src={fromSrc} startFrom={fromStartFrom} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <Img src={fromSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
        </AbsoluteFill>
      )}
      {toSrc && (
        <AbsoluteFill style={{ opacity: progress }}>
          {toAssetType === 'video' ? (
            <OffthreadVideo src={toSrc} startFrom={toStartFrom} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <Img src={toSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const params: TransitionParamSchema = {};

// eslint-disable-next-line react-refresh/only-export-components
export const meta: TransitionMeta = {
  name: 'Crossfade',
  description: 'Simple opacity crossfade between two clips',
};

export default Crossfade;
