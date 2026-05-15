import { useMemo, useRef, useEffect, memo } from 'react';
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
  premount?: boolean;
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

function TransitionPreview({
  transition,
  currentTime,
  fps,
  width,
  height,
  isPlaying = false,
}: TransitionPreviewProps) {
  const playerRef = useRef<PlayerRef>(null);
  const playbackStartRef = useRef<{ wallTime: number; frame: number } | null>(null);
  const premount = transition.premount ?? false;
  const isLive = isPlaying && !premount;

  const durationInFrames = Math.max(1, Math.round(transition.durationSec * fps));

  const progressTime = currentTime - transition.startTime;
  const targetFrame = Math.max(0, Math.min(durationInFrames - 1, Math.round(progressTime * fps)));
  const targetFrameRef = useRef(targetFrame);
  useEffect(() => { targetFrameRef.current = targetFrame; }, [targetFrame]);

  // Play/pause: start Player when live, keep paused during premount
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;

    if (isLive) {
      player.seekTo(targetFrameRef.current);
      player.play();
      playbackStartRef.current = {
        wallTime: performance.now(),
        frame: targetFrameRef.current,
      };
    } else {
      player.pause();
      player.seekTo(targetFrameRef.current);
      playbackStartRef.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive]);

  // Scrub seeking when paused — per-frame seekTo only when NOT playing
  useEffect(() => {
    if (!isPlaying && !premount && playerRef.current) {
      playerRef.current.seekTo(targetFrame);
    }
  }, [targetFrame, isPlaying, premount]);

  // Wall-clock drift corrector — independent of React props (memo-safe)
  useEffect(() => {
    if (!isLive) return;

    const intervalId = setInterval(() => {
      const player = playerRef.current;
      const start = playbackStartRef.current;
      if (!player || !start) return;

      const elapsedSec = (performance.now() - start.wallTime) / 1000;
      const expected = Math.min(
        durationInFrames - 1,
        start.frame + Math.round(elapsedSec * fps),
      );
      const actual = player.getCurrentFrame();
      if (Math.abs(expected - actual) > 1) {
        player.seekTo(expected);
      }
    }, 250);

    return () => clearInterval(intervalId);
  }, [isLive, fps, durationInFrames]);


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
        visibility: premount ? 'hidden' : undefined,
      }}
    />
  );
}

export default memo(TransitionPreview, (prev, next) => {
  if (prev.isPlaying !== next.isPlaying) return false;
  if (prev.transition.premount !== next.transition.premount) return false;
  if (prev.fps !== next.fps || prev.width !== next.width || prev.height !== next.height) return false;

  const prevLive = prev.isPlaying && !prev.transition.premount;
  const nextLive = next.isPlaying && !next.transition.premount;
  if ((!prevLive || !nextLive) && prev.currentTime !== next.currentTime) {
    return false;
  }

  return (
    prev.transition.id === next.transition.id &&
    prev.transition.transitionFileId === next.transition.transitionFileId &&
    prev.transition.startTime === next.transition.startTime &&
    prev.transition.durationSec === next.transition.durationSec &&
    prev.transition.fromSrc === next.transition.fromSrc &&
    prev.transition.toSrc === next.transition.toSrc &&
    prev.transition.fromAssetType === next.transition.fromAssetType &&
    prev.transition.toAssetType === next.transition.toAssetType &&
    prev.transition.fromStartFrom === next.transition.fromStartFrom &&
    prev.transition.toStartFrom === next.transition.toStartFrom &&
    prev.transition.params === next.transition.params
  );
});
