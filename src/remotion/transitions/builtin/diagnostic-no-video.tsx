import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CustomTransitionProps, TransitionParamSchema, TransitionMeta } from '../types';

const LOGO_SIZE = 160;
const SPEED = 20;

function bouncingPosition(frame: number, areaW: number, areaH: number) {
  const maxX = areaW - LOGO_SIZE;
  const maxY = areaH - LOGO_SIZE;
  const rawX = (frame * SPEED) % (maxX * 2);
  const rawY = (frame * SPEED * 0.7) % (maxY * 2);
  const x = rawX <= maxX ? rawX : maxX * 2 - rawX;
  const y = rawY <= maxY ? rawY : maxY * 2 - rawY;
  return { x, y };
}

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];

const DiagnosticNoVideo: React.FC<CustomTransitionProps> = () => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps, width, height } = useVideoConfig();
  const progress = Math.min(1, Math.max(0, frame / Math.max(1, durationInFrames - 1)));

  const { x, y } = bouncingPosition(frame, width, height);
  const colorIdx = Math.floor(frame / 30) % COLORS.length;

  return (
    <AbsoluteFill style={{ backgroundColor: '#111' }}>
      {/* Bouncing DVD logo */}
      <div style={{
        position: 'absolute',
        left: x,
        top: y,
        width: LOGO_SIZE,
        height: LOGO_SIZE,
        backgroundColor: COLORS[colorIdx],
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        fontSize: 24,
        fontWeight: 'bold',
        fontFamily: 'monospace',
      }}>
        DIAG
      </div>

      {/* Frame counter + FPS readout */}
      <div style={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        color: 'white',
        fontSize: 20,
        fontFamily: 'monospace',
        backgroundColor: 'rgba(0,0,0,0.7)',
        padding: '8px 12px',
        borderRadius: 6,
      }}>
        f{frame}/{durationInFrames} | {fps}fps | {Math.round(progress * 100)}%
      </div>

      {/* Zebra bars — main thread canary. Jumps/teleports = React too heavy */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        width: '100%',
        height: 120,
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex',
          transform: `translateX(${-((frame * 10) % 120)}px)`,
          height: '100%',
        }}>
          {Array.from({ length: 80 }, (_, i) => (
            <div key={i} style={{
              width: 60,
              height: '100%',
              backgroundColor: i % 2 === 0 ? '#fff' : '#000',
              flexShrink: 0,
            }} />
          ))}
        </div>
      </div>

      {/* Spinning element - rotation hitches very visible */}
      <div style={{
        position: 'absolute',
        top: 20,
        right: 20,
        width: 140,
        height: 140,
        border: '6px solid #e74c3c',
        borderTop: '6px solid transparent',
        borderRadius: '50%',
        transform: `rotate(${frame * 12}deg)`,
      }} />
    </AbsoluteFill>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const params: TransitionParamSchema = {};

// eslint-disable-next-line react-refresh/only-export-components
export const meta: TransitionMeta = {
  name: '[DIAG] No Video',
  description: 'Diagnostic: DVD bounce + pendulum + spinner. Zero video elements. Any frame drop immediately visible.',
};

export default DiagnosticNoVideo;
