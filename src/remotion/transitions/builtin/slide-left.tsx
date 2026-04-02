import React from 'react';
import { AbsoluteFill, Img, OffthreadVideo, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CustomTransitionProps, TransitionParamSchema, TransitionMeta } from '../types';

const SlideLeft: React.FC<CustomTransitionProps> = ({ fromSrc, toSrc, fromAssetType, toAssetType, fromStartFrom, toStartFrom }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width } = useVideoConfig();
  const progress = interpolate(frame, [0, durationInFrames - 1], [0, 1], { extrapolateRight: 'clamp' });

  const fromX = -progress * width;
  const toX = (1 - progress) * width;

  return (
    <AbsoluteFill>
      {fromSrc && (
        <AbsoluteFill style={{ transform: `translateX(${fromX}px)` }}>
          {fromAssetType === 'video' ? (
            <OffthreadVideo src={fromSrc} startFrom={fromStartFrom} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <Img src={fromSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
        </AbsoluteFill>
      )}
      {toSrc && (
        <AbsoluteFill style={{ transform: `translateX(${toX}px)` }}>
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

export const params: TransitionParamSchema = {};

export const meta: TransitionMeta = {
  name: 'Slide Left',
  description: 'From clip slides out to the left, to clip slides in from the right',
};

export default SlideLeft;
