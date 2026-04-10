import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { ZoomIn, ZoomOut, Play, Pause, SkipBack, Scissors, Trash2, Type, RectangleHorizontal, RectangleVertical, Link, Unlink } from 'lucide-react';
import TimelineClip from './TimelineClip';
import type { Track, TimelineClip as TimelineClipType, Asset, CaptionData, JunctionTransition, JunctionTransitionType, TimelineTransition } from '@/react-app/hooks/useProject';

interface TimelineProps {
  tracks: Track[];
  clips: TimelineClipType[];
  assets: Asset[];
  selectedClipId: string | null;
  selectedClipIds?: string[];
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  aspectRatio: '16:9' | '9:16';
  onSelectClip: (id: string | null, shiftKey?: boolean) => void;
  onTimeChange: (time: number) => void;
  onPlayPause: () => void;
  onStop: () => void;
  onMoveClip: (clipId: string, newStart: number, newTrackId?: string) => void;
  onResizeClip: (clipId: string, newInPoint: number, newOutPoint: number, newStart?: number) => void;
  onDeleteClip: (clipId: string) => void;
  onCutAtPlayhead: () => void;
  onAddText: () => void;
  onToggleAspectRatio: () => void;
  autoSnap?: boolean;
  onToggleAutoSnap?: () => void;
  onDropAsset: (asset: Asset, trackId: string, time: number) => void;
  onSave: () => void;
  getCaptionData?: (clipId: string) => CaptionData | null;
  transitions: JunctionTransition[];
  onAddTransition: (fromClipId: string, toClipId: string, type?: JunctionTransitionType, durationSec?: number) => JunctionTransition;
  onUpdateTransition: (transitionId: string, updates: Partial<Omit<JunctionTransition, 'id'>>) => void;
  onRemoveTransition: (transitionId: string) => void;
  // V2 timeline transitions
  timelineTransitions?: TimelineTransition[];
  selectedTransitionId?: string | null;
  onSelectTransition?: (id: string | null) => void;
  onUpdateTimelineTransition?: (id: string, updates: Partial<Omit<TimelineTransition, 'id'>>) => void;
  onRemoveTimelineTransition?: (id: string) => void;
}

const TRACK_HEIGHTS: Record<string, number> = {
  video: 56,
  audio: 44,
  text: 48,
};

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function Timeline({
  tracks,
  clips,
  assets,
  selectedClipId,
  selectedClipIds = [],
  currentTime,
  duration,
  isPlaying,
  aspectRatio,
  onSelectClip,
  onTimeChange,
  onPlayPause,
  onStop,
  onMoveClip,
  onResizeClip,
  onDeleteClip,
  onCutAtPlayhead,
  onAddText,
  onToggleAspectRatio,
  autoSnap = true,
  onToggleAutoSnap,
  onDropAsset,
  onSave,
  getCaptionData,
  transitions,
  onAddTransition,
  onUpdateTransition,
  onRemoveTransition,
  timelineTransitions = [],
  selectedTransitionId,
  onSelectTransition,
  onUpdateTimelineTransition,
  onRemoveTimelineTransition,
}: TimelineProps) {
  const [zoom, setZoom] = useState(1);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
  const [dragOverTrack, setDragOverTrack] = useState<string | null>(null);

  const timelineRef = useRef<HTMLDivElement>(null);
  const tracksContainerRef = useRef<HTMLDivElement>(null);
  const trackHeadersRef = useRef<HTMLDivElement>(null);

  // Sync vertical scroll between track headers and tracks content
  useEffect(() => {
    const tracksContainer = tracksContainerRef.current;
    const trackHeaders = trackHeadersRef.current;
    if (!tracksContainer || !trackHeaders) return;

    const handleScroll = () => {
      trackHeaders.scrollTop = tracksContainer.scrollTop;
    };

    tracksContainer.addEventListener('scroll', handleScroll);
    return () => tracksContainer.removeEventListener('scroll', handleScroll);
  }, []);

  // Shift + Scroll to zoom timeline
  useEffect(() => {
    const tracksContainer = tracksContainerRef.current;
    if (!tracksContainer) return;

    const handleWheel = (e: WheelEvent) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      // deltaY > 0 = scroll down = zoom out, deltaY < 0 = scroll up = zoom in
      setZoom(prev => {
        if (e.deltaY > 0) {
          return Math.max(0.25, prev - 0.25);
        } else {
          return Math.min(4, prev + 0.25);
        }
      });
    };

    tracksContainer.addEventListener('wheel', handleWheel, { passive: false });
    return () => tracksContainer.removeEventListener('wheel', handleWheel);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Delete selected clip with Delete or Backspace key
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedClipId) {
        // Don't trigger if user is typing in an input
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
          return;
        }
        e.preventDefault();
        onDeleteClip(selectedClipId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedClipId, onDeleteClip]);

  // Calculate display properties
  const totalDuration = Math.max(duration, 10);
  const basePixelsPerSecond = Math.min(100, 2000 / totalDuration);
  const pixelsPerSecond = basePixelsPerSecond * zoom;
  const timelineWidth = Math.max(totalDuration * pixelsPerSecond, 800);

  // Track header width
  const headerWidth = 48;

  // Time ruler intervals
  const getTimeInterval = useCallback(() => {
    const effectiveZoom = pixelsPerSecond / 50;
    if (effectiveZoom > 2) return 1;
    if (effectiveZoom > 1) return 5;
    if (effectiveZoom > 0.5) return 10;
    if (effectiveZoom > 0.2) return 30;
    return 60;
  }, [pixelsPerSecond]);

  const timeInterval = getTimeInterval();
  const tickCount = Math.ceil(totalDuration / timeInterval) + 1;

  // Sort tracks by order
  const sortedTracks = useMemo(() =>
    [...tracks].sort((a, b) => a.order - b.order),
    [tracks]
  );

  // Get clips for a specific track
  const getTrackClips = useCallback((trackId: string) =>
    clips.filter(c => c.trackId === trackId),
    [clips]
  );

  // Handle clicking on timeline to seek
  const handleTimelineClick = useCallback((e: React.MouseEvent) => {
    if (!tracksContainerRef.current) return;

    const rect = tracksContainerRef.current.getBoundingClientRect();
    const scrollLeft = tracksContainerRef.current.scrollLeft;
    const clickX = e.clientX - rect.left + scrollLeft;
    const newTime = Math.max(0, Math.min(clickX / pixelsPerSecond, duration));

    onTimeChange(newTime);
    onSelectClip(null);
  }, [pixelsPerSecond, duration, onTimeChange, onSelectClip]);

  // Handle playhead dragging
  const handlePlayheadMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDraggingPlayhead(true);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDraggingPlayhead || !tracksContainerRef.current) return;

    const rect = tracksContainerRef.current.getBoundingClientRect();
    const scrollLeft = tracksContainerRef.current.scrollLeft;
    const clickX = e.clientX - rect.left + scrollLeft;
    const newTime = Math.max(0, Math.min(clickX / pixelsPerSecond, duration));

    onTimeChange(newTime);
  }, [isDraggingPlayhead, pixelsPerSecond, duration, onTimeChange]);

  const handleMouseUp = useCallback(() => {
    setIsDraggingPlayhead(false);
  }, []);

  // Handle drop from asset library
  const handleDragOver = useCallback((e: React.DragEvent, trackId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverTrack(trackId);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverTrack(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, trackId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverTrack(null);

    const assetData = e.dataTransfer.getData('application/x-hyperedit-asset');
    if (!assetData) return;

    try {
      const asset = JSON.parse(assetData) as Asset;

      // Calculate drop time position
      const rect = tracksContainerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const scrollLeft = tracksContainerRef.current?.scrollLeft || 0;
      const dropX = e.clientX - rect.left + scrollLeft;
      const dropTime = Math.max(0, dropX / pixelsPerSecond);

      onDropAsset(asset, trackId, dropTime);
    } catch (err) {
      console.error('Failed to parse dropped asset:', err);
    }
  }, [pixelsPerSecond, onDropAsset]);

  // Get asset for a clip
  const getAssetForClip = useCallback((clip: TimelineClipType) =>
    assets.find(a => a.id === clip.assetId),
    [assets]
  );

  // Find adjacent clip pairs on a track for transition indicators
  const getAdjacentPairs = useCallback((trackId: string) => {
    const trackClips = clips
      .filter(c => c.trackId === trackId)
      .sort((a, b) => a.start - b.start);

    const pairs: Array<{
      fromClip: TimelineClipType;
      toClip: TimelineClipType;
      junctionX: number;
      transition: JunctionTransition | null;
    }> = [];

    for (let i = 0; i < trackClips.length - 1; i++) {
      const fromClip = trackClips[i];
      const toClip = trackClips[i + 1];
      const fromEnd = fromClip.start + fromClip.duration;
      const gapSec = toClip.start - fromEnd;
      const junctionX = fromEnd * pixelsPerSecond;

      // Only show transition indicators for clips within 2s of each other
      if (gapSec <= 2) {
        const existing = transitions.find(
          t => t.fromClipId === fromClip.id && t.toClipId === toClip.id
        );
        pairs.push({ fromClip, toClip, junctionX, transition: existing || null });
      }
    }

    return pairs;
  }, [clips, transitions, pixelsPerSecond]);

  return (
    <div
      ref={timelineRef}
      className="flex flex-col h-full select-none"
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Timeline header */}
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-800/50 border-b border-zinc-700/50">
        <div className="flex items-center gap-3">
          {/* Playback controls */}
          <div className="flex items-center gap-1">
            <button
              onClick={onStop}
              className="p-1.5 bg-zinc-700 hover:bg-zinc-600 rounded transition-colors"
              title="Stop (go to start)"
            >
              <SkipBack className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onPlayPause}
              className={`p-1.5 rounded transition-colors ${
                isPlaying
                  ? 'bg-orange-500 hover:bg-orange-600 text-white'
                  : 'bg-zinc-700 hover:bg-zinc-600'
              }`}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Pause className="w-3.5 h-3.5" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
            </button>
          </div>

          {/* Editing tools */}
          <div className="flex items-center gap-1 border-l border-zinc-700 pl-3 ml-1">
            <button
              onClick={onCutAtPlayhead}
              className="p-1.5 bg-zinc-700 hover:bg-zinc-600 rounded transition-colors"
              title="Cut at playhead (split clip)"
            >
              <Scissors className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => selectedClipId && onDeleteClip(selectedClipId)}
              disabled={!selectedClipId}
              className="p-1.5 bg-zinc-700 hover:bg-red-600 disabled:opacity-40 disabled:hover:bg-zinc-700 rounded transition-colors"
              title="Delete selected clip (Delete key)"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onAddText}
              className="p-1.5 bg-zinc-700 hover:bg-zinc-600 rounded transition-colors"
              title="Add text overlay"
            >
              <Type className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onToggleAspectRatio}
              className="p-1.5 bg-zinc-700 hover:bg-zinc-600 rounded transition-colors"
              title={`Currently ${aspectRatio === '16:9' ? '16:9 (horizontal)' : '9:16 (vertical)'} - click to switch`}
            >
              {aspectRatio === '16:9' ? (
                <RectangleHorizontal className="w-3.5 h-3.5" />
              ) : (
                <RectangleVertical className="w-3.5 h-3.5" />
              )}
            </button>
            <div className="w-px h-4 bg-zinc-600" />
            <button
              onClick={onToggleAutoSnap}
              className={`p-1.5 rounded transition-colors ${
                autoSnap
                  ? 'bg-orange-500/20 text-orange-400 hover:bg-orange-500/30'
                  : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-400'
              }`}
              title={autoSnap ? 'Auto-snap ON: Clips shift when deleting' : 'Auto-snap OFF: Gaps remain when deleting'}
            >
              {autoSnap ? (
                <Link className="w-3.5 h-3.5" />
              ) : (
                <Unlink className="w-3.5 h-3.5" />
              )}
            </button>
          </div>

          {/* Time display */}
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono text-orange-400">{formatTime(currentTime)}</span>
            <span className="text-zinc-600">/</span>
            <span className="font-mono text-zinc-400">{formatTime(duration)}</span>
          </div>
        </div>

        {/* Zoom controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}
            className="p-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors"
            title="Zoom out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs text-zinc-400 w-12 text-center">{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => setZoom(Math.min(4, zoom + 0.25))}
            className="p-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-xs transition-colors"
            title="Zoom in"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Timeline content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Track headers (fixed horizontally, syncs vertically) */}
        <div
          className="flex-shrink-0 bg-zinc-900/80 border-r border-zinc-700/50 flex flex-col"
          style={{ width: headerWidth }}
        >
          {/* Spacer for time ruler (sticky) */}
          <div className="h-6 border-b border-zinc-800 flex-shrink-0" />

          {/* Track labels (scrolls vertically with tracks) */}
          <div
            ref={trackHeadersRef}
            className="flex-1 overflow-hidden"
          >
            {sortedTracks.map(track => {
              const trackClipCount = clips.filter(c => c.trackId === track.id).length;
              const isTextTrack = track.type === 'text' && trackClipCount > 0;

              return (
                <div
                  key={track.id}
                  className="flex items-center justify-center gap-1 text-xs font-medium text-zinc-400 border-b border-zinc-800/50 px-1"
                  style={{ height: TRACK_HEIGHTS[track.type] }}
                >
                  <span className="truncate">{track.name}</span>
                  {isTextTrack && (
                    <button
                      title={`Delete all ${trackClipCount} captions`}
                      className="p-0.5 rounded hover:bg-red-500/20 hover:text-red-400 transition-colors flex-shrink-0"
                      onClick={() => {
                        if (confirm(`Delete all ${trackClipCount} captions on ${track.name}?`)) {
                          clips
                            .filter(c => c.trackId === track.id)
                            .forEach(c => onDeleteClip(c.id));
                        }
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Scrollable tracks area */}
        <div
          ref={tracksContainerRef}
          className="flex-1 overflow-auto"
          onMouseMove={handleMouseMove}
        >
          <div
            className="relative"
            style={{ width: timelineWidth, minHeight: '100%' }}
          >
            {/* Time ruler */}
            <div
              className="sticky top-0 h-6 bg-zinc-900/95 border-b border-zinc-800 z-30"
              onClick={handleTimelineClick}
            >
              {Array.from({ length: tickCount }).map((_, i) => {
                const time = i * timeInterval;
                if (time > totalDuration) return null;
                return (
                  <div
                    key={i}
                    className="absolute flex flex-col items-start"
                    style={{ left: `${time * pixelsPerSecond}px` }}
                  >
                    <span className="text-[10px] text-zinc-500 pl-1">{formatTime(time)}</span>
                    <div className="w-px h-2 bg-zinc-700" />
                  </div>
                );
              })}
            </div>

            {/* Tracks */}
            <div onClick={handleTimelineClick}>
              {sortedTracks.map(track => {
                const trackClips = getTrackClips(track.id);
                const isDragOver = dragOverTrack === track.id;

                return (
                  <div
                    key={track.id}
                    className={`relative border-b border-zinc-800/50 ${
                      isDragOver ? 'bg-orange-500/10' : 'bg-zinc-900/30'
                    }`}
                    style={{ height: TRACK_HEIGHTS[track.type] }}
                    onDragOver={(e) => handleDragOver(e, track.id)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, track.id)}
                  >
                    {/* Track background grid lines */}
                    {Array.from({ length: tickCount }).map((_, i) => {
                      const time = i * timeInterval;
                      if (time > totalDuration) return null;
                      return (
                        <div
                          key={i}
                          className="absolute top-0 bottom-0 w-px bg-zinc-800/50"
                          style={{ left: `${time * pixelsPerSecond}px` }}
                        />
                      );
                    })}

                    {/* Empty track placeholder */}
                    {trackClips.length === 0 && !isDragOver && (
                      <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-600 pointer-events-none">
                        Drop clips here
                      </div>
                    )}

                    {/* Drop indicator */}
                    {isDragOver && (
                      <div className="absolute inset-0 flex items-center justify-center text-xs text-orange-400 pointer-events-none border-2 border-dashed border-orange-500/50 rounded">
                        Drop to add clip
                      </div>
                    )}

                    {/* Clips */}
                    {trackClips.map(clip => {
                      const captionData = getCaptionData?.(clip.id);
                      const isCaption = track.type === 'text';
                      const captionPreview = captionData?.words
                        .slice(0, 5)
                        .map(w => w.text)
                        .join(' ') + (captionData && captionData.words.length > 5 ? '...' : '');

                      return (
                        <TimelineClip
                          key={clip.id}
                          clip={clip}
                          asset={getAssetForClip(clip)}
                          pixelsPerSecond={pixelsPerSecond}
                          isSelected={selectedClipIds?.includes(clip.id) || selectedClipId === clip.id}
                          trackHeight={TRACK_HEIGHTS[track.type]}
                          onClick={(e?: React.MouseEvent) => onSelectClip(clip.id, e?.shiftKey)}
                          onMove={(newStart) => onMoveClip(clip.id, newStart)}
                          onResize={(inPoint, outPoint, newStart) =>
                            onResizeClip(clip.id, inPoint, outPoint, newStart)
                          }
                          onDelete={() => onDeleteClip(clip.id)}
                          onDragEnd={onSave}
                          isCaption={isCaption}
                          captionPreview={captionPreview}
                        />
                      );
                    })}

                    {/* Legacy transition indicators (v1 - same-track adjacent only) */}
                    {track.type === 'video' && getAdjacentPairs(track.id).map(({ fromClip, toClip, junctionX, transition }) => (
                      <TransitionIndicator
                        key={`tr-${fromClip.id}-${toClip.id}`}
                        junctionX={junctionX}
                        trackHeight={TRACK_HEIGHTS[track.type]}
                        transition={transition}
                        pixelsPerSecond={pixelsPerSecond}
                        onAdd={() => {
                          onAddTransition(fromClip.id, toClip.id, 'crossfade', 0.5);
                          onSave();
                        }}
                        onRemove={() => {
                          if (transition) {
                            onRemoveTransition(transition.id);
                            onSave();
                          }
                        }}
                        onUpdate={(updates) => {
                          if (transition) {
                            onUpdateTransition(transition.id, updates);
                            onSave();
                          }
                        }}
                      />
                    ))}

                    {/* V2 timeline transition entities on this track */}
                    {timelineTransitions
                      .filter(t => {
                        // Show transition on this track if either from or to clip is on this track
                        const fromClip = t.fromClipId ? clips.find(c => c.id === t.fromClipId) : null;
                        const toClip = t.toClipId ? clips.find(c => c.id === t.toClipId) : null;
                        // Show on the "from" clip's track (or "to" if from is null)
                        const primaryTrackId = fromClip?.trackId || toClip?.trackId;
                        return primaryTrackId === track.id;
                      })
                      .map(t => (
                        <TransitionEntity
                          key={`tl-tr-${t.id}`}
                          transition={t}
                          clips={clips}
                          tracks={tracks}
                          trackHeight={TRACK_HEIGHTS[track.type]}
                          pixelsPerSecond={pixelsPerSecond}
                          isSelected={selectedTransitionId === t.id}
                          onSelect={() => onSelectTransition?.(t.id)}
                          onUpdate={(updates) => {
                            onUpdateTimelineTransition?.(t.id, updates);
                            onSave();
                          }}
                          onRemove={() => {
                            onRemoveTimelineTransition?.(t.id);
                            onSave();
                          }}
                        />
                      ))}
                  </div>
                );
              })}
            </div>

            {/* Playhead */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-orange-500 z-40 pointer-events-none"
              style={{ left: `${currentTime * pixelsPerSecond}px` }}
            >
              {/* Playhead handle */}
              <div
                className="absolute -top-0 -left-2.5 w-5 h-5 cursor-ew-resize pointer-events-auto"
                onMouseDown={handlePlayheadMouseDown}
              >
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent border-t-orange-500" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const TRANSITION_LABELS: Record<string, string> = {
  crossfade: 'XF',
  'slide-left': 'SL',
  'slide-right': 'SR',
  'dip-to-black': 'DB',
  custom: 'CT',
};

const TRANSITION_TYPES: JunctionTransitionType[] = ['crossfade', 'slide-left', 'slide-right', 'dip-to-black'];
const DURATION_PRESETS = [0.25, 0.5, 1.0, 1.5];

function TransitionIndicator({
  junctionX,
  trackHeight,
  transition,
  pixelsPerSecond,
  onAdd,
  onRemove,
  onUpdate,
}: {
  junctionX: number;
  trackHeight: number;
  transition: JunctionTransition | null;
  pixelsPerSecond: number;
  onAdd: () => void;
  onRemove: () => void;
  onUpdate: (updates: Partial<Omit<JunctionTransition, 'id'>>) => void;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const indicatorWidth = transition
    ? Math.max(transition.durationSec * pixelsPerSecond, 20)
    : 20;

  return (
    <div
      className="absolute z-20 flex items-center justify-center group"
      style={{
        left: `${junctionX - indicatorWidth / 2}px`,
        width: `${indicatorWidth}px`,
        top: '2px',
        height: `${trackHeight - 4}px`,
      }}
    >
      {transition ? (
        <div
          className="w-full h-full bg-orange-500/20 border border-orange-500/50 rounded flex items-center justify-center cursor-pointer hover:bg-orange-500/30 transition-colors relative"
          onClick={(e) => {
            e.stopPropagation();
            setShowMenu(!showMenu);
          }}
        >
          <span className="text-[9px] font-bold text-orange-400 select-none">
            {TRANSITION_LABELS[transition.type] || '?'}
          </span>

          {showMenu && (
            <div
              className="absolute top-full mt-1 left-0 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl p-2 z-50 min-w-[140px]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-[10px] text-zinc-400 mb-1 px-1">Type</div>
              {TRANSITION_TYPES.map(type => (
                <button
                  key={type}
                  onClick={() => {
                    onUpdate({ type });
                    setShowMenu(false);
                  }}
                  className={`w-full text-left px-2 py-1 text-xs rounded ${
                    transition.type === type
                      ? 'bg-orange-500/20 text-orange-400'
                      : 'hover:bg-zinc-700 text-zinc-300'
                  }`}
                >
                  {type}
                </button>
              ))}

              <div className="border-t border-zinc-700 mt-1 pt-1">
                <div className="text-[10px] text-zinc-400 mb-1 px-1">Duration</div>
                <div className="flex gap-1 px-1">
                  {DURATION_PRESETS.map(dur => (
                    <button
                      key={dur}
                      onClick={() => {
                        onUpdate({ durationSec: dur });
                        setShowMenu(false);
                      }}
                      className={`px-1.5 py-0.5 text-[10px] rounded ${
                        transition.durationSec === dur
                          ? 'bg-orange-500/20 text-orange-400'
                          : 'hover:bg-zinc-700 text-zinc-300'
                      }`}
                    >
                      {dur}s
                    </button>
                  ))}
                </div>
              </div>

              <div className="border-t border-zinc-700 mt-1 pt-1">
                <button
                  onClick={() => {
                    onRemove();
                    setShowMenu(false);
                  }}
                  className="w-full text-left px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 rounded"
                >
                  Remove transition
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          className="opacity-0 group-hover:opacity-100 w-5 h-5 bg-zinc-700 hover:bg-orange-500 rounded-full flex items-center justify-center transition-all text-zinc-400 hover:text-white"
          title="Add transition"
        >
          <span className="text-xs font-bold">+</span>
        </button>
      )}
    </div>
  );
}

// --- V2 Timeline Transition Entity ---
import { getTransitionMeta } from '@/remotion/transitions/registry';

function TransitionEntity({
  transition,
  clips: allClips,
  trackHeight,
  pixelsPerSecond,
  isSelected,
  onSelect,
  onUpdate,
  onRemove,
}: {
  transition: TimelineTransition;
  clips: TimelineClipType[];
  tracks: Track[];
  trackHeight: number;
  pixelsPerSecond: number;
  isSelected: boolean;
  onSelect: () => void;
  onUpdate: (updates: Partial<Omit<TimelineTransition, 'id'>>) => void;
  onRemove: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);
  const dragStartRef = useRef({ x: 0, startTime: 0, durationSec: 0 });

  const meta = getTransitionMeta(transition.transitionFileId);
  const transitionName = meta?.name || transition.transitionFileId;
  const width = Math.max(transition.durationSec * pixelsPerSecond, 16);
  const left = transition.startTime * pixelsPerSecond;

  const fromClip = transition.fromClipId ? allClips.find(c => c.id === transition.fromClipId) : null;
  const toClip = transition.toClipId ? allClips.find(c => c.id === transition.toClipId) : null;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect();
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, startTime: transition.startTime, durationSec: transition.durationSec };

    const handleMouseMove = (moveE: MouseEvent) => {
      const deltaX = moveE.clientX - dragStartRef.current.x;
      const deltaSec = deltaX / pixelsPerSecond;
      const newStart = Math.max(0, dragStartRef.current.startTime + deltaSec);
      onUpdate({ startTime: newStart });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [onSelect, onUpdate, pixelsPerSecond, transition.startTime, transition.durationSec]);

  const handleResizeLeft = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsResizingLeft(true);
    dragStartRef.current = { x: e.clientX, startTime: transition.startTime, durationSec: transition.durationSec };

    const handleMouseMove = (moveE: MouseEvent) => {
      const deltaX = moveE.clientX - dragStartRef.current.x;
      const deltaSec = deltaX / pixelsPerSecond;
      const newStart = Math.max(0, dragStartRef.current.startTime + deltaSec);
      const newDuration = Math.max(0.05, dragStartRef.current.durationSec - deltaSec);
      onUpdate({ startTime: newStart, durationSec: newDuration });
    };

    const handleMouseUp = () => {
      setIsResizingLeft(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [onUpdate, pixelsPerSecond, transition.startTime, transition.durationSec]);

  const handleResizeRight = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsResizingRight(true);
    dragStartRef.current = { x: e.clientX, startTime: transition.startTime, durationSec: transition.durationSec };

    const handleMouseMove = (moveE: MouseEvent) => {
      const deltaX = moveE.clientX - dragStartRef.current.x;
      const deltaSec = deltaX / pixelsPerSecond;
      const newDuration = Math.max(0.05, dragStartRef.current.durationSec + deltaSec);
      onUpdate({ durationSec: newDuration });
    };

    const handleMouseUp = () => {
      setIsResizingRight(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [onUpdate, pixelsPerSecond, transition.durationSec, transition.startTime]);

  return (
    <div
      className={`absolute z-30 group ${isDragging || isResizingLeft || isResizingRight ? 'cursor-grabbing' : 'cursor-grab'}`}
      style={{
        left: `${left}px`,
        width: `${width}px`,
        top: '1px',
        height: `${trackHeight - 2}px`,
      }}
      onMouseDown={handleMouseDown}
    >
      <div
        className={`w-full h-full rounded border flex items-center justify-center relative overflow-hidden ${
          isSelected
            ? 'bg-purple-500/30 border-purple-400'
            : 'bg-purple-500/15 border-purple-500/40 hover:bg-purple-500/25'
        }`}
      >
        {/* Left resize handle */}
        <div
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-purple-400/50 z-10"
          onMouseDown={handleResizeLeft}
        />

        {/* Content */}
        <div className="flex flex-col items-center justify-center px-2 min-w-0">
          <span className="text-[8px] font-bold text-purple-300 truncate max-w-full">
            {transitionName}
          </span>
          {width > 60 && (
            <span className="text-[7px] text-purple-400/70 truncate max-w-full">
              {fromClip ? `${(fromClip.assetId || '').slice(0, 4)}` : 'black'}
              {' → '}
              {toClip ? `${(toClip.assetId || '').slice(0, 4)}` : 'black'}
            </span>
          )}
        </div>

        {/* Right resize handle */}
        <div
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-purple-400/50 z-10"
          onMouseDown={handleResizeRight}
        />

        {/* Delete button on hover */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-white z-20"
          title="Remove transition"
        >
          <span className="text-[8px] font-bold">×</span>
        </button>
      </div>
    </div>
  );
}
