import { Play, Image as ImageIcon, Layers, Move } from 'lucide-react';
import { useRef, useEffect, forwardRef, useImperativeHandle, useMemo, useState, useCallback } from 'react';
import CaptionRenderer from './CaptionRenderer';
import TransitionPreview, { type ActiveTransition } from './TransitionPreview';
import type { CaptionWord, CaptionStyle } from '@/react-app/hooks/useProject';

const CSS_TRANSITION_IDS = new Set([
  'builtin-crossfade',
  'builtin-dip-to-black',
  'builtin-slide-left',
  'builtin-slide-right',
]);

function getCssTransitionStyles(
  transitionId: string,
  progress: number,
  target: 'from' | 'to' | 'overlay',
): React.CSSProperties | null {
  const p = Math.max(0, Math.min(1, progress));

  switch (transitionId) {
    case 'builtin-crossfade':
      if (target === 'from') return { opacity: 1 - p };
      if (target === 'to') return { opacity: p };
      return null;

    case 'builtin-dip-to-black': {
      const overlayOpacity = p < 0.5 ? p * 2 : 2 - p * 2;
      if (target === 'from') return { opacity: p < 0.5 ? 1 : 0 };
      if (target === 'to') return { opacity: p >= 0.5 ? 1 : 0 };
      if (target === 'overlay') return { opacity: overlayOpacity };
      return null;
    }

    case 'builtin-slide-left':
      if (target === 'from') return { transform: `translateX(${-p * 100}%)` };
      if (target === 'to') return { transform: `translateX(${(1 - p) * 100}%)` };
      return null;

    case 'builtin-slide-right':
      if (target === 'from') return { transform: `translateX(${p * 100}%)` };
      if (target === 'to') return { transform: `translateX(${-(1 - p) * 100}%)` };
      return null;

    default:
      return null;
  }
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
  seekAllOverlays: (timelineTime: number, oldTimelineTime: number) => void;
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

function waitForSeeked(el: HTMLMediaElement, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const onSeeked = () => {
      el.removeEventListener('seeked', onSeeked);
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      el.removeEventListener('seeked', onSeeked);
      resolve();
    }, timeoutMs);
    el.addEventListener('seeked', onSeeked);
  });
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
  const layersRef = useRef<ClipLayer[]>(layers);
  useEffect(() => { layersRef.current = layers; }, [layers]);
  const [draggingLayer, setDraggingLayer] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; layerX: number; layerY: number } | null>(null);
  const wasPlayingRef = useRef(isPlaying);
  const justPausedRef = useRef(false);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // Find the base video layer (V1) for audio/playback control
  const foundBaseLayer = layers.find(l => l.trackId === 'V1' && l.type === 'video');
  const baseLayerId = foundBaseLayer?.id;
  const baseLayerUrl = foundBaseLayer?.url;
  const baseLayerClipTime = foundBaseLayer?.clipTime;
  const baseLayerClipTimeRef = useRef(baseLayerClipTime);
  useEffect(() => { baseLayerClipTimeRef.current = baseLayerClipTime; }, [baseLayerClipTime]);
  const seekGenerationRef = useRef(0);
  const liveTransitions = useMemo(() =>
    activeTransitions.filter(t => !t.premount),
    [activeTransitions]
  );
  const hasActiveTransition = liveTransitions.length > 0;

  // Split transitions: CSS-handled (builtin, no extra decoders) vs Remotion-handled (custom)
  const cssTransitions = useMemo(() =>
    liveTransitions.filter(t => CSS_TRANSITION_IDS.has(t.transitionFileId)),
    [liveTransitions]
  );
  const remotionTransitions = useMemo(() =>
    activeTransitions.filter(t => !CSS_TRANSITION_IDS.has(t.transitionFileId)),
    [activeTransitions]
  );
  const hasCssTransition = cssTransitions.length > 0;
  const hasRemotionTransition = remotionTransitions.filter(t => !t.premount).length > 0;

  // Compute CSS transition styles for V1 (from) and V2 (to) elements
  const cssTransitionState = useMemo(() => {
    if (!hasCssTransition) return null;
    const t = cssTransitions[0];
    const progress = Math.max(0, Math.min(1, (currentTime - t.startTime) / t.durationSec));
    return {
      transitionId: t.transitionFileId,
      progress,
      fromClipId: t.fromSrc ? 'v1' : null,
      toClipId: t.toSrc ? 'v2' : null,
      v1Style: getCssTransitionStyles(t.transitionFileId, progress, 'from'),
      v2Style: getCssTransitionStyles(t.transitionFileId, progress, 'to'),
      overlayStyle: getCssTransitionStyles(t.transitionFileId, progress, 'overlay'),
    };
  }, [hasCssTransition, cssTransitions, currentTime]);

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
    seekAllOverlays: (timelineTime: number, oldTimelineTime: number) => {
      const generation = ++seekGenerationRef.current;
      const delta = timelineTime - oldTimelineTime;
      const promises: Promise<void>[] = [];

      overlayVideoRefs.current.forEach((mediaEl, layerId) => {
        const layer = layersRef.current.find(l => l.id === layerId);
        if (layer && layer.clipTime !== undefined) {
          const newDecoderTime = layer.clipTime + delta;
          if (newDecoderTime >= 0) {
            mediaEl.pause();
            mediaEl.currentTime = newDecoderTime;
            promises.push(waitForSeeked(mediaEl, 800));
          }
        }
      });

      const v1 = videoRef.current;
      if (v1 && v1.seeking) {
        promises.push(waitForSeeked(v1, 800));
      }

      Promise.allSettled(promises).then(() => {
        if (seekGenerationRef.current !== generation) return;
        overlayVideoRefs.current.forEach(mediaEl => {
          if (isPlayingRef.current) mediaEl.play().catch(() => {});
        });
      });
    },
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

  // Seek control for base video (only when paused/scrubbing)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || baseLayerClipTime === undefined) return;
    if (isPlaying) return;
    if (justPausedRef.current) return;

    const doSeek = () => {
      if (Math.abs(video.currentTime - baseLayerClipTime) > 0.05) {
        video.currentTime = baseLayerClipTime;
      }
    };

    if (video.seeking) {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        doSeek();
      };
      video.addEventListener('seeked', onSeeked);
      return () => video.removeEventListener('seeked', onSeeked);
    }

    doSeek();
  }, [baseLayerClipTime, isPlaying]);

  // Play/pause control for base video
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.play().catch((err) => {
        console.error('[VideoPreview] Play failed:', err.name, err.message);
      });
    } else {
      video.pause();
    }
  }, [isPlaying, baseLayerId]);

  // Play/pause control for overlay videos (V2, V3, etc.)
  useEffect(() => {
    overlayVideoRefs.current.forEach((el, id) => {
      if (isPlaying) {
        if (hasRemotionTransition) {
          const layer = layersRef.current.find(l => l.id === id);
          if (layer?.type === 'video' && layer.trackId !== 'V1') return;
        }
        el.play().catch(() => {});
      } else {
        el.pause();
      }
    });
  }, [isPlaying, hasRemotionTransition]);

  useEffect(() => {
    if (wasPlayingRef.current && !isPlaying) {
      justPausedRef.current = true;
    }
    wasPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Sync overlay video and audio seeking when scrubbing
  useEffect(() => {
    if (isPlaying) return;
    if (justPausedRef.current) {
      justPausedRef.current = false;
      return;
    }

    // Find overlay video and audio layers and sync their time
    const overlayMediaLayers = layers.filter(
      l => (l.type === 'video' && l.trackId !== 'V1') || l.type === 'audio'
    );

    overlayMediaLayers.forEach((layer) => {
      const mediaEl = overlayVideoRefs.current.get(layer.id);
      if (!mediaEl || mediaEl.seeking) return;
      if (mediaEl && layer.clipTime !== undefined) {
        if (Math.abs(mediaEl.currentTime - layer.clipTime) > 0.1) {
          mediaEl.currentTime = layer.clipTime;
        }
      }
    });
  }, [layers, isPlaying]);

  // Gate overlay video decode during Remotion transitions only (CSS transitions use native elements)
  useEffect(() => {
    if (!hasRemotionTransition) return;

    overlayVideoRefs.current.forEach((el, id) => {
      const layer = layersRef.current.find(l => l.id === id);
      if (layer?.type === 'video' && layer.trackId !== 'V1') {
        el.pause();
      }
    });

    return () => {
      if (isPlayingRef.current) {
        overlayVideoRefs.current.forEach((el, id) => {
          const layer = layersRef.current.find(l => l.id === id);
          if (layer?.type === 'video' && layer.trackId !== 'V1') {
            el.play().catch(() => {});
          }
        });
      }
    };
  }, [hasRemotionTransition]);

  // Periodic overlay drift correction during playback
  useEffect(() => {
    if (!isPlaying) return;

    const DRIFT_THRESHOLD = 0.15;
    const CORRECTION_INTERVAL = 250;

    const intervalId = setInterval(() => {
      const currentLayers = layersRef.current;
      const overlayMediaLayers = currentLayers.filter(
        l => (l.type === 'video' && l.trackId !== 'V1') || l.type === 'audio'
      );
      overlayMediaLayers.forEach((layer) => {
        const mediaEl = overlayVideoRefs.current.get(layer.id);
        if (!mediaEl || mediaEl.paused || mediaEl.seeking) return;
        if (hasRemotionTransition && layer.type === 'video' && layer.trackId !== 'V1') return;
        const drift = layer.clipTime - mediaEl.currentTime;
        if (drift > DRIFT_THRESHOLD) {
          mediaEl.currentTime = layer.clipTime;
        }
      });
    }, CORRECTION_INTERVAL);

    return () => clearInterval(intervalId);
  }, [isPlaying]);

  const handleLoaded = useCallback(() => {
    const video = videoRef.current;
    const clipTime = baseLayerClipTimeRef.current;
    if (!video || clipTime === undefined) return;
    video.currentTime = clipTime;
    if (isPlayingRef.current) {
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
  }, []);

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
          style={{ zIndex: 1, ...cssTransitionState?.v1Style }}
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
              style={{
                ...styles,
                ...(hasCssTransition ? cssTransitionState?.v2Style : {}),
                visibility: hasRemotionTransition ? 'hidden' : undefined,
              }}
              playsInline
              preload="auto"
              muted
              onLoadedData={(e) => {
                const video = e.currentTarget;
                if (layer.clipTime !== undefined) {
                  video.currentTime = layer.clipTime;
                  if (isPlaying) {
                    if (video.readyState >= 2 && Math.abs(video.currentTime - layer.clipTime) < 0.05) {
                      video.play().catch(() => {});
                    } else {
                      const onSeeked = () => {
                        video.removeEventListener('seeked', onSeeked);
                        clearTimeout(fallbackTimer);
                        video.play().catch(() => {});
                      };
                      const fallbackTimer = setTimeout(() => {
                        video.removeEventListener('seeked', onSeeked);
                        video.play().catch(() => {});
                      }, 250);
                      video.addEventListener('seeked', onSeeked);
                    }
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
                  if (isPlaying) {
                    if (audio.readyState >= 2 && Math.abs(audio.currentTime - layer.clipTime) < 0.05) {
                      audio.play().catch(() => {});
                    } else {
                      const onSeeked = () => {
                        audio.removeEventListener('seeked', onSeeked);
                        clearTimeout(fallbackTimer);
                        audio.play().catch(() => {});
                      };
                      const fallbackTimer = setTimeout(() => {
                        audio.removeEventListener('seeked', onSeeked);
                        audio.play().catch(() => {});
                      }, 250);
                      audio.addEventListener('seeked', onSeeked);
                    }
                  }
                } else if (isPlaying) {
                  audio.play().catch(() => {});
                }
              }}
              style={{ display: 'none' }}
            />
          );
        }

        return null;
      })}

      {/* CSS transition overlay for dip-to-black */}
      {cssTransitionState?.overlayStyle && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: 'black',
            zIndex: 40,
            pointerEvents: 'none',
            ...cssTransitionState.overlayStyle,
          }}
        />
      )}

      {/* Remotion Player only for custom (non-builtin) transitions */}
      {remotionTransitions.map(t => (
        <TransitionPreview
          key={t.id}
          transition={t}
          currentTime={currentTime}
          fps={30}
          width={isVertical ? 1080 : 1920}
          height={isVertical ? 1920 : 1080}
          isPlaying={isPlaying}
        />
      ))}

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
