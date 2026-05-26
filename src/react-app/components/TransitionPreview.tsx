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
  fps: number;
  width: number;
  height: number;
  isPlaying?: boolean;
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

/**
 * Renders a single active transition using @remotion/player.
 * Mounts once per transition window, drives frame position via seekTo — never re-mounts per tick.
 */
export default function TransitionPreview({
  transition,
  currentTime,
  fps,
  width,
  height,
  isPlaying,
}: TransitionPreviewProps) {
  const playerRef = useRef<PlayerRef>(null);
  const livePlayingRef = useRef(false);
  const prevTargetFrameRef = useRef(0);

  const durationInFrames = Math.max(1, Math.round(transition.durationSec * fps));

  // Calculate which frame within the transition we're at
  const progressTime = currentTime - transition.startTime;
  const targetFrame = Math.max(0, Math.min(durationInFrames - 1, Math.round(progressTime * fps)));

  useEffect(() => { livePlayingRef.current = false; }, [transition.id]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const frameDelta = Math.abs(targetFrame - prevTargetFrameRef.current);
    prevTargetFrameRef.current = targetFrame;

    if (isPlaying) {
      if (!livePlayingRef.current) {
        player.seekTo(targetFrame);
        player.play();
        player.unmute();
        livePlayingRef.current = true;
      } else if (frameDelta > fps) {
        player.seekTo(targetFrame);
        player.play();
      }
    } else {
      player.pause();
      player.seekTo(targetFrame);
      livePlayingRef.current = false;
    }
  }, [isPlaying, targetFrame, fps]);

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
      }}
    />
  );
}
