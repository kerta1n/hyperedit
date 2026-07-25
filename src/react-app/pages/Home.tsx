import { API_BASE, pollJob } from '@/react-app/utils/api-helpers';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import VideoPreview, { VideoPreviewHandle } from '@/react-app/components/VideoPreview';
import Timeline from '@/react-app/components/Timeline';
import AssetLibrary from '@/react-app/components/AssetLibrary';
import ClipPropertiesPanel from '@/react-app/components/ClipPropertiesPanel';
import CaptionPropertiesPanel from '@/react-app/components/CaptionPropertiesPanel';
import { useCaptionGeneration } from '@/react-app/hooks/useCaptionGeneration';
import TransitionPropertiesPanel from '@/react-app/components/TransitionPropertiesPanel';
import TrackPropertiesPanel from '@/react-app/components/TrackPropertiesPanel';
import AIPromptPanel, { type AnimationConcept } from '@/react-app/components/AIPromptPanel';
import PicassoPanel from '@/react-app/components/PicassoPanel';
import DiCaprioPanel from '@/react-app/components/DiCaprioPanel';
import GifSearchPanel from '@/react-app/components/GifSearchPanel';
import ResizablePanel from '@/react-app/components/ResizablePanel';
import ResizableVerticalPanel from '@/react-app/components/ResizableVerticalPanel';
import TimelineTabs from '@/react-app/components/TimelineTabs';
import RenderSettingsModal from '@/react-app/components/RenderSettingsModal';
import { useProject, Asset, TimelineClip, CaptionStyle } from '@/react-app/hooks/useProject';
import type { RenderOptions } from '@/react-app/hooks/useProject';
import { deriveTimelineVideoTarget } from '@/react-app/utils/target-helpers';
import SessionManager from '@/react-app/components/SessionManager';
import { Sparkles, ListOrdered, Copy, Check, X, Download, Play, Palette, Film } from 'lucide-react';
import type { ActiveTransition } from '@/react-app/components/TransitionPreview';
import type { TemplateId } from '@/remotion/templates';

interface ChapterData {
  chapters: Array<{ start: number; title: string }>;
  youtubeFormat: string;
  summary: string;
}

const PREMOUNT_SECS = 2;

export default function Home() {
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [selectedTransitionId, setSelectedTransitionId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [availableTransitions, setAvailableTransitions] = useState<{ builtIn: string[]; custom: { id: string; name: string }[] }>({ builtIn: ['crossfade', 'slide-left', 'slide-right', 'dip-to-black'], custom: [] });
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [chapterData, setChapterData] = useState<ChapterData | null>(null);
  const [showChapters, setShowChapters] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '9:16'>('16:9');
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [trackAutoSnap, setTrackAutoSnap] = useState<Record<string, boolean>>({});
  const [activeAgent, setActiveAgent] = useState<'director' | 'picasso' | 'dicaprio'>('director');
  const [showGifSearch, setShowGifSearch] = useState(false);
  const [showRenderSettings, setShowRenderSettings] = useState(false);
  const [recommendedConcurrency, setRecommendedConcurrency] = useState(4);

  const videoPreviewRef = useRef<VideoPreviewHandle>(null);
  const playbackRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const currentTimeRef = useRef<number>(0);
  const boundariesRef = useRef<number[]>([]);

  // Use the new project hook for multi-asset management
  const {
    session,
    assets,
    tracks,
    clips,
    loading,
    status,
    checkServer,
    uploadAsset,
    deleteAsset,
    getAssetStreamUrl,
    refreshAssets,
    addClip,
    updateClip,
    deleteClip,
    moveClip,
    splitClip,
    saveProject,
    loadProject,
    renderProject,
    getDuration,
    // Captions
    addCaptionClip,
    addCaptionClipsBatch,
    deleteCaptionClips,
    updateCaptionStyle,
    updateCaptionWords,
    getCaptionData,
    clipsRef,
    // Transitions (legacy v1)
    transitions,
    setTransitions,
    addLegacyTransition,
    // Timeline Transitions (v2)
    timelineTransitions,
    addTransition,
    updateTransition,
    removeTransition,
    updateTabTransitions,
    // Timeline tabs
    timelineTabs,
    activeTabId,
    createTimelineTab,
    switchTimelineTab,
    closeTimelineTab,
    updateTabClips,
    updateTabAsset,
    // Settings
    settings,
    setSettings,
    setStatus,
    // Render options
    renderOptions,
    setRenderOptions,
    // Session management
    setSession,
    saveProjectImmediate,
    resetProjectState,
  } = useProject();

  const resetLocalState = useCallback(() => {
    setSelectedClipId(null);
    setSelectedClipIds([]);
    setSelectedTransitionId(null);
    setSelectedAssetId(null);
    setPreviewAssetId(null);
    setCurrentTime(0);
    setIsPlaying(false);
    setChapterData(null);
    setShowChapters(false);
    setShowGifSearch(false);
    setShowRenderSettings(false);
    setSelectedTrackId(null);
  }, []);

  // Compute the active clips based on which tab is selected
  const activeClips = useMemo(() => {
    if (activeTabId === 'main') {
      return clips;
    }
    const activeTab = timelineTabs.find(tab => tab.id === activeTabId);
    return activeTab?.clips || [];
  }, [activeTabId, clips, timelineTabs]);


  // Check server on mount
  useEffect(() => {
    checkServer();
  }, [checkServer]);

  // Load project from server when session becomes available
  useEffect(() => {
    if (session) {
      console.log('Session available, loading project...');
      loadProject();
    }
  }, [session, loadProject]);

  // Get all clips at the current playhead position as layers
  const getPreviewLayers = useCallback(() => {
    // If a specific asset is selected for preview (from library), show only that
    if (previewAssetId) {
      const asset = assets.find(a => a.id === previewAssetId);
      // Use asset.streamUrl which has cache-busting timestamp
      const url = asset?.streamUrl || (asset ? getAssetStreamUrl(previewAssetId) : null);
      if (asset && url) {
        return [{
          id: 'preview-' + previewAssetId,
          url,
          type: asset.type,
          trackId: 'V1',
          clipTime: 0,
          clipStart: 0,
          inPoint: 0,
        }];
      }
      return [];
    }

    // Find ALL clips at the current playhead position
    const layers: Array<{
      id: string;
      url: string;
      type: 'video' | 'image' | 'audio' | 'caption';
      trackId: string;
      clipTime: number;
      clipStart: number;
      inPoint: number;
      isPremounted?: boolean;
      transform?: TimelineClip['transform'];
      captionWords?: Array<{ text: string; start: number; end: number }>;
      captionStyle?: CaptionStyle;
    }> = [];

    // Check video tracks (V1, V2, V3...)
    const videoTracks = ['V1', 'V2', 'V3'];

    for (const trackId of videoTracks) {
      const isOverlayTrack = trackId !== 'V1';
      const clipsOnTrack = activeClips.filter(c =>
        c.trackId === trackId &&
        currentTime >= c.start - (isOverlayTrack ? PREMOUNT_SECS : 0) &&
        currentTime < c.start + c.duration
      );

      for (const clip of clipsOnTrack) {
        const asset = assets.find(a => a.id === clip.assetId);
        // Use asset.streamUrl which has cache-busting timestamp from refreshAssets
        const url = asset?.streamUrl || (asset ? getAssetStreamUrl(asset.id) : null);
        if (asset && url) {
          const isPremounted = isOverlayTrack && currentTime < clip.start;
          const clipTime = isPremounted
            ? (clip.inPoint || 0)
            : (currentTime - clip.start) + (clip.inPoint || 0);
          layers.push({
            id: clip.id,
            url,
            type: asset.type,
            trackId: clip.trackId,
            clipTime,
            clipStart: clip.start,
            inPoint: clip.inPoint || 0,
            isPremounted,
            transform: clip.transform,
          });
        }
      }
    }

    // Check audio tracks (A1, A2)
    const audioTracks = ['A1', 'A2'];

    for (const trackId of audioTracks) {
      const allTrackClips = activeClips.filter(c => c.trackId === trackId);
      const clipsOnTrack = allTrackClips.filter(c =>
        currentTime >= c.start &&
        currentTime < c.start + c.duration
      );

      for (const clip of clipsOnTrack) {
        const asset = assets.find(a => a.id === clip.assetId);
        const url = asset?.streamUrl || (asset ? getAssetStreamUrl(asset.id) : null);
        if (asset && url && asset.type === 'audio') {
          const clipTime = (currentTime - clip.start) + (clip.inPoint || 0);
          layers.push({
            id: clip.id,
            url,
            type: 'audio',
            trackId: clip.trackId,
            clipTime,
            clipStart: clip.start,
            inPoint: clip.inPoint || 0,
          });
        }
      }
    }

    // Check caption track (T1)
    const captionClips = activeClips.filter(c =>
      c.trackId === 'T1' &&
      currentTime >= c.start &&
      currentTime < c.start + c.duration
    );

    for (const clip of captionClips) {
      const caption = getCaptionData(clip.id);
      if (caption) {
        // Words have relative timestamps (0 to chunk duration), so pass clip-relative time
        layers.push({
          id: clip.id,
          url: '',
          type: 'caption',
          trackId: clip.trackId,
          clipTime: currentTime - clip.start, // Convert to clip-relative time
          clipStart: clip.start,
          inPoint: 0,
          captionWords: caption.words,
          captionStyle: caption.style,
        });
      }
    }

    return layers;
  }, [previewAssetId, assets, activeClips, currentTime, getAssetStreamUrl, getCaptionData]);

  const previewLayers = getPreviewLayers();
  const hasPreviewContent = previewLayers.length > 0;

  // Detect active transitions at current playhead for preview overlay
  const previewActiveTransitions = useMemo((): ActiveTransition[] => {
    if (previewAssetId) return []; // No transitions in single-asset preview mode
    const currentTransitions = activeTabId === 'main'
      ? timelineTransitions
      : (timelineTabs.find(t => t.id === activeTabId)?.timelineTransitions || []);

    return currentTransitions
      .filter(t => currentTime >= t.startTime && currentTime < t.startTime + t.durationSec)
      .map(t => {
        const fromClip = t.fromClipId ? activeClips.find(c => c.id === t.fromClipId) : null;
        const toClip = t.toClipId ? activeClips.find(c => c.id === t.toClipId) : null;
        const fromAsset = fromClip ? assets.find(a => a.id === fromClip.assetId) : null;
        const toAsset = toClip ? assets.find(a => a.id === toClip.assetId) : null;

        return {
          id: t.id,
          transitionFileId: t.transitionFileId,
          startTime: t.startTime,
          durationSec: t.durationSec,
          fromClipId: t.fromClipId ?? undefined,
          toClipId:   t.toClipId   ?? undefined,
          fromSrc: fromAsset ? (fromAsset.streamUrl || getAssetStreamUrl(fromAsset.id) || undefined) : undefined,
          toSrc:   toAsset   ? (toAsset.streamUrl   || getAssetStreamUrl(toAsset.id)   || undefined) : undefined,
          fromAssetType: fromAsset?.type === 'video' ? 'video' as const : fromAsset ? 'image' as const : undefined,
          toAssetType:   toAsset?.type   === 'video' ? 'video' as const : toAsset   ? 'image' as const : undefined,
          fromClipStart: fromClip ? fromClip.start : undefined,
          fromInPoint:   fromClip ? (fromClip.inPoint || 0) : undefined,
          fromClipDuration: fromClip ? fromClip.duration : undefined,
          params: t.params,
        };
      });
  }, [previewAssetId, activeTabId, timelineTransitions, timelineTabs, currentTime, activeClips, assets, getAssetStreamUrl]);

  // Get duration based on active tab's clips
  const duration = useMemo(() => {
    if (activeClips.length === 0) return 0;
    return Math.max(...activeClips.map(c => c.start + c.duration));
  }, [activeClips]);

  // Pre-compute clip/transition boundary times for RAF boundary detection
  const clipBoundaries = useMemo(() => {
    const times = new Set<number>();
    activeClips.forEach(c => {
      times.add(c.start);
      times.add(c.start + c.duration);
      if (c.trackId === 'V2' || c.trackId === 'V3') {
        times.add(Math.max(0, c.start - PREMOUNT_SECS));
      }
    });
    const txns = activeTabId === 'main'
      ? timelineTransitions
      : (timelineTabs.find(t => t.id === activeTabId)?.timelineTransitions || []);
    txns.forEach(t => { times.add(t.startTime); times.add(t.startTime + t.durationSec); });
    return Array.from(times).sort((a, b) => a - b);
  }, [activeClips, activeTabId, timelineTransitions, timelineTabs]);
  boundariesRef.current = clipBoundaries;

  // Timeline playback — ref-based time with boundary-triggered state updates
  useEffect(() => {
    if (isPlaying && duration > 0) {
      lastTimeRef.current = performance.now();

      const animate = (now: number) => {
        const delta = (now - lastTimeRef.current) / 1000;
        lastTimeRef.current = now;
        const prevTime = currentTimeRef.current;
        const newTime = prevTime + delta;

        if (newTime >= duration) {
          currentTimeRef.current = duration;
          setCurrentTime(duration);
          setIsPlaying(false);
          return;
        }

        currentTimeRef.current = newTime;

        const boundaries = boundariesRef.current;
        for (let i = 0; i < boundaries.length; i++) {
          if (prevTime < boundaries[i] && newTime >= boundaries[i]) {
            setCurrentTime(newTime);
            break;
          }
        }

        playbackRef.current = requestAnimationFrame(animate);
      };

      playbackRef.current = requestAnimationFrame(animate);

      return () => {
        if (playbackRef.current) {
          cancelAnimationFrame(playbackRef.current);
        }
      };
    }
  }, [isPlaying, duration]);

  const handlePlayPause = useCallback(() => {
    if (currentTime >= duration && duration > 0) {
      setCurrentTime(0);
      currentTimeRef.current = 0;
    } else if (isPlaying) {
      setCurrentTime(currentTimeRef.current);
    } else {
      currentTimeRef.current = currentTime;
    }
    setIsPlaying(prev => !prev);
  }, [currentTime, duration, isPlaying]);

  const handleStop = useCallback(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    currentTimeRef.current = 0;
  }, []);

  const handleTimelineSeek = useCallback((time: number) => {
    currentTimeRef.current = time;
    setCurrentTime(time);
  }, []);

  // Called by VideoPreview after V1's seeked event fires with V1's actual post-snap position.
  // V1 keyframe-snaps backward from the requested time; this propagates the correction into
  // React state so getPreviewLayers recomputes layer.clipTime accurately for all overlays.
  const handleV1Seeked = useCallback((projectTime: number) => {
    currentTimeRef.current = projectTime;
    setCurrentTime(projectTime);
  }, []);


  // Handle asset upload
  const handleAssetUpload = useCallback(async (files: FileList) => {
    for (const file of Array.from(files)) {
      try {
        const newAsset = await uploadAsset(file);

        // Auto-determine project settings from the uploaded video: orientation
        // maps to the canonical HD pair, fps comes from the source probe.
        // aspectRatio derives from settings via the sync effect below.
        // Only while the timeline is unshaped — once clips are placed, a b-roll
        // upload must not silently flip the whole project's canvas/fps.
        if (clips.length === 0 && newAsset && newAsset.type === 'video' && newAsset.width && newAsset.height) {
          const isPortrait = newAsset.height > newAsset.width;
          setSettings(s => ({
            width: isPortrait ? 1080 : 1920,
            height: isPortrait ? 1920 : 1080,
            fps: newAsset.fps || s.fps,
          }));
          console.log(`Auto-detected project settings: ${isPortrait ? '9:16 (portrait)' : '16:9 (landscape)'} from ${newAsset.width}x${newAsset.height}${newAsset.fps ? ` @ ${newAsset.fps}fps` : ''}`);
        }
      } catch (error) {
        console.error('Upload failed:', error);
        alert(`Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }, [uploadAsset, setSettings, clips.length]);

  // Handle GIF added from search panel
  const handleGifAdded = useCallback(async () => {
    // Refresh assets to include the newly added GIF
    await refreshAssets();
    setShowGifSearch(false);
  }, [refreshAssets]);

  // Handle drag start from asset library
  const handleAssetDragStart = useCallback(() => {
    // Asset drag is handled by the browser's native drag-drop
  }, []);

  // Handle asset selection (from library)
  const handleAssetSelect = useCallback((assetId: string | null) => {
    setSelectedAssetId(assetId);
    // When selecting from library, preview that asset
    setPreviewAssetId(assetId);
    // Clear timeline clip selection
    setSelectedClipId(null);
  }, []);

  // Handle dropping asset onto timeline
  const handleDropAsset = useCallback((asset: Asset, trackId: string, time: number) => {
    // Determine which track to use based on asset type
    let targetTrackId = trackId;

    // If dropping audio on video track, redirect to audio track
    if (asset.type === 'audio' && trackId.startsWith('V')) {
      targetTrackId = 'A1';
    }
    // If dropping video/image on audio track, redirect to video track
    if (asset.type !== 'audio' && trackId.startsWith('A')) {
      targetTrackId = 'V1';
    }

    // Images need a default duration (5 seconds) since they don't have inherent duration
    const clipDuration = asset.type === 'image' ? 5 : asset.duration;

    // Check if we're on an edit tab (not main)
    if (activeTabId !== 'main') {
      // Add clip to the edit tab's clips array
      const activeTab = timelineTabs.find(tab => tab.id === activeTabId);
      if (activeTab) {
        const newClip: TimelineClip = {
          id: crypto.randomUUID(),
          assetId: asset.id,
          trackId: targetTrackId,
          start: time,
          duration: clipDuration || 5,
          inPoint: 0,
          outPoint: clipDuration || 5,
        };
        updateTabClips(activeTabId, [...activeTab.clips, newClip]);
        console.log('Added clip to edit tab:', activeTabId, newClip);
      }
    } else {
      // Add clip to main timeline
      addClip(asset.id, targetTrackId, time, clipDuration);
    }
    saveProject();
  }, [addClip, saveProject, activeTabId, timelineTabs, updateTabClips]);

  // Handle moving clip
  const handleMoveClip = useCallback((clipId: string, newStart: number, newTrackId?: string) => {
    // Check if we're on an edit tab
    if (activeTabId !== 'main') {
      const activeTab = timelineTabs.find(tab => tab.id === activeTabId);
      if (activeTab) {
        const updatedClips = activeTab.clips.map(clip => {
          if (clip.id === clipId) {
            return {
              ...clip,
              start: newStart,
              trackId: newTrackId || clip.trackId,
            };
          }
          return clip;
        });
        updateTabClips(activeTabId, updatedClips);
      }
    } else {
      // Cross-track transitions are now valid in v2 — no need to remove transitions on track change
      moveClip(clipId, newStart, newTrackId);
    }
    // Debounced — drag streams collapse into one save after the last movement
    saveProject();
  }, [moveClip, activeTabId, timelineTabs, updateTabClips, saveProject]);

  // Handle resizing clip
  const handleResizeClip = useCallback((clipId: string, newInPoint: number, newOutPoint: number, newStart?: number) => {
    const newDuration = newOutPoint - newInPoint;

    // Check if we're on an edit tab
    if (activeTabId !== 'main') {
      const activeTab = timelineTabs.find(tab => tab.id === activeTabId);
      if (activeTab) {
        const clip = activeTab.clips.find(c => c.id === clipId);
        if (!clip) return;

        const updatedClips = activeTab.clips.map(c => {
          if (c.id === clipId) {
            return {
              ...c,
              inPoint: newInPoint,
              outPoint: newOutPoint,
              duration: newDuration,
              start: newStart ?? c.start,
            };
          }
          return c;
        });
        updateTabClips(activeTabId, updatedClips);
      }
    } else {
      const clip = clips.find(c => c.id === clipId);
      if (!clip) return;

      updateClip(clipId, {
        inPoint: newInPoint,
        outPoint: newOutPoint,
        duration: newDuration,
        start: newStart ?? clip.start,
      });
    }
    // Debounced — resize-handle drags collapse into one save
    saveProject();
  }, [clips, updateClip, activeTabId, timelineTabs, updateTabClips, saveProject]);

  // Handle deleting clip from timeline (with per-track auto-snap ripple)
  const handleDeleteClip = useCallback((clipId: string) => {
    // Check if we're on an edit tab
    if (activeTabId !== 'main') {
      const activeTab = timelineTabs.find(tab => tab.id === activeTabId);
      if (activeTab) {
        const updatedClips = activeTab.clips.filter(c => c.id !== clipId);
        updateTabClips(activeTabId, updatedClips);
        // Mirror main-path cleanup: caption data and the tab's transitions
        // referencing the removed clip would otherwise be orphaned. Prune only
        // ids absent from main — a dual-listed clip (Add Text while on a tab)
        // keeps its main copy and words, mirroring the closeTimelineTab guard
        if (!clipsRef.current.some(c => c.id === clipId)) {
          deleteCaptionClips([clipId]);
        }
        updateTabTransitions(
          activeTabId,
          activeTab.timelineTransitions.filter(
            t => t.fromClipId !== clipId && t.toClipId !== clipId
          )
        );
      }
    } else {
      const clip = clips.find(c => c.id === clipId);
      const ripple = clip ? (trackAutoSnap[clip.trackId] ?? false) : false;
      deleteClip(clipId, ripple);
    }

    if (selectedClipId === clipId) {
      setSelectedClipId(null);
    }
    // Deletes never persisted until some later action saved — a deleted clip
    // came back on reload
    saveProject();
  }, [deleteClip, deleteCaptionClips, clipsRef, updateTabTransitions, selectedClipId, trackAutoSnap, clips, activeTabId, timelineTabs, updateTabClips, saveProject]);

  // Handle cutting clips at the playhead position
  const handleCutAtPlayhead = useCallback(() => {
    // splitClip operates on main clips only — cutting while a tab is active
    // would silently edit the main timeline the user isn't looking at
    if (activeTabId !== 'main') {
      alert('Cut at playhead works on the main timeline only — switch back to Main first.');
      return;
    }

    // Find all clips that are under the playhead
    const clipsAtPlayhead = clips.filter(clip =>
      currentTime > clip.start && currentTime < clip.start + clip.duration
    );

    if (clipsAtPlayhead.length === 0) {
      return; // No clips to cut
    }

    // Split each clip at the playhead
    for (const clip of clipsAtPlayhead) {
      splitClip(clip.id, currentTime);
    }

    saveProject();
  }, [clips, currentTime, splitClip, saveProject, activeTabId]);

  // Handle adding text overlay at playhead
  const handleAddText = useCallback(() => {
    const clip = addCaptionClip(
      [{ text: 'Text', start: 0, end: 5 }],
      currentTime,
      5,
    );

    // Tab awareness: also add to active tab's clips if not on main
    if (activeTabId !== 'main') {
      const activeTab = timelineTabs.find(tab => tab.id === activeTabId);
      if (activeTab) {
        updateTabClips(activeTabId, [...activeTab.clips, clip]);
      }
    }

    saveProject();
  }, [currentTime, addCaptionClip, activeTabId, timelineTabs, updateTabClips, saveProject]);

  // Flush any pending debounced save when the page is being closed — closes
  // the ≤500ms edit-loss window on tab close. Best-effort: the browser may
  // kill the request mid-flight; acceptable, worst case equals the debounce
  // window and regeneration/redo covers it.
  useEffect(() => {
    const flush = () => { saveProjectImmediate(); };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [saveProjectImmediate]);

  // Keep the preview aspect toggle in sync with project settings — aspectRatio
  // isn't persisted, so loading a portrait project would otherwise leave the
  // preview in 16:9 while the settings (and renders) are 9:16
  useEffect(() => {
    setAspectRatio(settings.height > settings.width ? '9:16' : '16:9');
  }, [settings.width, settings.height]);

  // Project settings seed the render dialog's resolution/fps until the user
  // explicitly customizes them there — the dialog keeps the final say
  useEffect(() => {
    setRenderOptions(prev => prev.outputCustomized ? prev : ({
      ...prev,
      outputWidth: settings.width,
      outputHeight: settings.height,
      outputFps: settings.fps,
    }));
  }, [settings.width, settings.height, settings.fps, renderOptions.outputCustomized, setRenderOptions]);

  // Handle toggling aspect ratio
  const handleToggleAspectRatio = useCallback(() => {
    setAspectRatio(prev => {
      const newRatio = prev === '16:9' ? '9:16' : '16:9';
      // Update project settings with new dimensions
      if (newRatio === '9:16') {
        setSettings(s => ({ ...s, width: 1080, height: 1920 }));
      } else {
        setSettings(s => ({ ...s, width: 1920, height: 1080 }));
      }
      return newRatio;
    });
  }, [setSettings]);

  // Handle selecting clip (supports shift+click for multi-select)
  const handleSelectClip = useCallback((clipId: string | null, shiftKey?: boolean) => {
    if (clipId === null) {
      setSelectedClipId(null);
      setSelectedClipIds([]);
      setPreviewAssetId(null);
      return;
    }
    if (shiftKey) {
      setSelectedClipIds(prev => {
        if (prev.includes(clipId)) {
          return prev.filter(id => id !== clipId);
        }
        if (prev.length >= 2) {
          return [prev[1], clipId];
        }
        return [...prev, clipId];
      });
      setSelectedClipId(clipId);
    } else {
      setSelectedClipId(clipId);
      setSelectedClipIds([clipId]);
    }
    setPreviewAssetId(null);
  }, []);

  // Fetch available transitions from server
  const fetchAvailableTransitions = useCallback(async () => {
    if (!session) return;
    try {
      const response = await fetch(`${API_BASE}/session/${session.sessionId}/transitions`);
      if (response.ok) {
        const data = await response.json();
        setAvailableTransitions(data);
      }
    } catch { /* ignore */ }
  }, [session]);

  // Fetch transitions when session becomes available
  useEffect(() => {
    if (session) {
      fetchAvailableTransitions();
    }
  }, [session, fetchAvailableTransitions]);

  // Upload a custom transition .tsx file
  const handleUploadTransition = useCallback(async (file: File) => {
    if (!session) throw new Error('No session');
    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', file.name.replace(/\.tsx$/, ''));
    const response = await fetch(`${API_BASE}/session/${session.sessionId}/upload-transition`, {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Upload failed');
    await fetchAvailableTransitions();
    return data;
  }, [session, fetchAvailableTransitions]);

  // Delete a custom transition
  const handleDeleteTransition = useCallback(async (transitionId: string) => {
    if (!session) throw new Error('No session');
    const response = await fetch(`${API_BASE}/session/${session.sessionId}/delete-transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transitionId }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Delete failed');
    await fetchAvailableTransitions();
  }, [session, fetchAvailableTransitions]);

  // Generate a custom transition with AI
  const handleGenerateTransition = useCallback(async (description: string) => {
    if (!session) throw new Error('No session');
    const response = await fetch(`${API_BASE}/session/${session.sessionId}/generate-transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Generation failed');
    await fetchAvailableTransitions();
    return data;
  }, [session, fetchAvailableTransitions]);

  // Apply a transition between two selected clips (v2 internal)
  const handleApplyTransitionV2 = useCallback((
    fromClipId: string | null,
    toClipId: string | null,
    transitionFileId: string,
    durationSec: number,
    params: Record<string, number | string | boolean> = {},
  ) => {
    // Compute startTime from clip positions
    const activeClipsList = activeTabId === 'main' ? clips : (timelineTabs.find(t => t.id === activeTabId)?.clips || []);
    const fromClip = fromClipId ? activeClipsList.find(c => c.id === fromClipId) : null;
    const toClip = toClipId ? activeClipsList.find(c => c.id === toClipId) : null;

    let startTime = 0;
    if (fromClip && toClip) {
      const fromEnd = fromClip.start + fromClip.duration;
      const toStart = toClip.start;
      if (fromEnd > toStart) {
        // Overlapping: start at overlap begin
        startTime = toStart;
      } else if (fromEnd === toStart) {
        // Adjacent: center on junction
        startTime = fromEnd - durationSec / 2;
      } else {
        // Gap: start at from clip end
        startTime = fromEnd;
      }
    } else if (fromClip) {
      startTime = fromClip.start + fromClip.duration - durationSec;
    } else if (toClip) {
      startTime = toClip.start;
    }
    startTime = Math.max(0, startTime);

    addTransition(fromClipId, toClipId, transitionFileId, startTime, durationSec, params, undefined, activeTabId);
    saveProject();
  }, [addTransition, saveProject, clips, activeTabId, timelineTabs]);

  // Bridge: legacy AIPromptPanel calls old signature, we map to v2
  const handleApplyTransition = useCallback((
    fromClipId: string,
    toClipId: string,
    type: string,
    durationSec: number,
    customTransitionId?: string,
  ) => {
    // Map old type names to v2 transitionFileId
    const typeToFileId: Record<string, string> = {
      crossfade: 'builtin-crossfade',
      'slide-left': 'builtin-slide-left',
      'slide-right': 'builtin-slide-right',
      'dip-to-black': 'builtin-dip-to-black',
      custom: customTransitionId || 'builtin-crossfade',
    };
    const transitionFileId = typeToFileId[type] || customTransitionId || 'builtin-crossfade';
    handleApplyTransitionV2(fromClipId, toClipId, transitionFileId, durationSec);
  }, [handleApplyTransitionV2]);

  // Handle updating clip transform (scale, rotation, crop, etc.)
  const handleUpdateClipTransform = useCallback((clipId: string, transform: TimelineClip['transform']) => {
    updateClip(clipId, { transform });
    saveProject();
  }, [updateClip, saveProject]);

  // Get selected clip and its asset
  const selectedClip = useMemo(() =>
    clips.find(c => c.id === selectedClipId) || null,
    [clips, selectedClipId]
  );

  const selectedClipAsset = useMemo(() =>
    selectedClip ? assets.find(a => a.id === selectedClip.assetId) || null : null,
    [selectedClip, assets]
  );

  // Check if selected clip is a caption
  const selectedCaptionData = useMemo(() =>
    selectedClip && selectedClip.trackId === 'T1' ? getCaptionData(selectedClip.id) : null,
    [selectedClip, getCaptionData]
  );

  // Handle dragging overlay in video preview
  const handleLayerMove = useCallback((layerId: string, x: number, y: number) => {
    const clip = clips.find(c => c.id === layerId);
    if (!clip) return;

    const currentTransform = clip.transform || {};
    updateClip(layerId, {
      transform: { ...currentTransform, x, y }
    });
  }, [clips, updateClip]);

  // Handle selecting layer from video preview
  const handleLayerSelect = useCallback((layerId: string) => {
    setSelectedClipId(layerId);
    setPreviewAssetId(null);
  }, []);

  // Handle AI edit (using FFmpeg on video assets)
  const handleApplyEdit = useCallback(async (command: string) => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first');
    }

    // Find the video asset to edit - selected clip wins, else earliest timeline video
    const target = deriveTimelineVideoTarget(clips, assets, { selectedClipId });
    if (!target) {
      throw new Error('No video clip on the timeline. Please add a video to the timeline first.');
    }
    const targetAssetId = target.asset.id;

    console.log('Applying FFmpeg edit to asset:', targetAssetId);
    console.log('Command:', command);

    // Call the server to process the video with FFmpeg
    const response = await fetch(`${API_BASE}/session/${session.sessionId}/process-asset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: targetAssetId,
        command,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to apply edit');
    }

    const result = await response.json();
    console.log('Edit applied, new asset:', result.assetId);

    // Refresh assets to get the new processed asset
    await refreshAssets();

    // Optionally replace clips using the old asset with the new one
    if (result.assetId && result.assetId !== targetAssetId) {
      // Find clips using the old asset and update them to use the new one
      const clipsToUpdate = clips.filter(c => c.assetId === targetAssetId);
      for (const clip of clipsToUpdate) {
        updateClip(clip.id, { assetId: result.assetId });
      }
      await saveProject();
    }
  }, [session, assets, clips, selectedClipId, refreshAssets, updateClip, saveProject]);

  // Copy chapters to clipboard
  const handleCopyChapters = useCallback(() => {
    if (chapterData?.youtubeFormat) {
      navigator.clipboard.writeText(chapterData.youtubeFormat);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [chapterData]);

  // Generate chapters and make cuts at each chapter point
  const handleChapterCuts = useCallback(async (): Promise<{
    chapters: Array<{ start: number; title: string }>;
    cutsApplied: number;
    youtubeFormat: string;
  }> => {
    if (!session) {
      throw new Error('No session available');
    }

    // Derive the chapter source from the timeline (earliest video clip, any V track)
    const target = deriveTimelineVideoTarget(clips, assets, { preferNonAi: true });
    if (!target) {
      throw new Error('No video clip on the timeline. Please add a video to the timeline first.');
    }

    console.log('Generating chapters and making cuts...');

    // Generate chapters using the session API
    const response = await fetch(`${API_BASE}/session/${session.sessionId}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: target.asset.id }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate chapters');
    }

    // 202 { jobId } — poll until the chapters job settles
    const { jobId } = await response.json();
    const result = await pollJob(session.sessionId, jobId) as { chapters: Array<{ start: number; title: string }>; youtubeFormat: string; summary: string };
    const chapters: Array<{ start: number; title: string }> = result.chapters || [];

    if (chapters.length === 0) {
      throw new Error('No chapters were detected in the video');
    }

    console.log(`Generated ${chapters.length} chapters:`, chapters);

    // Store chapter data for the modal
    setChapterData(result);

    // Get chapter timestamps to cut at (skip first chapter at 0:00)
    const cutTimestamps = chapters
      .filter(ch => ch.start >= 0.5)
      .map(ch => ch.start)
      .sort((a, b) => a - b);

    console.log('Cut timestamps:', cutTimestamps);

    // Get current project state from server
    const projectResponse = await fetch(`${API_BASE}/session/${session.sessionId}/project`);
    const projectData = await projectResponse.json();
    const currentClips: TimelineClip[] = projectData.clips || [];

    // Process all cuts by directly manipulating the clips array
    // This avoids React state batching issues
    let cutsApplied = 0;

    for (const timestamp of cutTimestamps) {
      // Find clip that spans this timestamp on the target clip's track
      const clipIndex = currentClips.findIndex((clip: TimelineClip) =>
        clip.trackId === target.clip.trackId &&
        timestamp > clip.start &&
        timestamp < clip.start + clip.duration
      );

      if (clipIndex === -1) continue;

      const clip = currentClips[clipIndex];
      const timeInClip = timestamp - clip.start;

      // Skip if too close to edges
      if (timeInClip <= 0.05 || timeInClip >= clip.duration - 0.05) continue;

      const splitInPoint = clip.inPoint + timeInClip;

      // Create the second clip (after the split)
      const secondClip: TimelineClip = {
        id: crypto.randomUUID(),
        assetId: clip.assetId,
        trackId: clip.trackId,
        start: timestamp,
        duration: clip.duration - timeInClip,
        inPoint: splitInPoint,
        outPoint: clip.outPoint,
        transform: clip.transform ? { ...clip.transform } : undefined,
      };

      // Update the first clip (shorten it)
      currentClips[clipIndex] = {
        ...clip,
        duration: timeInClip,
        outPoint: splitInPoint,
      };

      // Add the second clip
      currentClips.push(secondClip);
      cutsApplied++;

      console.log(`Cut at ${timestamp}s: clip ${clip.id} -> new clip ${secondClip.id}`);
    }

    // Save the modified clips directly to server
    if (cutsApplied > 0) {
      await fetch(`${API_BASE}/session/${session.sessionId}/project`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...projectData, clips: currentClips }),
      });

      // Reload to sync local state
      await loadProject();
    }

    return {
      chapters,
      cutsApplied,
      youtubeFormat: result.youtubeFormat || '',
    };
  }, [session, clips, assets, loadProject]);

  // Handle auto-extract keywords and add GIFs
  const handleExtractKeywordsAndAddGifs = useCallback(async () => {
    if (!session) {
      throw new Error('No session available');
    }

    // Derive the transcription source from the timeline
    const target = deriveTimelineVideoTarget(clips, assets, { preferNonAi: true });
    if (!target) {
      throw new Error('No video clip on the timeline. Please add a video to the timeline first.');
    }

    // Call the transcribe-and-extract endpoint
    const response = await fetch(`${API_BASE}/session/${session.sessionId}/transcribe-and-extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: target.asset.id }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to extract keywords');
    }

    // 202 { jobId } — poll until the transcribe-and-extract job settles
    const { jobId } = await response.json();
    const data = await pollJob(session.sessionId, jobId) as { gifAssets: { assetId: string; timestamp: number }[] };
    console.log('Transcription result:', data);

    // Add each GIF to the timeline at its timestamp on the V2 (overlay) track
    for (const gifInfo of data.gifAssets) {
      // Add clip to V2 track at the keyword's timestamp
      addClip(gifInfo.assetId, 'V2', gifInfo.timestamp, 3); // 3 second duration for GIFs
    }

    // Save the project with the new clips
    await saveProject();
  }, [session, clips, assets, addClip, saveProject]);

  // Handle generating B-roll images and adding to timeline
  const handleGenerateBroll = useCallback(async () => {
    if (!session) {
      throw new Error('No session available');
    }

    // Derive the transcription source from the timeline
    const target = deriveTimelineVideoTarget(clips, assets, { preferNonAi: true });
    if (!target) {
      throw new Error('No video clip on the timeline. Please add a video to the timeline first.');
    }

    // Call the generate-broll endpoint
    const response = await fetch(`${API_BASE}/session/${session.sessionId}/generate-broll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: target.asset.id }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate B-roll');
    }

    // 202 { jobId } — poll until the b-roll job settles
    const { jobId } = await response.json();
    const data = await pollJob(session.sessionId, jobId) as { brollAssets: Array<{ assetId: string; keyword: string; timestamp: number }> };
    console.log('B-roll generation result:', data);
    console.log('B-roll assets to add:', data.brollAssets);

    if (!data.brollAssets || data.brollAssets.length === 0) {
      console.warn('No B-roll assets returned from server');
      throw new Error('No B-roll images were generated. The AI image generation may have failed - check the server logs for details.');
    }

    // Refresh assets from server to get the newly generated B-roll images
    console.log('Refreshing assets from server...');
    await refreshAssets();

    // Default B-roll transform: 1/5 screen width, lower-middle position
    // With new rendering: scale = width percentage, x = horizontal offset, y = vertical offset (positive = up)
    const DEFAULT_BROLL_TRANSFORM = {
      scale: 0.2,   // 1/5th of screen width (20%)
      x: 0,         // Centered horizontally
      y: 0,         // No vertical offset (stays at bottom 10% default position)
    };

    // Create clips directly (bypassing addClip to avoid stale closure issue)
    const newClips: TimelineClip[] = data.brollAssets.map((brollInfo: { assetId: string; keyword: string; timestamp: number }) => ({
      id: crypto.randomUUID(),
      assetId: brollInfo.assetId,
      trackId: 'V3',
      start: brollInfo.timestamp,
      duration: 3,
      inPoint: 0,
      outPoint: 3,
      transform: DEFAULT_BROLL_TRANSFORM,
    }));

    console.log(`Created ${newClips.length} B-roll clips:`, newClips);

    // Add clips to state using the setter directly via a custom approach
    // We need to update clips state - let's use updateClip for each after adding via addClip workaround
    // Actually, let's just save directly to server and reload

    // Save clips directly to server
    const projectResponse = await fetch(`${API_BASE}/session/${session.sessionId}/project`);
    const projectData = await projectResponse.json();

    const updatedClips = [...(projectData.clips || []), ...newClips];

    await fetch(`${API_BASE}/session/${session.sessionId}/project`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...projectData,
        clips: updatedClips,
      }),
    });

    // Reload project to sync frontend state
    await loadProject();

    console.log('B-roll clips added successfully!');
  }, [session, clips, assets, refreshAssets, loadProject]);

  // Handle removing dead air / silence from the video
  const handleRemoveDeadAir = useCallback(async (): Promise<{ duration: number; removedDuration: number }> => {
    if (!session) {
      throw new Error('No session available');
    }

    // Derive the target from the timeline (prefer original, non-AI-generated)
    const target = deriveTimelineVideoTarget(clips, assets, { preferNonAi: true });
    if (!target) {
      throw new Error('No video clip on the timeline. Please add a video to the timeline first.');
    }

    console.log('Removing dead air from video...');

    // Call the remove-dead-air endpoint
    // -26dB catches real pauses, 0.4s avoids cutting natural speech rhythm
    const response = await fetch(`${API_BASE}/session/${session.sessionId}/remove-dead-air`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: target.asset.id,
        silenceThreshold: -26, // dB threshold
        minSilenceDuration: 0.4, // minimum silence duration in seconds
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to remove dead air');
    }

    // 202 { jobId } — poll until the dead-air job settles
    const { jobId } = await response.json();
    const result = await pollJob(session.sessionId, jobId) as { duration: number; removedDuration: number };
    console.log('Dead air removal result:', result);

    // Refresh assets to get the updated video with new cache-busting URL
    await refreshAssets();

    // Update the targeted clip's duration (the asset was replaced in-place, same id)
    if (result.duration) {
      console.log(`[DeadAir] Updating clip ${target.clip.id}: duration ${target.clip.duration} -> ${result.duration}`);
      updateClip(target.clip.id, {
        duration: result.duration,
        outPoint: result.duration,
      });
      await saveProject();
    }

    return {
      duration: result.duration,
      removedDuration: result.removedDuration,
    };
  }, [session, assets, clips, refreshAssets, updateClip, saveProject]);

  // Caption generation lives in its own hook — one concern, one file
  const { transcribeAndAddCaptions: handleTranscribeAndAddCaptions } = useCaptionGeneration({
    session,
    assets,
    clips,
    clipsRef,
    getCaptionData,
    addCaptionClipsBatch,
    deleteCaptionClips,
    saveProject,
  });

  // Handle updating caption style
  const handleUpdateCaptionStyle = useCallback((clipId: string, styleUpdates: Partial<CaptionStyle>) => {
    updateCaptionStyle(clipId, styleUpdates);
    saveProject();
  }, [updateCaptionStyle, saveProject]);

  // Wrapper for AI prompt panel motion graphics (takes config object)
  const handleAddMotionGraphicFromPrompt = useCallback(async (config: {
    templateId: TemplateId;
    props: Record<string, unknown>;
    duration: number;
    startTime?: number;
  }) => {
    // Use startTime from config, or fall back to currentTime
    const startAt = config.startTime ?? currentTime;

    if (!session) {
      alert('Please upload a video first to start a session');
      return;
    }

    try {
      // Persist settings first — the server resolves fps/width/height from the saved project
      await saveProjectImmediate();

      // Call the server to render the motion graphic
      const response = await fetch(`${API_BASE}/session/${session.sessionId}/render-motion-graphic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: config.templateId,
          props: config.props,
          duration: config.duration,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to render motion graphic');
      }

      // 202 { jobId } — poll until the render job settles
      const { jobId } = await response.json();
      const data = await pollJob(session.sessionId, jobId) as { assetId: string };

      // Refresh assets to sync with server (motion graphic was just created)
      await refreshAssets();

      // Add the rendered motion graphic to the timeline at specified position
      addClip(data.assetId, 'V2', startAt, config.duration);

      // Switch to Main tab so user can see the added animation
      switchTimelineTab('main');

      await saveProject();

      console.log('Motion graphic added from prompt:', data);
    } catch (error) {
      console.error('Failed to add motion graphic:', error);
      throw error; // Re-throw so AIPromptPanel can show error
    }
  }, [session, currentTime, addClip, saveProject, saveProjectImmediate, refreshAssets, switchTimelineTab]);

  // Handle custom AI-generated animation creation
  const handleCreateCustomAnimation = useCallback(async (description: string, startTime?: number, endTime?: number, attachedAssetIds?: string[], durationSeconds?: number) => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    try {
      // Context video derived from the timeline (earliest video clip, any V track).
      // Animations can generate without context, so no timeline video is allowed.
      const target = deriveTimelineVideoTarget(clips, assets, { preferNonAi: true });
      const videoAssetId: string | undefined = target?.asset.id;

      console.log(`[Animation] Creating with video context: ${videoAssetId || 'none'}, time range: ${startTime !== undefined ? `${startTime}s` : 'auto'}${endTime !== undefined ? ` - ${endTime}s` : ''}${attachedAssetIds?.length ? `, attached assets: ${attachedAssetIds.length}` : ''}${durationSeconds ? `, duration: ${durationSeconds}s` : ''}`);

      // Persist settings first — the server resolves fps/width/height from the saved project
      await saveProjectImmediate();

      // Call the server to generate AI animation with video context
      const response = await fetch(`${API_BASE}/session/${session.sessionId}/generate-animation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description,
          videoAssetId, // Pass video for transcript context
          startTime,    // Optional: specific time range
          endTime,      // Optional: specific time range
          attachedAssetIds, // Optional: images/videos to include in animation
          durationSeconds, // Optional: user-specified duration
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to generate animation');
      }

      setStatus('Generating animation...');
      // 202 { jobId } — LLM authoring then render runs as a job; poll it
      const { jobId } = await response.json();
      const data = await pollJob(session.sessionId, jobId, {
        onUpdate: (job) => {
          if (job.state === 'running' && job.progress) {
            const { pct, frames, total, elapsed } = job.progress as { pct: number; frames: number; total: number; elapsed: string };
            setStatus(`Rendering animation: ${pct}% (${frames}/${total} frames) [${elapsed}]`);
          }
        },
      }) as { assetId: string; duration: number; sceneCount?: number };
      setStatus('');

      // Refresh assets to sync with server (animation was just created)
      await refreshAssets();

      const animationDuration = data.duration;

      // If startTime is provided (from time selection tool), use that
      // Otherwise, detect animation type from description for placement
      let insertTime: number;
      if (startTime !== undefined) {
        insertTime = startTime;
        console.log(`Animation added at specified time: ${startTime}s`);
      } else {
        // Detect animation type from description for auto-placement
        const lower = description.toLowerCase();
        const isIntro = lower.includes('intro') || lower.includes('opening') || lower.includes('start');
        const isOutro = lower.includes('outro') || lower.includes('ending') || lower.includes('conclusion') || lower.includes('close');
        const videoDuration = getDuration();

        if (isIntro) {
          insertTime = 0;
          console.log('Intro animation added as overlay at beginning');
        } else if (isOutro) {
          insertTime = videoDuration;
          console.log('Outro animation added as overlay at end');
        } else {
          insertTime = currentTime;
          console.log('Animation added as overlay at playhead position');
        }
      }

      // Always add animations as overlays on V2
      addClip(data.assetId, 'V2', insertTime, animationDuration);

      // Switch to Main tab so user can see the added animation
      switchTimelineTab('main');

      await saveProject();

      console.log('Custom animation generated:', data, { insertTime });

      return {
        assetId: data.assetId,
        duration: data.duration,
      };
    } catch (error) {
      console.error('Failed to create custom animation:', error);
      throw error;
    }
  }, [session, currentTime, addClip, saveProject, saveProjectImmediate, refreshAssets, getDuration, switchTimelineTab, clips, assets, setStatus]);

  // Handle analyzing video for animation (returns concept for approval)
  const handleAnalyzeForAnimation = useCallback(async (request: {
    type: 'intro' | 'outro' | 'transition' | 'highlight';
    description?: string;
    timeRange?: { start: number; end: number };
  }) => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    const target = deriveTimelineVideoTarget(clips, assets, { preferNonAi: true });
    if (!target) {
      throw new Error('No video clip on the timeline. Please add a video to the timeline first.');
    }

    // Debug: log the time range being sent to server
    console.log('[DEBUG] Sending analyze-for-animation with timeRange:', JSON.stringify(request.timeRange));

    // Persist settings first — the server authors scene frame counts at the project fps
    await saveProjectImmediate();

    const response = await fetch(`${API_BASE}/session/${session.sessionId}/analyze-for-animation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: target.asset.id,
        type: request.type,
        description: request.description,
        // Pass time range so server only analyzes that segment
        startTime: request.timeRange?.start,
        endTime: request.timeRange?.end,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to analyze video');
    }

    // 202 { jobId } — poll until the analysis job settles
    const { jobId } = await response.json();
    return await pollJob(session.sessionId, jobId) as { concept: AnimationConcept };
  }, [session, clips, assets, saveProjectImmediate]);

  // Handle rendering from pre-approved concept (skips analysis, uses provided scenes)
  const handleRenderFromConcept = useCallback(async (concept: {
    type: 'intro' | 'outro' | 'transition' | 'highlight';
    fps?: number; // fps the scene frame counts were authored at (render honors it)
    scenes: Array<{
      id: string;
      type: string;
      duration: number;
      content: Record<string, unknown>;
    }>;
    totalDuration: number;
    durationInSeconds: number;
    backgroundColor: string;
    contentSummary: string;
    startTime?: number; // Optional: explicit placement time
  }) => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    // Persist settings first — the server resolves width/height from the saved project
    // (fps comes from the concept, which embeds the fps its scenes were authored at)
    await saveProjectImmediate();

    const response = await fetch(`${API_BASE}/session/${session.sessionId}/render-from-concept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        concept,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to render animation');
    }

    // 202 { jobId } — poll until the render job settles
    const { jobId } = await response.json();
    const data = await pollJob(session.sessionId, jobId) as { assetId: string; duration: number };

    // Refresh assets to get the newly rendered animation
    await refreshAssets();

    const animationDuration = data.duration;
    const videoDuration = getDuration();

    // Determine placement: use explicit startTime if provided, otherwise use type-based logic
    let insertTime: number;
    if (concept.startTime !== undefined) {
      // Explicit time provided (from time selection tool)
      insertTime = concept.startTime;
      console.log(`Animation placed at specified time: ${insertTime}s`);
    } else if (concept.type === 'intro') {
      insertTime = 0;
      console.log('Intro animation added at beginning');
    } else if (concept.type === 'outro') {
      insertTime = videoDuration;
      console.log('Outro animation added at end');
    } else {
      insertTime = currentTime;
      console.log('Animation added at current playhead');
    }

    // Always add as overlay on V2 - never shift the original video
    addClip(data.assetId, 'V2', insertTime, animationDuration);

    // Switch to Main tab so user can see the animation
    switchTimelineTab('main');

    await saveProject();

    console.log('Animation rendered from concept:', data, { type: concept.type, insertTime });

    return {
      assetId: data.assetId,
      duration: data.duration,
    };
  }, [session, currentTime, refreshAssets, addClip, saveProject, saveProjectImmediate, getDuration, switchTimelineTab]);

  // Handle generating transcript animation (kinetic typography from speech)
  const handleGenerateTranscriptAnimation = useCallback(async () => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    // Persist settings first — the server resolves fps/width/height from the saved project
    await saveProjectImmediate();

    const response = await fetch(`${API_BASE}/session/${session.sessionId}/generate-transcript-animation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate transcript animation');
    }

    // 202 { jobId } — poll until the transcript-animation job settles
    const { jobId } = await response.json();
    const data = await pollJob(session.sessionId, jobId) as { assetId: string; duration: number };

    // Refresh assets to get the newly generated animation
    await refreshAssets();

    // Add the animation as an overlay on V2 at the current playhead
    addClip(data.assetId, 'V2', currentTime, data.duration);

    await saveProject();

    console.log('Transcript animation generated:', data);

    return {
      assetId: data.assetId,
      duration: data.duration,
    };
  }, [session, currentTime, refreshAssets, addClip, saveProject, saveProjectImmediate]);

  // Handle batch animation generation (multiple animations across the video)
  const handleGenerateBatchAnimations = useCallback(async (count: number) => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    // Derive the transcription source from the timeline
    const target = deriveTimelineVideoTarget(clips, assets, { preferNonAi: true });
    if (!target) {
      throw new Error('No video clip on the timeline. Please add a video to the timeline first.');
    }

    // Persist settings first — the server resolves fps/width/height from the saved project
    await saveProjectImmediate();

    const response = await fetch(`${API_BASE}/session/${session.sessionId}/generate-batch-animations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: target.asset.id,
        count,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to generate batch animations');
    }

    // 202 { jobId } — poll until the batch job settles
    const { jobId } = await response.json();
    const data = await pollJob(session.sessionId, jobId) as { animations: Array<{ assetId: string; filename: string; duration: number; startTime: number; type: 'intro' | 'highlight' | 'transition' | 'callout' | 'outro'; title: string }>; videoDuration: number };

    // Refresh assets to get the newly generated animations
    await refreshAssets();

    // Add each animation to the timeline at its planned position
    for (const animation of data.animations) {
      addClip(animation.assetId, 'V2', animation.startTime, animation.duration);
    }

    await saveProject();

    console.log('Batch animations generated:', data);

    return {
      animations: data.animations,
      videoDuration: data.videoDuration,
    };
  }, [session, clips, assets, refreshAssets, addClip, saveProject, saveProjectImmediate]);

  // Handle extract audio (separates audio to A1 track, replaces video with muted version)
  const handleExtractAudio = useCallback(async () => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    // Derive the video to split from the timeline (selected clip wins)
    const target = deriveTimelineVideoTarget(clips, assets, { selectedClipId });
    if (!target) {
      throw new Error('No video clip on the timeline. Please add a video to the timeline first.');
    }

    const response = await fetch(`${API_BASE}/session/${session.sessionId}/extract-audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId: target.asset.id,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to extract audio');
    }

    const data = await response.json();

    // Refresh assets to get the new audio and muted video assets
    await refreshAssets();

    // Update V1 clip to use the muted video
    updateClip(target.clip.id, { assetId: data.mutedVideoAsset.id });

    // Add the audio to A1 track at the same position as the video
    addClip(data.audioAsset.id, 'A1', target.clip.start, data.audioAsset.duration);

    await saveProject();

    console.log('Audio extracted:', data);

    return {
      audioAsset: data.audioAsset,
      mutedVideoAsset: data.mutedVideoAsset,
      originalAssetId: data.originalAssetId,
    };
  }, [session, clips, assets, selectedClipId, refreshAssets, updateClip, addClip, saveProject]);

  const handleAudioSync = useCallback(async (params: { assetA: string; assetB: string; sampleRate: number; correlationSampleSize: number; initialGranularity: number; analysisRegion?: string; analysisDuration?: number }) => {
    if (!session?.sessionId) throw new Error('No active session');
    const response = await fetch(`${API_BASE}/session/${session.sessionId}/audio-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      const err = await response.json() as { error?: string };
      throw new Error(err.error || 'Audio sync failed');
    }
    // 202 { jobId } — poll until the audio-sync job settles
    const { jobId } = await response.json();
    return await pollJob(session.sessionId, jobId) as { offsetSeconds: number; correlation: number; confidence: 'high' | 'medium' | 'low'; note?: string };
  }, [session]);

  const handleApplyAudioSync = useCallback((result: { analyzedClipIds: [string, string]; analyzedTabId: string; anchorClipId: string; nonAnchorClipId: string; nonAnchorIsAssetB: boolean; anchorInPoint: number; nonAnchorInPoint: number; offsetSeconds: number }) => {
    const { analyzedTabId, anchorClipId, nonAnchorClipId, nonAnchorIsAssetB, anchorInPoint, nonAnchorInPoint, offsetSeconds } = result;

    const allClips = analyzedTabId !== 'main'
      ? (timelineTabs.find(t => t.id === analyzedTabId)?.clips || [])
      : clips;

    const anchorClip = allClips.find(c => c.id === anchorClipId);
    if (!anchorClip) return;

    const assetOffset = nonAnchorIsAssetB ? offsetSeconds : -offsetSeconds;
    const rawStart = anchorClip.start + assetOffset - anchorInPoint + nonAnchorInPoint;

    console.log('[AudioSync Apply]', { anchorClipId, nonAnchorClipId, nonAnchorIsAssetB, offsetSeconds, assetOffset, rawStart, anchorStart: anchorClip.start, anchorInPoint, nonAnchorInPoint, analyzedTabId });

    if (analyzedTabId !== 'main') {
      const tab = timelineTabs.find(t => t.id === analyzedTabId);
      if (tab) {
        if (rawStart < 0) {
          const shift = -rawStart;
          updateTabClips(analyzedTabId, tab.clips.map(c => {
            if (c.id === anchorClipId) return { ...c, start: c.start + shift };
            if (c.id === nonAnchorClipId) return { ...c, start: 0 };
            return c;
          }));
        } else {
          updateTabClips(analyzedTabId, tab.clips.map(c =>
            c.id === nonAnchorClipId ? { ...c, start: rawStart } : c
          ));
        }
      }
    } else {
      if (rawStart < 0) {
        const shift = -rawStart;
        updateClip(anchorClipId, { start: anchorClip.start + shift });
        updateClip(nonAnchorClipId, { start: 0 });
      } else {
        updateClip(nonAnchorClipId, { start: rawStart });
      }
    }
  }, [clips, timelineTabs, updateClip, updateTabClips]);

  // Handle contextual animation creation (uses video content to inform the animation)
  const handleCreateContextualAnimation = useCallback(async (request: {
    type: 'intro' | 'outro' | 'transition' | 'highlight';
    description?: string;
  }) => {
    if (!session?.sessionId) {
      throw new Error('Please upload a video first to start a session');
    }

    // Derive the video to analyze from the timeline
    const target = deriveTimelineVideoTarget(clips, assets, { preferNonAi: true });
    if (!target) {
      throw new Error('No video clip on the timeline. Please add a video to the timeline first.');
    }

    try {
      // Call the server to generate contextual animation
      // This endpoint will:
      // 1. Transcribe the video (if not already done)
      // 2. Analyze the content with AI
      // 3. Generate Remotion code based on the content
      // 4. Render the animation
      // Persist settings first — the server resolves fps/width/height from the saved project
      await saveProjectImmediate();

      const response = await fetch(`${API_BASE}/session/${session.sessionId}/generate-contextual-animation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId: target.asset.id,
          type: request.type,
          description: request.description,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to generate animation');
      }

      // 202 { jobId } — poll until the contextual-animation job settles
      const { jobId } = await response.json();
      const data = await pollJob(session.sessionId, jobId) as { assetId: string; duration: number; contentSummary?: string; sceneCount?: number };

      // Refresh assets to get the newly generated animation
      await refreshAssets();

      // Add the generated animation to the timeline
      // Intro goes at the beginning, outro at the end
      const insertTime = request.type === 'outro' ? getDuration() : 0;
      addClip(data.assetId, 'V2', insertTime, data.duration);
      await saveProject();

      console.log('Contextual animation generated:', data);

      return {
        assetId: data.assetId,
        duration: data.duration,
        contentSummary: data.contentSummary,
        sceneCount: data.sceneCount,
      };
    } catch (error) {
      console.error('Failed to create contextual animation:', error);
      throw error;
    }
  }, [session, clips, assets, addClip, saveProject, saveProjectImmediate, getDuration, refreshAssets]);

  // Handle render/export
  const handleExport = useCallback(async (exportOpts?: RenderOptions) => {
    if (clips.length === 0) {
      alert('Add some clips to the timeline first');
      return;
    }

    try {
      const downloadUrl = await renderProject(false, exportOpts);
      // Derive file extension from container format
      const ext = exportOpts?.containerFormat ? `.${exportOpts.containerFormat}` : '.mp4';
      // Trigger download
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `export${ext}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setShowRenderSettings(false);
    } catch (error) {
      console.error('Export failed:', error);
      alert(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [clips.length, renderProject]);

  // Edit an existing animation with a new prompt
  const handleEditAnimation = useCallback(async (
    assetId: string,
    editPrompt: string,
    v1Context?: { assetId: string; filename: string; type: string; duration?: number },
    tabIdToUpdate?: string
  ) => {
    if (!session?.sessionId) {
      throw new Error('No active session');
    }

    // Get available assets to pass to the AI
    const availableAssets = assets
      .filter(a => a.type === 'image' || a.type === 'video')
      .map(a => ({
        id: a.id,
        type: a.type,
        filename: a.filename,
        duration: a.duration,
      }));

    const response = await fetch(`${API_BASE}/session/${session.sessionId}/edit-animation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assetId,
        editPrompt,
        assets: availableAssets,
        v1Context, // Pass V1 clip context for hybrid approach
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to edit animation');
    }

    setStatus('Editing animation...');
    // 202 { jobId } — LLM edit then re-render runs as a job; poll it
    const { jobId } = await response.json();
    const data = await pollJob(session.sessionId, jobId, {
      onUpdate: (job) => {
        if (job.state === 'running' && job.progress) {
          const { pct, frames, total, elapsed } = job.progress as { pct: number; frames: number; total: number; elapsed: string };
          setStatus(`Rendering animation: ${pct}% (${frames}/${total} frames) [${elapsed}]`);
        }
      },
    }) as { assetId: string; duration: number; sceneCount: number; editCount: number };
    setStatus('');

    console.log('[handleEditAnimation] ===== STEP 1: Server response =====');
    console.log('[handleEditAnimation] Server response:', {
      assetId: data.assetId,
      originalAssetId: assetId,
      isSameAsset: data.assetId === assetId,
      duration: data.duration,
      editCount: data.editCount,
    });

    console.log('[handleEditAnimation] ===== STEP 2: About to call refreshAssets =====');
    console.log('[handleEditAnimation] Tab to update:', tabIdToUpdate);

    // Refresh assets to sync with server (same asset ID, but updated duration/thumbnail)
    await refreshAssets();

    console.log('[handleEditAnimation] ===== STEP 3: refreshAssets complete =====');

    // Update the edit tab's clip duration if it changed (asset ID stays the same)
    if (tabIdToUpdate && tabIdToUpdate !== 'main' && data.duration) {
      console.log('[handleEditAnimation] ===== STEP 4: Updating edit tab =====');
      console.log('[handleEditAnimation] Updating edit tab clip duration:', {
        tabId: tabIdToUpdate,
        assetId: data.assetId,
        duration: data.duration,
      });
      // Update the V1 clip's duration to match the new animation duration
      updateTabAsset(tabIdToUpdate, data.assetId, data.duration);
    }

    console.log('[handleEditAnimation] ===== STEP 5: Complete =====');

    return {
      assetId: data.assetId,
      duration: data.duration,
      sceneCount: data.sceneCount,
      editCount: data.editCount,
    };
  }, [session, assets, refreshAssets, updateTabAsset, setStatus]);

  // Open an animation in a new timeline tab for isolated editing
  const handleOpenAnimationInTab = useCallback((assetId: string, animationName: string) => {
    const asset = assets.find(a => a.id === assetId);
    if (!asset) return;

    // Create initial clip for the tab's timeline
    const initialClip: TimelineClip = {
      id: crypto.randomUUID(),
      assetId: assetId,
      trackId: 'V1',
      start: 0,
      duration: asset.duration || 10,
      inPoint: 0,
      outPoint: asset.duration || 10,
    };

    const tabId = createTimelineTab(animationName, assetId, [initialClip]);
    console.log('Created timeline tab for animation:', tabId, animationName);

    return tabId;
  }, [assets, createTimelineTab]);

  const isProcessing = loading;
  const currentStatus = status;

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-white overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 bg-zinc-900/50 border-b border-zinc-800/50 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gradient-to-br from-orange-500 to-amber-500 rounded-lg flex items-center justify-center">
              <Sparkles className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-orange-400 to-amber-400 bg-clip-text text-transparent">
              HyperEdit
            </h1>
          </div>
          <SessionManager
            currentSession={session}
            saveProjectImmediate={saveProjectImmediate}
            setSession={setSession}
            resetProjectState={resetProjectState}
            resetLocalState={resetLocalState}
          />
          {currentStatus && (
            <span className="text-xs text-zinc-400 bg-zinc-800 px-2 py-1 rounded">
              {currentStatus}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {session && (
            <>
              {clips.length > 0 && (
                <button
                  onClick={() => {
                    setShowRenderSettings(true);
                    fetch(`${API_BASE}/hwaccel-info`)
                      .then(r => r.json())
                      .then(info => {
                        if (info?.effective?.concurrency) setRecommendedConcurrency(info.effective.concurrency);
                      })
                      .catch(() => {});
                  }}
                  disabled={isProcessing}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                >
                  <Download className="w-4 h-4" />
                  Export
                </button>
              )}
            </>
          )}
          <button className="px-4 py-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 rounded-lg text-sm font-medium transition-all">
            AI Edit
          </button>
        </div>
      </header>

      {/* Timeline Tabs */}
      <TimelineTabs
        tabs={timelineTabs}
        activeTabId={activeTabId}
        onSwitchTab={switchTimelineTab}
        onCloseTab={closeTimelineTab}
        onAddTab={() => {
          // Count existing "Edit Tab" tabs to generate the next number
          const editTabCount = timelineTabs.filter(t => t.name.startsWith('Edit Tab')).length;
          const tabName = editTabCount === 0 ? 'Edit Tab' : `Edit Tab ${editTabCount + 1}`;
          createTimelineTab(tabName, `edit-${Date.now()}`, []); // Empty clips array for brand new tab
        }}
        show={assets.some(a => a.type === 'video')}
      />

      {/* Chapters Modal */}
      {showChapters && chapterData && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-900 rounded-xl border border-zinc-700 max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-zinc-700">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <ListOrdered className="w-5 h-5 text-orange-400" />
                YouTube Chapters
              </h2>
              <button
                onClick={() => setShowChapters(false)}
                className="p-1 hover:bg-zinc-700 rounded transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 overflow-y-auto flex-1">
              {chapterData.summary && (
                <p className="text-sm text-zinc-400 mb-4">{chapterData.summary}</p>
              )}

              <div className="bg-zinc-800 rounded-lg p-4 font-mono text-sm">
                <pre className="whitespace-pre-wrap text-zinc-200">{chapterData.youtubeFormat}</pre>
              </div>

              <div className="mt-4 space-y-2">
                {chapterData.chapters.map((ch, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      videoPreviewRef.current?.seekTo(ch.start);
                      setCurrentTime(ch.start);
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg bg-zinc-800/50 hover:bg-zinc-700/50 transition-colors flex items-center justify-between"
                  >
                    <span className="text-zinc-200">{ch.title}</span>
                    <span className="text-zinc-500 text-sm">
                      {Math.floor(ch.start / 60)}:{Math.floor(ch.start % 60).toString().padStart(2, '0')}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4 border-t border-zinc-700 flex gap-2">
              <button
                onClick={handleCopyChapters}
                className="flex-1 px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
              >
                {copied ? (
                  <>
                    <Check className="w-4 h-4" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    Copy for YouTube
                  </>
                )}
              </button>
              <button
                onClick={() => setShowChapters(false)}
                className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm font-medium transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Render Settings Modal */}
      {showRenderSettings && (
        <RenderSettingsModal
          renderOptions={renderOptions}
          projectSettings={settings}
          onClose={() => setShowRenderSettings(false)}
          onExport={(opts) => handleExport(opts)}
          onUpdateOptions={(opts) => {
            setRenderOptions(opts);
            saveProject();
          }}
          isExporting={loading}
          recommendedConcurrency={recommendedConcurrency}
          sessionId={session?.sessionId ?? ''}
        />
      )}

      <div className="flex flex-1 min-h-0">
        {/* Left Panel - Assets & Clip Properties */}
        <ResizablePanel
          defaultWidth={220}
          minWidth={180}
          maxWidth={400}
          side="left"
        >
          <div className="flex flex-col h-full">
            {/* Asset Library */}
            <div className={`${selectedClipId ? 'h-1/2' : 'h-full'} overflow-hidden`}>
              <AssetLibrary
                assets={assets}
                onUpload={handleAssetUpload}
                onDelete={deleteAsset}
                onDragStart={handleAssetDragStart}
                onSelect={handleAssetSelect}
                selectedAssetId={selectedAssetId}
                uploading={loading}
                onOpenGifSearch={() => setShowGifSearch(true)}
              />
            </div>

            {/* Clip/Caption Properties Panel (shown when clip is selected) */}
            {selectedClipId && !selectedTransitionId && (
              <div className="h-1/2 border-t border-zinc-800/50 bg-zinc-900/50 overflow-hidden">
                {selectedCaptionData ? (
                  <CaptionPropertiesPanel
                    captionData={selectedCaptionData}
                    onUpdateStyle={(styleUpdates) => handleUpdateCaptionStyle(selectedClipId, styleUpdates)}
                    onUpdateWords={(words) => {
                      updateCaptionWords(selectedClipId, words);
                      saveProject();
                    }}
                    onClose={() => setSelectedClipId(null)}
                  />
                ) : (
                  <ClipPropertiesPanel
                    clip={selectedClip}
                    asset={selectedClipAsset}
                    onUpdateTransform={handleUpdateClipTransform}
                    onClose={() => setSelectedClipId(null)}
                  />
                )}
              </div>
            )}

            {/* Transition Properties Panel (shown when transition is selected) */}
            {selectedTransitionId && (() => {
              const activeTransitions = activeTabId === 'main' ? timelineTransitions : (timelineTabs.find(t => t.id === activeTabId)?.timelineTransitions || []);
              const selectedTransition = activeTransitions.find(t => t.id === selectedTransitionId);
              if (!selectedTransition) return null;
              return (
                <div className="h-1/2 border-t border-zinc-800/50 bg-zinc-900/50 overflow-hidden overflow-y-auto">
                  <TransitionPropertiesPanel
                    transition={selectedTransition}
                    clips={activeClips}
                    onUpdate={(id, updates) => {
                      updateTransition(id, updates, activeTabId);
                      saveProject();
                    }}
                    onRemove={(id) => {
                      removeTransition(id, activeTabId);
                      setSelectedTransitionId(null);
                      saveProject();
                    }}
                    onClose={() => setSelectedTransitionId(null)}
                  />
                </div>
              );
            })()}

            {/* Track Properties Panel (shown when track label is clicked, no clip/transition selected) */}
            {selectedTrackId && !selectedClipId && !selectedTransitionId && (
              <div className="h-1/2 border-t border-zinc-800/50 bg-zinc-900/50 overflow-hidden">
                <TrackPropertiesPanel
                  trackId={selectedTrackId}
                  trackName={tracks.find(t => t.id === selectedTrackId)?.name ?? selectedTrackId}
                  autoSnap={trackAutoSnap[selectedTrackId] ?? false}
                  onToggleAutoSnap={(enabled) => setTrackAutoSnap(prev => ({ ...prev, [selectedTrackId]: enabled }))}
                  captionSplitMode={settings.captionSplitMode ?? 'both'}
                  onChangeCaptionSplitMode={(mode) => {
                    setSettings(prev => ({ ...prev, captionSplitMode: mode }));
                    saveProject();
                  }}
                  onClose={() => setSelectedTrackId(null)}
                />
              </div>
            )}
          </div>
        </ResizablePanel>

        {/* Main Editor Area */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          {/* Video Preview */}
          <div className="flex-1 flex items-center justify-center bg-zinc-900/30 p-4 min-h-0 overflow-hidden">
            {hasPreviewContent ? (
              <VideoPreview
                ref={videoPreviewRef}
                layers={previewLayers}
                isPlaying={isPlaying && !previewAssetId}
                aspectRatio={aspectRatio}
                onLayerMove={handleLayerMove}
                onLayerSelect={handleLayerSelect}
                selectedLayerId={selectedClipId}
                activeTransitions={previewActiveTransitions}
                currentTime={currentTime}
                currentTimeRef={currentTimeRef}
                onV1Seeked={handleV1Seeked}
              />
            ) : clips.length > 0 ? (
              // Assets exist but playhead is not over any clip
              <div className={`relative ${aspectRatio === '9:16' ? 'h-[65vh] w-auto aspect-[9/16]' : 'w-full max-w-4xl aspect-video'} bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10 flex items-center justify-center`}>
                <div className="text-center text-zinc-600">
                  <div className="text-sm">No clip at playhead</div>
                  <div className="text-xs mt-1">Move playhead over a clip to preview</div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center text-zinc-500">
                <Play className="w-16 h-16 mb-4 opacity-50" />
                <p className="text-sm">Upload assets from the left panel</p>
                <p className="text-xs text-zinc-600 mt-1">Drag them to the timeline below</p>
              </div>
            )}
          </div>

          {/* Timeline - Resizable height */}
          <ResizableVerticalPanel
            defaultHeight={224}
            minHeight={150}
            maxHeight={500}
            position="bottom"
            className="bg-zinc-900/50 border-t border-zinc-800/50 overflow-hidden"
          >
            <Timeline
              tracks={tracks}
              clips={activeClips}
              assets={assets}
              selectedClipId={selectedClipId}
              selectedClipIds={selectedClipIds}
              currentTime={currentTime}
              currentTimeRef={currentTimeRef}
              duration={duration}
              isPlaying={isPlaying}
              aspectRatio={aspectRatio}
              onSelectClip={handleSelectClip}
              onTimeChange={handleTimelineSeek}
              onPlayPause={handlePlayPause}
              onStop={handleStop}
              onMoveClip={handleMoveClip}
              onResizeClip={handleResizeClip}
              onDeleteClip={handleDeleteClip}
              onCutAtPlayhead={handleCutAtPlayhead}
              onAddText={handleAddText}
              onToggleAspectRatio={handleToggleAspectRatio}
              onTrackLabelClick={(trackId: string) => {
                setSelectedTrackId(trackId);
                setSelectedClipId(null);
                setSelectedTransitionId(null);
              }}
              onDropAsset={handleDropAsset}
              onSave={saveProject}
              getCaptionData={getCaptionData}
              transitions={activeTabId === 'main' ? transitions : []}
              onAddTransition={addLegacyTransition}
              onUpdateTransition={(id, updates) => {
                // Legacy v1 update - keep Timeline working until Phase 5
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                setTransitions((prev: any[]) => prev.map((t: any) => t.id === id ? { ...t, ...updates } : t));
              }}
              onRemoveTransition={(id) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                setTransitions((prev: any[]) => prev.filter((t: any) => t.id !== id));
              }}
              timelineTransitions={activeTabId === 'main' ? timelineTransitions : (timelineTabs.find(t => t.id === activeTabId)?.timelineTransitions || [])}
              selectedTransitionId={selectedTransitionId}
              onSelectTransition={(id) => {
                setSelectedTransitionId(id);
                if (id) {
                  setSelectedClipId(null);
                  setSelectedClipIds([]);
                }
              }}
              onUpdateTimelineTransition={(id, updates) => {
                updateTransition(id, updates, activeTabId);
              }}
              onRemoveTimelineTransition={(id) => {
                removeTransition(id, activeTabId);
                if (selectedTransitionId === id) setSelectedTransitionId(null);
              }}
            />
          </ResizableVerticalPanel>
        </div>

        {/* Right Panel - AI Agents */}
        <ResizablePanel
          defaultWidth={320}
          minWidth={280}
          maxWidth={500}
          side="right"
        >
          <div className="h-full flex flex-col bg-zinc-900/80 backdrop-blur-sm">
            {/* Agent Tabs */}
            <div className="flex items-center gap-1 px-2 border-b border-zinc-800/50">
              <button
                onClick={() => setActiveAgent('director')}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${activeAgent === 'director'
                    ? 'text-orange-500 border-b-2 border-orange-500 bg-zinc-800/30'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/20'
                  }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                Director
              </button>
              <button
                onClick={() => setActiveAgent('picasso')}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${activeAgent === 'picasso'
                    ? 'text-orange-300 border-b-2 border-orange-300 bg-zinc-800/30'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/20'
                  }`}
              >
                <Palette className="w-3.5 h-3.5" />
                Picasso
              </button>
              <button
                onClick={() => setActiveAgent('dicaprio')}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${activeAgent === 'dicaprio'
                    ? 'text-zinc-300 border-b-2 border-zinc-300 bg-zinc-800/30'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/20'
                  }`}
              >
                <Film className="w-3.5 h-3.5" />
                DiCaprio
              </button>
            </div>

            {/* AI Chat Panels - both mounted to preserve state, hidden via CSS */}
            <div className="flex-1 overflow-hidden relative">
              <div className={`absolute inset-0 ${activeAgent === 'director' ? '' : 'hidden'}`}>
                <AIPromptPanel
                  projectSettings={settings}
                  onApplyEdit={handleApplyEdit}
                  onExtractKeywordsAndAddGifs={handleExtractKeywordsAndAddGifs}
                  onTranscribeAndAddCaptions={handleTranscribeAndAddCaptions}
                  onGenerateBroll={handleGenerateBroll}
                  onRemoveDeadAir={handleRemoveDeadAir}
                  onChapterCuts={handleChapterCuts}
                  onAddMotionGraphic={handleAddMotionGraphicFromPrompt}
                  onCreateCustomAnimation={handleCreateCustomAnimation}
                  onUploadAttachment={uploadAsset}
                  onAnalyzeForAnimation={handleAnalyzeForAnimation}
                  onRenderFromConcept={handleRenderFromConcept}
                  onGenerateTranscriptAnimation={handleGenerateTranscriptAnimation}
                  onGenerateBatchAnimations={handleGenerateBatchAnimations}
                  onExtractAudio={handleExtractAudio}
                  onCreateContextualAnimation={handleCreateContextualAnimation}
                  onOpenAnimationInTab={handleOpenAnimationInTab}
                  onEditAnimation={handleEditAnimation}
                  isApplying={isProcessing}
                  applyProgress={0}
                  applyStatus={currentStatus}
                  hasVideo={assets.some(a => a.type === 'video')}
                  clips={clips}
                  tracks={tracks}
                  assets={assets}
                  currentTime={currentTime}
                  selectedClipId={selectedClipId}
                  selectedClipIds={selectedClipIds}
                  onUploadTransition={handleUploadTransition}
                  onDeleteTransition={handleDeleteTransition}
                  onGenerateTransition={handleGenerateTransition}
                  onApplyTransition={handleApplyTransition}
                  availableTransitions={availableTransitions}
                  activeTabId={activeTabId}
                  editTabAssetId={activeTabId !== 'main' ? timelineTabs.find(t => t.id === activeTabId)?.assetId : undefined}
                  editTabClips={activeTabId !== 'main' ? timelineTabs.find(t => t.id === activeTabId)?.clips : undefined}
                  onAudioSync={handleAudioSync}
                  onApplyAudioSync={handleApplyAudioSync}
                />
              </div>
              <div className={`absolute inset-0 ${activeAgent === 'picasso' ? '' : 'hidden'}`}>
                <PicassoPanel
                  sessionId={session?.sessionId ?? null}
                  onImageGenerated={(assetId) => {
                    console.log('Image generated:', assetId);
                  }}
                  onRefreshAssets={refreshAssets}
                />
              </div>
              <div className={`absolute inset-0 ${activeAgent === 'dicaprio' ? '' : 'hidden'}`}>
                <DiCaprioPanel
                  sessionId={session?.sessionId ?? null}
                  assets={assets}
                  onVideoGenerated={(assetId) => {
                    console.log('Video generated:', assetId);
                  }}
                  onRefreshAssets={refreshAssets}
                />
              </div>
            </div>
          </div>
        </ResizablePanel>
      </div>

      {/* GIF Search Modal */}
      {showGifSearch && session?.sessionId && (
        <GifSearchPanel
          sessionId={session.sessionId}
          onClose={() => setShowGifSearch(false)}
          onGifAdded={handleGifAdded}
        />
      )}
    </div>
  );
}
