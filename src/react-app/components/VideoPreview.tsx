import { Play, Image as ImageIcon, Layers, Move } from 'lucide-react';
import { useRef, useEffect, forwardRef, useImperativeHandle, useMemo, useState, useCallback } from 'react';
import CaptionRenderer from './CaptionRenderer';
import { getCanvasDraw, getTransitionVolumes } from '@/remotion/transitions/canvas-draw';
import type { CaptionWord, CaptionStyle } from '@/react-app/hooks/useProject';

export interface ActiveTransition {
  id: string;
  transitionFileId: string;
  startTime: number;
  durationSec: number;
  fromClipId?: string;
  toClipId?: string;
  fromSrc?: string;
  toSrc?: string;
  fromAssetType?: 'video' | 'image';
  toAssetType?: 'video' | 'image';
  fromStartSec: number;
  toStartSec: number;
  params: Record<string, number | string | boolean>;
}

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
  transform?: ClipTransform;
  // Caption-specific data
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
}, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadedSrcRef = useRef<string | null>(null);
  const overlayVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hiddenVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const hiddenImageRefs = useRef<Map<string, HTMLImageElement>>(new Map());
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const activeTransitionsRef = useRef(activeTransitions);
  activeTransitionsRef.current = activeTransitions;
  const baseLayerClipTimeRef = useRef<number | undefined>(undefined);
  const layerClipTimesRef = useRef<Map<string, number>>(new Map());
  const wasPlayingRef = useRef(false);
  const prevCurrentTimeRef = useRef(currentTime);

  const [draggingLayer, setDraggingLayer] = useState<string | null>(null);
  const hasActiveTransition = activeTransitions.length > 0;
  const [dragStart, setDragStart] = useState<{ x: number; y: number; layerX: number; layerY: number } | null>(null);

  // Find the base video layer (V1) for audio/playback control
  const foundBaseLayer = layers.find(l => l.trackId === 'V1' && l.type === 'video');
  const baseLayerId = foundBaseLayer?.id;
  const baseLayerUrl = foundBaseLayer?.url;
  const baseLayerClipTime = foundBaseLayer?.clipTime;
  baseLayerClipTimeRef.current = baseLayerClipTime;

  // Update overlay clip times ref synchronously each render
  const newClipTimes = new Map<string, number>();
  for (const l of layers) {
    if (((l.type === 'video' && l.trackId !== 'V1') || l.type === 'audio') && l.clipTime !== undefined) {
      newClipTimes.set(l.id, l.clipTime);
    }
  }
  layerClipTimesRef.current = newClipTimes;

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
      if (loadedSrcRef.current) {
        console.log('[VideoPreview] Source changed, reloading video with audio');
        console.log('[VideoPreview] Old:', loadedSrcRef.current?.slice(-60));
        console.log('[VideoPreview] New:', baseLayerUrl.slice(-60));
      }
      video.src = baseLayerUrl;
      video.load();
      loadedSrcRef.current = baseLayerUrl;
    }
  }, [baseLayerUrl]);

  useEffect(() => {
    const baseVideo = videoRef.current;

    if (isPlaying) {
      if (!wasPlayingRef.current) {
        const seekPromises: Promise<void>[] = [];

        if (baseVideo && baseLayerClipTime !== undefined) {
          if (Math.abs(baseVideo.currentTime - baseLayerClipTime) > 0.02) {
            baseVideo.currentTime = baseLayerClipTime;
            seekPromises.push(new Promise<void>(resolve => {
              const onSeeked = () => { baseVideo.removeEventListener('seeked', onSeeked); clearTimeout(t); resolve(); };
              const t = setTimeout(() => { baseVideo.removeEventListener('seeked', onSeeked); resolve(); }, 400);
              baseVideo.addEventListener('seeked', onSeeked);
            }));
          }
        }

        overlayVideoRefs.current.forEach((el, id) => {
          const target = layerClipTimesRef.current.get(id);
          if (target === undefined) return;
          if (Math.abs(el.currentTime - target) > 0.001) {
            el.currentTime = target;
            seekPromises.push(new Promise<void>(resolve => {
              const onSeeked = () => { el.removeEventListener('seeked', onSeeked); clearTimeout(t); resolve(); };
              const t = setTimeout(() => { el.removeEventListener('seeked', onSeeked); resolve(); }, 400);
              el.addEventListener('seeked', onSeeked);
            }));
          }
        });

        const startAll = () => {
          baseVideo?.play().catch(() => {});
          overlayVideoRefs.current.forEach(v => v.play().catch(() => {}));
        };

        if (seekPromises.length > 0) {
          Promise.allSettled(seekPromises).then(startAll);
        } else {
          startAll();
        }
      }
    } else {
      baseVideo?.pause();
      if (baseVideo) baseVideo.playbackRate = 1.0;
      overlayVideoRefs.current.forEach(v => { v.pause(); v.playbackRate = 1.0; });
    }

    wasPlayingRef.current = isPlaying;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying]);

  // Scrub sync (paused only) — tight tolerance for precise preview
  useEffect(() => {
    if (isPlaying) return;

    const base = videoRef.current;
    if (base && baseLayerClipTime !== undefined) {
      if (Math.abs(base.currentTime - baseLayerClipTime) > 0.01) {
        base.currentTime = baseLayerClipTime;
      }
    }

    overlayVideoRefs.current.forEach((el, id) => {
      const ct = layerClipTimesRef.current.get(id);
      if (ct !== undefined) {
        if (Math.abs(el.currentTime - ct) > 0.01) {
          el.currentTime = ct;
        }
      }
    });
  }, [isPlaying, baseLayerClipTime, layers]);

  useEffect(() => {
    const delta = Math.abs(currentTime - prevCurrentTimeRef.current);
    prevCurrentTimeRef.current = currentTime;

    if (!isPlaying || delta < 0.2) return;

    const base = videoRef.current;
    const allElements: HTMLMediaElement[] = [];
    if (base) allElements.push(base);
    overlayVideoRefs.current.forEach(el => allElements.push(el));
    allElements.forEach(el => el.pause());

    if (base && baseLayerClipTime !== undefined) base.currentTime = baseLayerClipTime;
    overlayVideoRefs.current.forEach((el, id) => {
      const ct = layerClipTimesRef.current.get(id);
      if (ct !== undefined) el.currentTime = ct;
    });

    const seekPromises = allElements
      .filter(el => el.seeking)
      .map(el => new Promise<void>(resolve => {
        const onSeeked = () => { el.removeEventListener('seeked', onSeeked); clearTimeout(t); resolve(); };
        const t = setTimeout(() => { el.removeEventListener('seeked', onSeeked); resolve(); }, 400);
        el.addEventListener('seeked', onSeeked);
      }));

    if (seekPromises.length > 0) {
      Promise.allSettled(seekPromises).then(() => {
        allElements.forEach(el => el.play().catch(() => {}));
      });
    } else {
      allElements.forEach(el => el.play().catch(() => {}));
    }
  }, [isPlaying, currentTime, baseLayerClipTime, layers]);

  // --- Canvas transition compositing ---

  const getVideoSource = useCallback((clipId: string | undefined, src: string | undefined, assetType: string | undefined): CanvasImageSource | null => {
    if (!clipId && !src) return null;

    // Try native elements first
    if (clipId) {
      if (clipId === baseLayerId && videoRef.current) return videoRef.current;
      const overlay = overlayVideoRefs.current.get(clipId);
      if (overlay) return overlay;
    }

    // Hidden video/image fallback
    if (src) {
      if (assetType === 'image') {
        let img = hiddenImageRefs.current.get(src);
        if (!img) {
          img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = src;
          hiddenImageRefs.current.set(src, img);
        }
        return img.complete ? img : null;
      }
      const hidden = hiddenVideoRefs.current.get(src);
      if (hidden && hidden.readyState >= 2) return hidden;
    }
    return null;
  }, [baseLayerId]);

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const ct = currentTimeRef.current;
    const transitions = activeTransitionsRef.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const t of transitions) {
      const progress = Math.max(0, Math.min(1, (ct - t.startTime) / t.durationSec));
      const drawFn = getCanvasDraw(t.transitionFileId);
      const fromEl = getVideoSource(t.fromClipId, t.fromSrc, t.fromAssetType);
      const toEl = getVideoSource(t.toClipId, t.toSrc, t.toAssetType);
      drawFn(ctx, fromEl, toEl, progress, canvas.width, canvas.height, t.params);

      // Volume crossfade
      const { fromVolume, toVolume } = getTransitionVolumes(t.transitionFileId, progress);
      if (t.fromClipId) {
        const fromVideo = t.fromClipId === baseLayerId ? videoRef.current : overlayVideoRefs.current.get(t.fromClipId);
        if (fromVideo) fromVideo.volume = fromVolume;
      }
      if (t.toClipId) {
        const toVideo = t.toClipId === baseLayerId ? videoRef.current : overlayVideoRefs.current.get(t.toClipId);
        if (toVideo) toVideo.volume = toVolume;
      }
    }
  }, [getVideoSource, baseLayerId]);

  // rAF loop when playing with active transitions
  useEffect(() => {
    if (!hasActiveTransition || !isPlaying) return;
    let animId: number;
    const loop = () => {
      drawFrame();
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [hasActiveTransition, isPlaying, drawFrame]);

  // Single draw on scrub (paused)
  useEffect(() => {
    if (!hasActiveTransition || isPlaying) return;
    drawFrame();
  }, [currentTime, hasActiveTransition, isPlaying, drawFrame]);

  // Manage hidden videos for same-track transitions
  useEffect(() => {
    const neededSrcs = new Set<string>();
    for (const t of activeTransitions) {
      if (t.fromSrc && t.fromAssetType === 'video') {
        const hasNative = (t.fromClipId === baseLayerId && videoRef.current) ||
          (t.fromClipId && overlayVideoRefs.current.has(t.fromClipId));
        if (!hasNative) neededSrcs.add(t.fromSrc);
      }
      if (t.toSrc && t.toAssetType === 'video') {
        const hasNative = (t.toClipId === baseLayerId && videoRef.current) ||
          (t.toClipId && overlayVideoRefs.current.has(t.toClipId));
        if (!hasNative) neededSrcs.add(t.toSrc);
      }
    }

    // Create missing hidden videos
    for (const src of neededSrcs) {
      if (!hiddenVideoRefs.current.has(src)) {
        const v = document.createElement('video');
        v.preload = 'auto';
        v.playsInline = true;
        v.muted = true;
        v.src = src;
        v.style.display = 'none';
        document.body.appendChild(v);
        hiddenVideoRefs.current.set(src, v);
      }
    }

    // Remove stale hidden videos
    for (const [src, v] of hiddenVideoRefs.current) {
      if (!neededSrcs.has(src)) {
        v.pause();
        v.src = '';
        v.load();
        v.remove();
        hiddenVideoRefs.current.delete(src);
      }
    }
  }, [activeTransitions, baseLayerId]);

  // Sync hidden video currentTime
  useEffect(() => {
    for (const t of activeTransitions) {
      const elapsed = currentTime - t.startTime;
      if (t.fromSrc && t.fromAssetType === 'video') {
        const hidden = hiddenVideoRefs.current.get(t.fromSrc);
        if (hidden) {
          const targetTime = t.fromStartSec + elapsed;
          if (isPlaying) {
            if (hidden.paused) {
              hidden.currentTime = targetTime;
              hidden.play().catch(() => {});
            }
          } else {
            hidden.pause();
            if (Math.abs(hidden.currentTime - targetTime) > 0.03) {
              hidden.currentTime = targetTime;
            }
          }
        }
      }
      if (t.toSrc && t.toAssetType === 'video') {
        const hidden = hiddenVideoRefs.current.get(t.toSrc);
        if (hidden) {
          const targetTime = t.toStartSec + elapsed;
          if (isPlaying) {
            if (hidden.paused) {
              hidden.currentTime = targetTime;
              hidden.play().catch(() => {});
            }
          } else {
            hidden.pause();
            if (Math.abs(hidden.currentTime - targetTime) > 0.03) {
              hidden.currentTime = targetTime;
            }
          }
        }
      }
    }
  }, [activeTransitions, currentTime, isPlaying]);

  // Reset volumes when transitions end + cleanup on unmount
  useEffect(() => {
    if (!hasActiveTransition) {
      if (videoRef.current) videoRef.current.volume = 1;
      overlayVideoRefs.current.forEach(v => { v.volume = 1; });
    }
  }, [hasActiveTransition]);

  useEffect(() => {
    const refs = hiddenVideoRefs.current;
    return () => {
      refs.forEach(v => { v.pause(); v.src = ''; v.load(); v.remove(); });
      refs.clear();
    };
  }, []);


  const handleLoaded = useCallback(() => {
    const video = videoRef.current;
    const clipTime = baseLayerClipTimeRef.current;
    if (!video || clipTime === undefined) return;
    video.currentTime = clipTime;
    if (isPlaying) {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        clearTimeout(fallback);
        video.play().catch(() => {});
      };
      const fallback = setTimeout(() => {
        video.removeEventListener('seeked', onSeeked);
        video.play().catch(() => {});
      }, 250);
      video.addEventListener('seeked', onSeeked);
    }
  }, [isPlaying]);

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
                } else {
                  overlayVideoRefs.current.delete(layer.id);
                }
              }}
              src={layer.url}
              className={`absolute inset-0 w-full h-full ${videoFitClass} cursor-grab active:cursor-grabbing ${
                isSelected ? 'ring-2 ring-orange-500 ring-offset-2 ring-offset-black' : ''
              }`}
              style={styles}
              playsInline
              preload="auto"
              onLoadedData={(e) => {
                const video = e.currentTarget;
                if (layer.clipTime !== undefined) {
                  video.currentTime = layer.clipTime;
                  if (isPlaying) {
                    const onSeeked = () => {
                      video.removeEventListener('seeked', onSeeked);
                      clearTimeout(fallback);
                      video.play().catch(() => {});
                    };
                    const fallback = setTimeout(() => {
                      video.removeEventListener('seeked', onSeeked);
                      video.play().catch(() => {});
                    }, 250);
                    video.addEventListener('seeked', onSeeked);
                  }
                } else if (isPlaying) {
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
                if (layer.clipTime !== undefined) {
                  audio.currentTime = layer.clipTime;
                }
                if (isPlaying) {
                  audio.play().catch(() => {});
                }
              }}
              style={{ display: 'none' }}
            />
          );
        }

        return null;
      })}

      {/* Canvas transition compositor */}
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
          display: hasActiveTransition ? 'block' : 'none',
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
