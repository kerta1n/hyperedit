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
  isPlaying: boolean;
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
 * Mounts once per transition window. During playback, uses play() and drift correction
 * via frameupdate event instead of seekTo() per frame (which caused pause/seek loop).
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
  const wasPlayingRef = useRef(false);
  const lastSeekedFrameRef = useRef(-1);

  const durationInFrames = Math.max(1, Math.round(transition.durationSec * fps));

  // Calculate which frame within the transition we're at
  const progressTime = currentTime - transition.startTime;
  const targetFrame = Math.max(0, Math.min(durationInFrames - 1, Math.round(progressTime * fps)));

  // Play/pause control — seekTo once on play start, then let Player's internal loop run
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;

    if (isPlaying && !wasPlayingRef.current) {
      player.seekTo(targetFrame);
      lastSeekedFrameRef.current = targetFrame;
      requestAnimationFrame(() => {
        playerRef.current?.play();
      });
    } else if (!isPlaying && wasPlayingRef.current) {
      player.pause();
    }

    wasPlayingRef.current = isPlaying;
  }, [isPlaying, targetFrame]);

  // Scrub seeking — only fires when paused (infrequent, safe to seekTo)
  useEffect(() => {
    if (isPlaying) return;
    if (playerRef.current && lastSeekedFrameRef.current !== targetFrame) {
      playerRef.current.seekTo(targetFrame);
      lastSeekedFrameRef.current = targetFrame;
    }
  }, [targetFrame, isPlaying]);

  // Drift correction during playback via frameupdate event (rate-limited to Player's own RAF)
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !isPlaying) return;

    const DRIFT_THRESHOLD = 3; // frames

    const onFrame = (e: { detail: { frame: number } }) => {
      const drift = Math.abs(e.detail.frame - targetFrame);
      if (drift > DRIFT_THRESHOLD) {
        player.seekTo(targetFrame);
        lastSeekedFrameRef.current = targetFrame;
        requestAnimationFrame(() => {
          playerRef.current?.play();
        });
      }
    };

    player.addEventListener('frameupdate', onFrame);
    return () => player.removeEventListener('frameupdate', onFrame);
  }, [isPlaying, targetFrame]);

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
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 50,
        pointerEvents: 'none',
      }}
    />
  );
}
