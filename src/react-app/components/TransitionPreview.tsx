import { useMemo, useRef, useEffect } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { AbsoluteFill } from 'remotion';
import { getTransitionEntry } from '@/remotion/transitions/registry';

export interface ActiveTransition {
  id: string;
  transitionFileId: string;
  startTime: number;
  durationSec: number;
  fromSrc?: string;
  toSrc?: string;
  fromAssetType?: 'video' | 'image';
  toAssetType?: 'video' | 'image';
  fromStartFrom?: number;
  toStartFrom?: number;
  params: Record<string, number | string | boolean>;
}

interface TransitionPreviewProps {
  transition: ActiveTransition;
  currentTime: number;
  isPlaying: boolean;
  fps: number;
  width: number;
  height: number;
}

// Inner composition that renders the actual transition component
function TransitionComposition({
  transitionFileId,
  fromSrc,
  toSrc,
  fromAssetType,
  toAssetType,
  fromStartFrom,
  toStartFrom,
  params,
}: {
  transitionFileId: string;
  fromSrc?: string;
  toSrc?: string;
  fromAssetType?: 'video' | 'image';
  toAssetType?: 'video' | 'image';
  fromStartFrom?: number;
  toStartFrom?: number;
  params: Record<string, number | string | boolean>;
}) {
  const entry = getTransitionEntry(transitionFileId);
  if (!entry) return null;

  const Component = entry.component;
  return (
    <AbsoluteFill>
      <Component
        fromSrc={fromSrc}
        toSrc={toSrc}
        fromAssetType={fromAssetType}
        toAssetType={toAssetType}
        fromStartFrom={fromStartFrom}
        toStartFrom={toStartFrom}
        params={params}
      />
    </AbsoluteFill>
  );
}

export default function TransitionPreview({
  transition,
  currentTime,
  isPlaying,
  fps,
  width,
  height,
}: TransitionPreviewProps) {
  const playerRef = useRef<PlayerRef>(null);
  const livePlayingRef = useRef(false);
  const prevTargetFrameRef = useRef(0);
  const unmuteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const durationInFrames = Math.max(1, Math.round(transition.durationSec * fps));

  const progressTime = currentTime - transition.startTime;
  const targetFrame = Math.max(0, Math.min(durationInFrames - 1, Math.round(progressTime * fps)));

  // Reset play state when transition changes
  useEffect(() => {
    livePlayingRef.current = false;
    prevTargetFrameRef.current = 0;
  }, [transition.id]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const frameDelta = Math.abs(targetFrame - prevTargetFrameRef.current);
    prevTargetFrameRef.current = targetFrame;

    if (isPlaying) {
      if (!livePlayingRef.current) {
        player.seekTo(targetFrame);
        player.play();
        // Delay unmute so the rAF playback loop starts with muted=true,
        // skipping the AudioContext resume block in use-playback.js
        unmuteTimerRef.current = setTimeout(() => {
          playerRef.current?.unmute();
        }, 100);
        livePlayingRef.current = true;
      } else if (frameDelta > fps) {
        player.seekTo(targetFrame);
        player.play();
      }
    } else {
      if (unmuteTimerRef.current) {
        clearTimeout(unmuteTimerRef.current);
        unmuteTimerRef.current = null;
      }
      player.pause();
      player.seekTo(targetFrame);
      livePlayingRef.current = false;
    }
  }, [isPlaying, targetFrame, fps]);

  useEffect(() => {
    return () => {
      if (unmuteTimerRef.current) {
        clearTimeout(unmuteTimerRef.current);
      }
    };
  }, []);

  const inputProps = useMemo(() => ({
    transitionFileId: transition.transitionFileId,
    fromSrc: transition.fromSrc,
    toSrc: transition.toSrc,
    fromAssetType: transition.fromAssetType,
    toAssetType: transition.toAssetType,
    fromStartFrom: transition.fromStartFrom,
    toStartFrom: transition.toStartFrom,
    params: transition.params,
  }), [
    transition.transitionFileId,
    transition.fromSrc,
    transition.toSrc,
    transition.fromAssetType,
    transition.toAssetType,
    transition.fromStartFrom,
    transition.toStartFrom,
    transition.params,
  ]);

  return (
    <Player
      ref={playerRef}
      component={TransitionComposition}
      inputProps={inputProps}
      durationInFrames={durationInFrames}
      fps={fps}
      compositionWidth={width}
      compositionHeight={height}
      initiallyMuted
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 50,
        pointerEvents: 'none',
        backgroundColor: '#000',
        opacity: 1,
      }}
    />
  );
}
