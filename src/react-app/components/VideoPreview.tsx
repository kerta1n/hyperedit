import { Play, Image as ImageIcon, Layers, Move } from 'lucide-react';
import { useRef, useEffect, forwardRef, useImperativeHandle, useMemo, useState, useCallback } from 'react';
import CaptionRenderer from './CaptionRenderer';
import { type ActiveTransition } from './TransitionPreview';
import { getCanvasDraw } from '@/remotion/transitions/canvas-draw';
import type { CaptionWord, CaptionStyle } from '@/react-app/hooks/useProject';

interface ClipTransform {
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  cropTop?: number;
  cropBottom?: number;
  cropLeft?: number;
  cropRight?: number;
}

interface ClipLayer {
  id: string;
  url: string;
  type: 'video' | 'image' | 'audio' | 'caption';
  trackId: string;
  clipTime: number;
  clipStart: number;
  inPoint: number;
  isPremounted?: boolean;
  transform?: ClipTransform;
  captionWords?: CaptionWord[];
  captionStyle?: CaptionStyle;
}

interface VideoPreviewProps {
  layers?: ClipLayer[];
  isPlaying?: boolean;
  aspectRatio?: '16:9' | '9:16';
  onLayerMove?: (layerId: string, x: number, y: number) => void;
  onLayerSelect?: (layerId: string) => void;
  selectedLayerId?: string | null;
  activeTransitions?: ActiveTransition[];
  currentTime?: number;
  currentTimeRef?: React.MutableRefObject<number>;
  onV1Seeked?: (projectTime: number) => void;
}

export interface VideoPreviewHandle {
  seekTo: (time: number) => void;
  getVideoElement: () => HTMLVideoElement | null;
}

// Helper to build CSS styles from transform
function getTransformStyles(transform?: ClipTransform, zIndex: number = 0, isDragging?: boolean): React.CSSProperties {
  const t = transform || {};

  const transforms: string[] = [];

  // Position (translate)
  if (t.x || t.y) {
    transforms.push(`translate(${t.x || 0}px, ${t.y || 0}px)`);
  }

  // Scale
  if (t.scale && t.scale !== 1) {
    transforms.push(`scale(${t.scale})`);
  }

  // Rotation
  if (t.rotation) {
    transforms.push(`rotate(${t.rotation}deg)`);
  }

  // Crop using clip-path
  const cropTop = t.cropTop || 0;
  const cropBottom = t.cropBottom || 0;
  const cropLeft = t.cropLeft || 0;
  const cropRight = t.cropRight || 0;
  const hasClip = cropTop || cropBottom || cropLeft || cropRight;

  return {
    zIndex,
    transform: transforms.length > 0 ? transforms.join(' ') : undefined,
    opacity: t.opacity ?? 1,
    clipPath: hasClip
      ? `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)`
      : undefined,
    cursor: isDragging ? 'grabbing' : undefined,
  };
}

const VideoPreview = forwardRef<VideoPreviewHandle, VideoPreviewProps>(({
  layers = [],
  isPlaying = false,
  aspectRatio = '16:9',
  onLayerMove,
  onLayerSelect,
  selectedLayerId,
  activeTransitions = [],
  currentTime = 0,
  currentTimeRef,
  onV1Seeked,
}, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadedSrcRef = useRef<string | null>(null);
  const overlayVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hiddenImageRefs = useRef<Map<string, HTMLImageElement>>(new Map());
  const hiddenVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const activeTransitionsRef = useRef<ActiveTransition[]>([]);
  activeTransitionsRef.current = activeTransitions;
  const wasPlayingRef = useRef(false);
  const measSessionRef = useRef(0);
  const [draggingLayer, setDraggingLayer] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; layerX: number; layerY: number } | null>(null);

  // Find the base video layer (V1) for audio/playback control
  const foundBaseLayer = layers.find(l => l.trackId === 'V1' && l.type === 'video');
  const baseLayerId = foundBaseLayer?.id;
  const baseLayerUrl = foundBaseLayer?.url;
  const baseLayerClipTime = foundBaseLayer?.clipTime;

  // Memoize to prevent effect triggers when only caption layers change
  const baseVideoLayer = useMemo(() => {
    return foundBaseLayer;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseLayerId, baseLayerUrl]);

  // Get all layers sorted by track for rendering (V1 at bottom, then V2/V3, then T1 captions on top)
  const sortedLayers = useMemo(() => {
    const getTrackOrder = (trackId: string) => {
      if (trackId === 'V1') return 0;
      if (trackId === 'V2') return 1;
      if (trackId === 'V3') return 2;
      if (trackId.startsWith('T')) return 10; // Text/caption tracks on top
      return 5; // Other tracks in between
    };
    return [...layers].sort((a, b) => getTrackOrder(a.trackId) - getTrackOrder(b.trackId));
  }, [layers]);

  useImperativeHandle(ref, () => ({
    seekTo: (time: number) => {
      if (videoRef.current) videoRef.current.currentTime = time;
    },
    getVideoElement: () => videoRef.current,
  }));

  // Reload video when source URL changes (e.g., after dead air removal)
  // Using stable key + manual load() preserves the audio permission from user gesture
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !baseLayerUrl) return;
    if (loadedSrcRef.current !== baseLayerUrl) {
      video.src = baseLayerUrl;
      video.load();
      loadedSrcRef.current = baseLayerUrl;
    }
  }, [baseLayerUrl]);

  // Seek control for base video — fires on boundary crossings, user seeks, and pause
  useEffect(() => {
    const video = videoRef.current;
    if (!video || baseLayerClipTime === undefined) return;

    if (Math.abs(video.currentTime - baseLayerClipTime) > 0.1) {
      const requested = baseLayerClipTime;
      video.currentTime = requested;
      const immediate = video.currentTime;
      console.log(`[V2MEAS][seekReq] id=V1 trackId=V1 requested=${requested.toFixed(4)} immediate=${immediate.toFixed(4)} eps_immediate=${(immediate - requested).toFixed(4)}`);
      const t0 = performance.now();
      const onMeasSeeked = () => {
        const elapsed = performance.now() - t0;
        const settled = video.currentTime;
        console.log(`[V2MEAS][seekSettled] id=V1 trackId=V1 requested=${requested.toFixed(4)} settled=${settled.toFixed(4)} eps=${(settled - requested).toFixed(4)} elapsedMs=${elapsed.toFixed(0)}`);
      };
      video.addEventListener('seeked', onMeasSeeked, { once: true });
    }
  }, [baseLayerClipTime, isPlaying]);

  // Play/pause control for base video
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      const tr = video.buffered;
      const ranges: [string, string][] = [];
      for (let i = 0; i < tr.length; i++) ranges.push([tr.start(i).toFixed(2), tr.end(i).toFixed(2)]);
      console.log(`[V2MEAS][playPrep] id=V1 trackId=V1 readyState=${video.readyState} buffered=${JSON.stringify(ranges)} ct=${video.currentTime.toFixed(3)}`);
      measSessionRef.current += 1;
      const session = measSessionRef.current;
      const playT0 = performance.now();
      video.play().catch((err) => {
        console.error('[VideoPreview] Play failed:', err.name, err.message);
      });
      if (typeof (video as HTMLVideoElement).requestVideoFrameCallback === 'function') {
        (video as HTMLVideoElement).requestVideoFrameCallback((now, meta) => {
          if (session !== measSessionRef.current) return;
          const m = meta as VideoFrameCallbackMetadata;
          const played = video.played;
          const playedRanges: [string, string][] = [];
          for (let i = 0; i < played.length; i++) playedRanges.push([played.start(i).toFixed(3), played.end(i).toFixed(3)]);
          console.log(`[V2MEAS][firstFrame] id=V1 trackId=V1 playToFrameMs=${(now - playT0).toFixed(0)} mediaTime=${meta.mediaTime.toFixed(4)} expectedCT=${video.currentTime.toFixed(4)} expectedDisplayTime=${m.expectedDisplayTime?.toFixed(2) ?? 'na'} presentationTime=${m.presentationTime?.toFixed(2) ?? 'na'} processingDuration=${m.processingDuration?.toFixed(4) ?? 'na'} presentedFrames=${m.presentedFrames ?? 'na'} captureTime=${m.captureTime?.toFixed(2) ?? 'na'} played=${JSON.stringify(playedRanges)}`);
        });
      }
    } else {
      video.pause();
    }
  }, [isPlaying]);

  // After V1 finishes seeking, correct currentTimeRef and React state to V1's actual
  // post-keyframe-snap position. V1 snaps backward to the nearest keyframe (ε can be
  // several seconds). Without this, every layer.clipTime is computed from the requested
  // seek time, not V1's real position — creating a persistent ε offset in all overlays.
  useEffect(() => {
    const v1Video = videoRef.current;
    if (!v1Video || !currentTimeRef) return;
    const onSeeked = () => {
      const v1Layer = layers.find(l => l.trackId === 'V1' && l.type === 'video');
      const projectTime = v1Video.currentTime + (v1Layer?.clipStart ?? 0) - (v1Layer?.inPoint ?? 0);
      currentTimeRef.current = projectTime;
      onV1Seeked?.(projectTime);
    };
    v1Video.addEventListener('seeked', onSeeked);
    return () => v1Video.removeEventListener('seeked', onSeeked);
  }, [layers, currentTimeRef, onV1Seeked]);

  // Play/pause control for overlay videos (V2, V3, etc.)
  // `layers` dep: fires at boundary crossings so newly-loaded videos start playing even if
  // onLoadedData's play() was aborted by a boundary-triggered seek.
  useEffect(() => {
    overlayVideoRefs.current.forEach((video, id) => {
      const layer = layers.find(l => l.id === id);
      if (layer && (layer.trackId === 'V2' || layer.trackId === 'V3')) {
        console.log(`[V2DBG][playEffect] id=${id} isPremounted=${layer.isPremounted} isPlaying=${isPlaying} readyState=${video.readyState} paused=${video.paused} ct=${video.currentTime.toFixed(3)}`);
        const tr = video.buffered;
        const ranges: [string, string][] = [];
        for (let i = 0; i < tr.length; i++) ranges.push([tr.start(i).toFixed(2), tr.end(i).toFixed(2)]);
        console.log(`[V2MEAS][playPrep] id=${id} trackId=${layer.trackId} readyState=${video.readyState} buffered=${JSON.stringify(ranges)} requested=${layer.clipTime.toFixed(3)} isPremounted=${layer.isPremounted}`);
      }
      if (isPlaying && layer && !layer.isPremounted) {
        if (video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          // 3a drift gate at 30ms (one frame at 30fps). Skip the redundant pre-play seek
          // if V2 is already at target; redundant seek flushes Chrome decoder pipeline.
          if (Math.abs(video.currentTime - layer.clipTime) > 0.03) {
            video.currentTime = layer.clipTime;
          }
          const session = measSessionRef.current;
          const playT0 = performance.now();
          video.play().catch(() => {});
          if ((layer.trackId === 'V2' || layer.trackId === 'V3') && typeof (video as HTMLVideoElement).requestVideoFrameCallback === 'function') {
            (video as HTMLVideoElement).requestVideoFrameCallback((now, meta) => {
              if (session !== measSessionRef.current) return;
              const m = meta as VideoFrameCallbackMetadata;
              const played = video.played;
              const playedRanges: [string, string][] = [];
              for (let i = 0; i < played.length; i++) playedRanges.push([played.start(i).toFixed(3), played.end(i).toFixed(3)]);
              console.log(`[V2MEAS][firstFrame] id=${id} trackId=${layer.trackId} playToFrameMs=${(now - playT0).toFixed(0)} mediaTime=${meta.mediaTime.toFixed(4)} expectedClipTime=${layer.clipTime.toFixed(4)} expectedDisplayTime=${m.expectedDisplayTime?.toFixed(2) ?? 'na'} presentationTime=${m.presentationTime?.toFixed(2) ?? 'na'} processingDuration=${m.processingDuration?.toFixed(4) ?? 'na'} presentedFrames=${m.presentedFrames ?? 'na'} captureTime=${m.captureTime?.toFixed(2) ?? 'na'} played=${JSON.stringify(playedRanges)}`);
            });
          }
        }
      } else {
        // Guard against redundant pause() calls. playEffect dep is [isPlaying, layers];
        // layers is unstable (recomputed every Home.tsx render) so this effect fires many
        // times per session. Each redundant pause() propagates to Chrome's media pipeline
        // as an extra kPause event (verified via chrome://media-internals). Skip if already
        // paused to keep V2's pipeline state machine quieter.
        if (!video.paused) {
          video.pause();
        }
      }
    });
  }, [isPlaying, layers]);

  // Sync overlay video and audio seeking — fires on boundary crossings, user seeks, and pause.
  // Uses tight 5ms threshold on play-start to minimize static startup offset between tracks.
  useEffect(() => {
    const justStarted = isPlaying && !wasPlayingRef.current;
    wasPlayingRef.current = isPlaying;
    // 50ms play-start threshold — small enough to enforce sync but larger than the
    // floating-point noise from a same-value currentTime assignment.
    const threshold = justStarted ? 0.05 : 0.1;

    const overlayMediaLayers = layers.filter(
      l => (l.type === 'video' && l.trackId !== 'V1') || l.type === 'audio'
    );
    overlayMediaLayers.forEach((layer) => {
      const mediaEl = overlayVideoRefs.current.get(layer.id);
      if (mediaEl && layer.clipTime !== undefined) {
        if (layer.trackId === 'V2' || layer.trackId === 'V3') {
          console.log(`[V2DBG][seekEffect] id=${layer.id} isPremounted=${layer.isPremounted} video.ct=${mediaEl.currentTime.toFixed(3)} layer.clipTime=${layer.clipTime.toFixed(3)} threshold=${threshold} willSeek=${Math.abs(mediaEl.currentTime - layer.clipTime) > threshold}`);
        }
        if (Math.abs(mediaEl.currentTime - layer.clipTime) > threshold) {
          const requested = layer.clipTime;
          mediaEl.currentTime = requested;
          const immediate = mediaEl.currentTime;
          console.log(`[V2MEAS][seekReq] id=${layer.id} trackId=${layer.trackId} requested=${requested.toFixed(4)} immediate=${immediate.toFixed(4)} eps_immediate=${(immediate - requested).toFixed(4)}`);
          const t0 = performance.now();
          const onMeasSeeked = () => {
            const elapsed = performance.now() - t0;
            const settled = mediaEl.currentTime;
            console.log(`[V2MEAS][seekSettled] id=${layer.id} trackId=${layer.trackId} requested=${requested.toFixed(4)} settled=${settled.toFixed(4)} eps=${(settled - requested).toFixed(4)} elapsedMs=${elapsed.toFixed(0)}`);
          };
          mediaEl.addEventListener('seeked', onMeasSeeked, { once: true });
        }
      }
    });
  }, [layers, isPlaying]);

  // Seek on load
  const handleLoaded = () => {
    if (videoRef.current && baseLayerClipTime !== undefined) {
      videoRef.current.currentTime = baseLayerClipTime;
    }
  };

  // Return the live media element for a given transition clip source.
  // Videos: matched by clip ID against V1 base ref or overlay refs.
  // Images: cached HTMLImageElement keyed by URL (no hidden video elements).
  const getVideoSource = useCallback((
    clipId: string | undefined,
    src: string | undefined,
    assetType: 'video' | 'image' | undefined,
  ): HTMLVideoElement | HTMLImageElement | null => {
    if (!src) return null;

    if (assetType === 'image') {
      let img = hiddenImageRefs.current.get(src);
      if (!img) {
        img = new Image();
        img.src = src;
        img.crossOrigin = 'anonymous';
        hiddenImageRefs.current.set(src, img);
      }
      return img;
    }

    if (!clipId) return null;
    const baseId = layers.find(l => l.trackId === 'V1' && l.type === 'video')?.id;
    if (clipId === baseId && videoRef.current) return videoRef.current;
    const overlayEl = overlayVideoRefs.current.get(clipId);
    if (overlayEl) return overlayEl;
    return hiddenVideoRefs.current.get(clipId) ?? null;
  }, [layers]);

  // Draw the current transition frame onto the canvas.
  // Uses currentTimeRef for accurate playhead position without re-renders.
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !currentTimeRef) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const transitions = activeTransitionsRef.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (transitions.length === 0) return;

    const ct = currentTimeRef.current;
    for (const t of transitions) {
      const progress = Math.max(0, Math.min(1, (ct - t.startTime) / t.durationSec));
      const drawFn = getCanvasDraw(t.transitionFileId);
      if (!drawFn) continue;
      const fromEl = getVideoSource(t.fromClipId, t.fromSrc, t.fromAssetType);
      const toEl   = getVideoSource(t.toClipId,   t.toSrc,   t.toAssetType);
      drawFn(ctx, fromEl, toEl, progress, canvas.width, canvas.height, t.params);
    }
  }, [getVideoSource, currentTimeRef]);

  // Canvas RAF draw loop during playback
  useEffect(() => {
    if (!isPlaying || activeTransitions.length === 0) return;
    let rafId: number;
    const loop = () => { drawFrame(); rafId = requestAnimationFrame(loop); };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, activeTransitions.length, drawFrame]);

  // Canvas single draw on scrub (not playing)
  useEffect(() => {
    if (isPlaying) return;
    drawFrame();
  }, [currentTime, isPlaying, drawFrame]);

  // Create/cleanup hidden video elements for transition from-clips that have ended
  // (not in overlayVideoRefs — needed as canvas draw sources for facecam transitions)
  useEffect(() => {
    for (const t of activeTransitions) {
      if (!t.fromClipId || !t.fromSrc || t.fromAssetType !== 'video') continue;
      if (overlayVideoRefs.current.has(t.fromClipId)) continue;
      const baseId = layers.find(l => l.trackId === 'V1' && l.type === 'video')?.id;
      if (t.fromClipId === baseId) continue;
      if (hiddenVideoRefs.current.has(t.fromClipId)) continue;
      const el = document.createElement('video');
      el.src = t.fromSrc;
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.style.cssText = 'position:fixed;width:0;height:0;top:-1px;left:-1px;opacity:0;pointer-events:none;';
      document.body.appendChild(el);
      hiddenVideoRefs.current.set(t.fromClipId, el);
    }
    const activeFromIds = new Set(
      activeTransitions
        .filter(t => t.fromClipId && t.fromAssetType === 'video')
        .map(t => t.fromClipId!)
    );
    for (const [clipId, el] of hiddenVideoRefs.current) {
      if (!activeFromIds.has(clipId)) {
        el.pause();
        el.src = '';
        el.parentNode?.removeChild(el);
        hiddenVideoRefs.current.delete(clipId);
      }
    }
  }, [activeTransitions, layers]);

  // Seek hidden from-videos to correct frame (capped at last frame of the clip)
  useEffect(() => {
    for (const t of activeTransitions) {
      if (!t.fromClipId) continue;
      const el = hiddenVideoRefs.current.get(t.fromClipId);
      if (!el) continue;
      const elapsed = currentTime - (t.fromClipStart ?? t.startTime);
      const rawPos = (t.fromInPoint ?? 0) + elapsed;
      const maxPos = t.fromClipDuration != null
        ? (t.fromInPoint ?? 0) + t.fromClipDuration - 0.033
        : rawPos;
      const targetPos = Math.max(0, Math.min(rawPos, maxPos));
      if (Math.abs(el.currentTime - targetPos) > 0.05) {
        el.currentTime = targetPos;
      }
    }
  }, [activeTransitions, currentTime]);

  // Handle mouse down on draggable layer
  const handleLayerMouseDown = useCallback((e: React.MouseEvent, layer: ClipLayer) => {
    // Only allow dragging non-V1 layers (overlays)
    if (layer.trackId === 'V1') return;
    if (e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();

    setDraggingLayer(layer.id);
    setDragStart({
      x: e.clientX,
      y: e.clientY,
      layerX: layer.transform?.x || 0,
      layerY: layer.transform?.y || 0,
    });

    // Select this layer
    onLayerSelect?.(layer.id);
  }, [onLayerSelect]);

  // Handle mouse move for dragging
  useEffect(() => {
    if (!draggingLayer || !dragStart) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragStart.x;
      const deltaY = e.clientY - dragStart.y;

      const newX = dragStart.layerX + deltaX;
      const newY = dragStart.layerY + deltaY;

      onLayerMove?.(draggingLayer, newX, newY);
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
  }, [draggingLayer, dragStart, onLayerMove]);

  // Aspect ratio styles
  const isVertical = aspectRatio === '9:16';
  // Use object-contain to show full video without cropping
  const videoFitClass = 'object-contain';

  // Container classes based on aspect ratio
  const containerClass = isVertical
    ? 'h-[65vh] w-auto aspect-[9/16]'  // Vertical: fixed height, width from aspect ratio
    : 'w-full max-w-4xl aspect-video';  // Horizontal: constrain width, height follows

  // Separate base video from overlay layers to prevent re-render issues
  const overlayLayers = useMemo(() =>
    sortedLayers.filter(l => !(l.trackId === 'V1' && l.type === 'video')),
    [sortedLayers]
  );

  if (layers.length === 0) {
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
      {/* Base video layer (V1) - rendered separately for stability */}
      {foundBaseLayer && (
        <video
          key="base-video"
          ref={videoRef}
          src={foundBaseLayer.url}
          className={`absolute inset-0 w-full h-full ${videoFitClass}`}
          style={{ zIndex: 1 }}
          playsInline
          preload="auto"
          onLoadedData={handleLoaded}
        />
      )}

      {/* Render overlay layers (V2+, images, captions) */}
      {overlayLayers.map((layer, index) => {
        const isOverlay = layer.trackId !== 'V1';
        const isDragging = draggingLayer === layer.id;
        const isSelected = selectedLayerId === layer.id;
        const styles = getTransformStyles(layer.transform, index + 2, isDragging);

        if (layer.type === 'video') {
          return (
            <video
              key={`${layer.id}-${layer.url}`}
              ref={(el) => {
                if (el) {
                  overlayVideoRefs.current.set(layer.id, el);
                  if (layer.trackId === 'V2' || layer.trackId === 'V3') {
                    console.log(`[V2MEAS][mount] id=${layer.id} trackId=${layer.trackId} urlTail=${layer.url.slice(-50)} t=${performance.now().toFixed(0)}`);
                  }
                } else {
                  overlayVideoRefs.current.delete(layer.id);
                  if (layer.trackId === 'V2' || layer.trackId === 'V3') {
                    console.log(`[V2MEAS][unmount] id=${layer.id} trackId=${layer.trackId} t=${performance.now().toFixed(0)}`);
                  }
                }
              }}
              src={layer.url}
              className={`absolute inset-0 w-full h-full ${videoFitClass} cursor-grab active:cursor-grabbing ${
                isSelected ? 'ring-2 ring-orange-500 ring-offset-2 ring-offset-black' : ''
              }`}
              style={layer.isPremounted ? { opacity: 0, pointerEvents: 'none' as const } : styles}
              playsInline
              preload="auto"
              onLoadedData={(e) => {
                const video = e.currentTarget;
                const targetTime = layer.clipTime;
                if (layer.trackId === 'V2' || layer.trackId === 'V3') {
                  console.log(`[V2DBG][onLoadedData] id=${layer.id} isPremounted=${layer.isPremounted} video.ct=${video.currentTime.toFixed(3)} targetTime=${targetTime.toFixed(3)} isPlaying=${isPlaying}`);
                }
                if (Math.abs(video.currentTime - targetTime) > 0.05) {
                  video.currentTime = targetTime;
                }
                if (isPlaying && !layer.isPremounted) {
                  video.play().catch(() => {});
                }
              }}
              onMouseDown={(e) => handleLayerMouseDown(e, layer)}
            />
          );
        }

        if (layer.type === 'image') {
          // For overlay images (V2, V3), use explicit sizing instead of fill-then-scale
          if (isOverlay) {
            const scale = layer.transform?.scale || 0.2;
            const xOffset = layer.transform?.x || 0;
            const yOffset = layer.transform?.y || 0;
            const baseZIndex = (styles.zIndex as number) || 0;

            return (
              <div
                key={layer.id}
                className="absolute cursor-grab active:cursor-grabbing"
                style={{
                  width: `${scale * 100}%`,
                  top: `calc(70% + ${yOffset}px)`,
                  left: `calc(50% + ${xOffset}px)`,
                  transform: 'translateX(-50%)',
                  zIndex: baseZIndex + 100,
                  opacity: layer.transform?.opacity ?? 1,
                }}
                onMouseDown={(e) => handleLayerMouseDown(e, layer)}
              >
                <img
                  src={layer.url}
                  alt="Layer"
                  className="w-full h-auto rounded-lg shadow-lg pointer-events-none"
                  draggable={false}
                />
                {/* Selection indicator */}
                {isSelected && (
                  <div className="absolute inset-0 ring-2 ring-orange-500 rounded-lg pointer-events-none" />
                )}
                {/* Drag handle indicator */}
                {!isDragging && (
                  <div className="absolute top-2 right-2 p-1.5 bg-black/60 rounded text-white/70 pointer-events-none">
                    <Move className="w-3 h-3" />
                  </div>
                )}
              </div>
            );
          }

          // For V1 images (full background), use the original fill approach
          return (
            <div
              key={layer.id}
              className="absolute inset-0 w-full h-full"
              style={{ ...styles, pointerEvents: 'none' }}
            >
              <img
                src={layer.url}
                alt="Layer"
                className="w-full h-full object-contain pointer-events-none"
                draggable={false}
              />
            </div>
          );
        }

        if (layer.type === 'caption' && layer.captionWords && layer.captionStyle) {
          return (
            <CaptionRenderer
              key={layer.id}
              words={layer.captionWords}
              style={layer.captionStyle}
              currentTime={layer.clipTime}
              isPlaying={isPlaying}
              clipStart={layer.clipStart}
              currentTimeRef={currentTimeRef}
            />
          );
        }

        // Audio layers - invisible but play audio synced to timeline
        if (layer.type === 'audio') {
          return (
            <audio
              key={`audio-${layer.id}`}
              ref={(el) => {
                if (el) {
                  overlayVideoRefs.current.set(layer.id, el as unknown as HTMLVideoElement);
                } else {
                  overlayVideoRefs.current.delete(layer.id);
                }
              }}
              src={layer.url}
              preload="auto"
              onLoadedData={(e) => {
                const audio = e.currentTarget;
                const targetTime = currentTimeRef
                  ? Math.max(0, currentTimeRef.current - layer.clipStart + layer.inPoint)
                  : layer.clipTime;
                if (Math.abs(audio.currentTime - targetTime) > 0.05) {
                  audio.currentTime = targetTime;
                }
                if (isPlaying) audio.play().catch(() => {});
              }}
              style={{ display: 'none' }}
            />
          );
        }

        return null;
      })}

      {/* Transition compositor canvas — draws from already-playing video refs */}
      <canvas
        ref={canvasRef}
        width={isVertical ? 1080 : 1920}
        height={isVertical ? 1920 : 1080}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          zIndex: 50,
          pointerEvents: 'none',
          display: activeTransitions.length > 0 ? 'block' : 'none',
        }}
      />

      {/* Layer count indicator */}
      {layers.length > 1 && (
        <div className="absolute top-3 left-3 text-xs text-white/60 bg-black/50 px-2 py-1 rounded flex items-center gap-1 z-50">
          <Layers className="w-3 h-3" />
          <span>{layers.length} layers</span>
        </div>
      )}

      {/* Type indicator */}
      <div className="absolute bottom-3 right-3 text-xs text-white/60 bg-black/50 px-2 py-1 rounded flex items-center gap-1 z-50">
        {baseVideoLayer ? <Play className="w-3 h-3" /> : <ImageIcon className="w-3 h-3" />}
        <span>{baseVideoLayer ? 'video' : layers[0]?.type}</span>
      </div>

      {/* Dragging indicator */}
      {draggingLayer && (
        <div className="absolute bottom-3 left-3 text-xs text-orange-400 bg-black/70 px-2 py-1 rounded z-50">
          Dragging...
        </div>
      )}
    </div>
  );
});

export default VideoPreview;
