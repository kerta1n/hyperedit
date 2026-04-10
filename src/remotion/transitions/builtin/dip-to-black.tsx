import React from 'react';
import { AbsoluteFill, Img, OffthreadVideo, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CustomTransitionProps, TransitionParamSchema, TransitionMeta } from '../types';

const DipToBlack: React.FC<CustomTransitionProps> = ({ fromSrc, toSrc, fromAssetType, toAssetType, fromStartFrom, toStartFrom }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const progress = interpolate(frame, [0, durationInFrames - 1], [0, 1], { extrapolateRight: 'clamp' });

  // First half: show from clip fading out to black
  // Second half: show to clip fading in from black
  const isFirstHalf = progress < 0.5;
  const blackOpacity = isFirstHalf
    ? interpolate(progress, [0, 0.5], [0, 1], { extrapolateRight: 'clamp' })
    : interpolate(progress, [0.5, 1], [1, 0], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill>
      {/* Show the active clip underneath */}
      {isFirstHalf && fromSrc && (
        <AbsoluteFill>
          {fromAssetType === 'video' ? (
            <OffthreadVideo src={fromSrc} startFrom={fromStartFrom} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <Img src={fromSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
        </AbsoluteFill>
      )}
      {!isFirstHalf && toSrc && (
        <AbsoluteFill>
          {toAssetType === 'video' ? (
            <OffthreadVideo src={toSrc} startFrom={toStartFrom} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <Img src={toSrc} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          )}
        </AbsoluteFill>
      )}
      {/* Black overlay */}
      <AbsoluteFill style={{ backgroundColor: '#000000', opacity: blackOpacity }} />
    </AbsoluteFill>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const params: TransitionParamSchema = {};

// eslint-disable-next-line react-refresh/only-export-components
export const meta: TransitionMeta = {
  name: 'Dip to Black',
  description: 'From clip fades to black, then to clip fades in from black',
};

export default DipToBlack;
