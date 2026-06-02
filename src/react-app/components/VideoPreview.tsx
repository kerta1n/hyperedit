import { Play, Layers, Move } from 'lucide-react';
import React, { useRef, useEffect, forwardRef, useImperativeHandle, useState, useCallback, useMemo } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { ProjectTimeline } from '@/remotion/ProjectTimeline';
import type { RemotionProjectSpec, RemotionClipTransform } from '@/shared/remotion-core';

export interface OverlayClipInfo {
  id: string;
  trackId: string;
  transform?: RemotionClipTransform;
  assetType: 'video' | 'image';
}

interface VideoPreviewProps {
  spec: RemotionProjectSpec | null;
  fps: number;
  compositionWidth: number;
  compositionHeight: number;
  durationInFrames: number;
  aspectRatio: '16:9' | '9:16';
  previewAsset?: { url: string; type: 'video' | 'image' | 'audio' } | null;
  overlayClips?: OverlayClipInfo[];
  onLayerMove?: (layerId: string, x: number, y: number) => void;
  onLayerSelect?: (layerId: string) => void;
  selectedLayerId?: string | null;
  onFrameUpdate?: (frame: number) => void;
  onPlaybackChange?: (isPlaying: boolean) => void;
}

export interface VideoPreviewHandle {
  seekTo: (time: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  isPlaying: () => boolean;
}

const VideoPreview = forwardRef<VideoPreviewHandle, VideoPreviewProps>(({
  spec,
  fps,
  compositionWidth,
  compositionHeight,
  durationInFrames,
  aspectRatio,
  previewAsset,
  overlayClips = [],
  onLayerMove,
  onLayerSelect,
  selectedLayerId,
  onFrameUpdate,
  onPlaybackChange,
}, ref) => {
  const playerRef = useRef<PlayerRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [draggingLayer, setDraggingLayer] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; layerX: number; layerY: number } | null>(null);
  const onFrameUpdateRef = useRef(onFrameUpdate);
  onFrameUpdateRef.current = onFrameUpdate;
  const onPlaybackChangeRef = useRef(onPlaybackChange);
  onPlaybackChangeRef.current = onPlaybackChange;

  useImperativeHandle(ref, () => ({
    seekTo: (time: number) => {
      const player = playerRef.current;
      if (!player) return;
      player.pause();
      player.seekTo(Math.round(time * fps));
    },
    play: () => { playerRef.current?.play(); },
    pause: () => { playerRef.current?.pause(); },
    toggle: () => {
      const player = playerRef.current;
      if (!player) return;
      if (player.isPlaying()) {
        player.pause();
      } else {
        player.play();
      }
    },
    isPlaying: () => playerRef.current?.isPlaying() ?? false,
  }));

  // Subscribe to Player events
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;

    const onFrame = (e: { detail: { frame: number } }) => {
      onFrameUpdateRef.current?.(e.detail.frame);
    };
    const onPlay = () => { onPlaybackChangeRef.current?.(true); };
    const onPause = () => { onPlaybackChangeRef.current?.(false); };
    const onEnded = () => { onPlaybackChangeRef.current?.(false); };

    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onEnded);

    return () => {
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onEnded);
    };
  }, [spec]);

  // Drag: convert screen deltas to composition-space deltas
  const getScreenScale = useCallback(() => {
    const el = containerRef.current;
    if (!el) return 1;
    return el.clientWidth / compositionWidth;
  }, [compositionWidth]);

  const handleLayerMouseDown = useCallback((e: React.MouseEvent, clip: OverlayClipInfo) => {
    if (clip.trackId === 'V1') return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setDraggingLayer(clip.id);
    setDragStart({
      x: e.clientX,
      y: e.clientY,
      layerX: clip.transform?.x || 0,
      layerY: clip.transform?.y || 0,
    });
    onLayerSelect?.(clip.id);
  }, [onLayerSelect]);

  useEffect(() => {
    if (!draggingLayer || !dragStart) return;

    const scale = getScreenScale();

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = (e.clientX - dragStart.x) / scale;
      const deltaY = (e.clientY - dragStart.y) / scale;
      onLayerMove?.(draggingLayer, dragStart.layerX + deltaX, dragStart.layerY + deltaY);
    };

    const handleMouseUp = () => {
      setDraggingLayer(null);
      setDragStart(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingLayer, dragStart, onLayerMove, getScreenScale]);

  const inputProps = useMemo(() => ({ spec: spec! }), [spec]);

  const isVertical = aspectRatio === '9:16';
  const containerClass = isVertical
    ? 'h-[65vh] w-auto aspect-[9/16]'
    : 'w-full max-w-4xl aspect-video';

  // Single-asset preview mode
  if (previewAsset) {
    return (
      <div className={`relative ${containerClass} bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10`}>
        {previewAsset.type === 'video' ? (
          <video
            src={previewAsset.url}
            className="absolute inset-0 w-full h-full object-contain"
            playsInline
            preload="auto"
            controls
          />
        ) : previewAsset.type === 'image' ? (
          <img
            src={previewAsset.url}
            alt="Preview"
            className="absolute inset-0 w-full h-full object-contain"
          />
        ) : null}
      </div>
    );
  }

  // No spec — empty state
  if (!spec || durationInFrames < 1) {
    return (
      <div className={`relative ${containerClass} bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10 flex items-center justify-center`}>
        <div className="text-center text-zinc-600">
          <Play className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No media to display</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative ${containerClass} bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10`}
    >
      <Player
        ref={playerRef}
        component={ProjectTimeline}
        inputProps={inputProps}
        durationInFrames={durationInFrames}
        fps={fps}
        compositionWidth={compositionWidth}
        compositionHeight={compositionHeight}
        style={{
          width: '100%',
          height: '100%',
        }}
      />

      {/* Transparent drag overlay for V2/V3 interaction */}
      {overlayClips.length > 0 && (
        <div
          className="absolute inset-0"
          style={{ zIndex: 10, pointerEvents: 'none' }}
        >
          {overlayClips.map((clip) => {
            const scale = clip.transform?.scale ?? 1;
            const x = clip.transform?.x ?? 0;
            const y = clip.transform?.y ?? 0;
            const isSelected = selectedLayerId === clip.id;
            const isDragging = draggingLayer === clip.id;

            if (clip.assetType === 'image') {
              // Image overlay hit-box: positioned like ProjectTimeline's AbsoluteFill + transform
              const screenScale = getScreenScale();
              const hitW = compositionWidth * scale * screenScale;
              const hitH = compositionHeight * scale * screenScale;
              const hitLeft = (containerRef.current?.clientWidth ?? 0) / 2 + x * screenScale - hitW / 2;
              const hitTop = (containerRef.current?.clientHeight ?? 0) / 2 + y * screenScale - hitH / 2;

              return (
                <div
                  key={clip.id}
                  className="absolute cursor-grab active:cursor-grabbing"
                  style={{
                    pointerEvents: 'auto',
                    left: hitLeft,
                    top: hitTop,
                    width: hitW,
                    height: hitH,
                  }}
                  onMouseDown={(e) => handleLayerMouseDown(e, clip)}
                >
                  {isSelected && (
                    <div className="absolute inset-0 ring-2 ring-orange-500 rounded-lg pointer-events-none" />
                  )}
                  {!isDragging && (
                    <div className="absolute top-2 right-2 p-1.5 bg-black/60 rounded text-white/70 pointer-events-none">
                      <Move className="w-3 h-3" />
                    </div>
                  )}
                </div>
              );
            }

            // Video overlay hit-box
            const screenScale = getScreenScale();
            const hitW = compositionWidth * scale * screenScale;
            const hitH = compositionHeight * scale * screenScale;
            const hitLeft = (containerRef.current?.clientWidth ?? 0) / 2 + x * screenScale - hitW / 2;
            const hitTop = (containerRef.current?.clientHeight ?? 0) / 2 + y * screenScale - hitH / 2;

            return (
              <div
                key={clip.id}
                className="absolute cursor-grab active:cursor-grabbing"
                style={{
                  pointerEvents: 'auto',
                  left: hitLeft,
                  top: hitTop,
                  width: hitW,
                  height: hitH,
                }}
                onMouseDown={(e) => handleLayerMouseDown(e, clip)}
              >
                {isSelected && (
                  <div className="absolute inset-0 ring-2 ring-orange-500 pointer-events-none" />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Layer count */}
      {spec.clips.length > 1 && (
        <div className="absolute top-3 left-3 text-xs text-white/60 bg-black/50 px-2 py-1 rounded flex items-center gap-1 z-50">
          <Layers className="w-3 h-3" />
          <span>{spec.clips.length} layers</span>
        </div>
      )}

      {/* Dragging indicator */}
      {draggingLayer && (
        <div className="absolute bottom-3 left-3 text-xs text-orange-400 bg-black/70 px-2 py-1 rounded z-50">
          Dragging...
        </div>
      )}
    </div>
  );
});

export default React.memo(VideoPreview);
