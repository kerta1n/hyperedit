import { useState, useCallback, useRef, useEffect } from 'react';

import { API_BASE as LOCAL_FFMPEG_URL, pollJob, setActivePollSession } from '@/react-app/utils/api-helpers';
const SESSION_STORAGE_KEY = 'hyperedit-session';
// Legacy key from the pre-rename build. Read once by migrateLegacySessionKey()
// so an existing browser keeps its session, then dropped. TEMPORARY — this is
// the only remaining 'clipwise-' reference by design; delete it (and the
// migration) once browsers have rolled over, no later than R9's session-store
// redesign (it must not survive R9).
const LEGACY_SESSION_STORAGE_KEY = 'clipwise-session';

// Asset - source file in library
export interface Asset {
  id: string;
  type: 'video' | 'image' | 'audio';
  filename: string;
  duration: number;
  size: number;
  width?: number;
  height?: number;
  fps?: number; // Source frame rate (probed for uploads, render fps for animations)
  thumbnailUrl: string | null;
  streamUrl?: string; // URL with cache-busting timestamp
  aiGenerated?: boolean; // True if this is a Remotion-generated animation
}

// TimelineClip - instance on timeline
export interface TimelineClip {
  id: string;
  assetId: string;
  trackId: string;
  start: number;
  duration: number;
  inPoint: number;
  outPoint: number;
  transform?: {
    x?: number;
    y?: number;
    scale?: number;
    rotation?: number;
    opacity?: number;
    cropTop?: number;
    cropBottom?: number;
    cropLeft?: number;
    cropRight?: number;
  };
}

// Track
export interface Track {
  id: string;
  type: 'video' | 'audio' | 'text';
  name: string;
  order: number;
}

// Caption word with timing
export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

// Caption styling options
export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: 'normal' | 'bold' | 'black';
  color: string;
  textOpacity?: number; // 0-100 (percentage), default 100
  backgroundColor?: string;
  backgroundEnabled?: boolean; // Toggle background box on/off
  backgroundPadding?: number; // 0-200 (percentage), scales default padding
  backgroundRadius?: number; // 0-100 (percentage), 0=square, 100=oval, linear mapping
  backgroundOpacity?: number; // 0-100 (percentage), alpha of background color
  strokeColor?: string;
  strokeWidth?: number;
  position: 'bottom' | 'center' | 'top';
  positionX?: number; // -50 to 50 (percentage offset from center)
  positionY?: number; // -50 to 50 (percentage offset from base position)
  animation: 'none' | 'karaoke' | 'fade' | 'pop' | 'bounce' | 'typewriter' | 'highlight';
  highlightColor?: string;
  timeOffset?: number; // Offset in seconds to adjust sync (negative = earlier, positive = later)
}

// Caption clip data (stored alongside TimelineClip)
export interface CaptionData {
  words: CaptionWord[];
  style: CaptionStyle;
  // true = created by transcription (Generate Captions); absent/false = manual
  // text clip. Regeneration replaces only generated captions, never manual text.
  generated?: boolean;
  // true = the user hand-edited this clip's word text. Detection only — used
  // to WARN before a regeneration wipes hand edits; deliberately NOT used to
  // skip clips during replacement (owner decision 2026-07-16).
  wordsEdited?: boolean;
}

// How a word straddling a caption cut is distributed between the two halves
// ('both' shows it in both clips with clamped timing; 'left'/'right' keep it
// whole in one clip). Set per-project via the T1 track properties dropdown.
export type CaptionSplitMode = 'both' | 'left' | 'right';

// Project settings
export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  captionSplitMode?: CaptionSplitMode;
}

// Junction transition between two clips (V2 spec)
export type JunctionTransitionType = 'none' | 'crossfade' | 'slide-left' | 'slide-right' | 'dip-to-black' | 'custom';

export interface JunctionTransition {
  id: string;
  fromClipId: string;
  toClipId: string;
  type: JunctionTransitionType;
  durationSec: number;
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
  fallbackBehavior?: 'cut' | 'clamp' | 'crossfade';
  customTransitionId?: string;
}

export interface CustomTransitionMeta {
  id: string;
  name: string;
  filename: string;
  installedAt: string | null;
}

// V2 transition: independent timeline entity (cross-track, any timing scenario)
export interface TimelineTransition {
  id: string;
  startTime: number;           // absolute timeline position (seconds)
  durationSec: number;
  fromClipId: string | null;   // null = fade from black
  toClipId: string | null;     // null = fade to black
  transitionFileId: string;    // reference to registered .tsx transition
  easing?: string;
  params: Record<string, number | string | boolean>;
}

// Project state
export interface ProjectState {
  tracks: Track[];
  clips: TimelineClip[];
  settings: ProjectSettings;
  captionData?: Record<string, CaptionData>;
  transitions?: JunctionTransition[];           // legacy v1
  timelineTransitions?: TimelineTransition[];   // v2: cross-track independent entities
  brandTheme?: {
    name?: string;
    fontFamily?: string;
    accentColor?: string;
    secondaryColor?: string;
    backgroundColor?: string;
    textColor?: string;
    glow?: number;
    motionSpeed?: number;
  };
  adTemplate?: unknown;
}

// Timeline tab for editing clips in isolation
export interface TimelineTab {
  id: string;
  name: string;
  type: 'main' | 'clip';
  assetId?: string; // For clip tabs, the asset being edited
  clips: TimelineClip[];
  timelineTransitions: TimelineTransition[];
}

// Session info
export interface SessionInfo {
  sessionId: string;
  name: string;
  createdAt: number;
}

// One-time migration of the pre-rename localStorage key. Copies the legacy
// pointer forward if the new key is unset, then removes the legacy key. Idempotent
// (no-ops once migrated) and safe in private mode (storage may throw).
function migrateLegacySessionKey(): void {
  try {
    if (localStorage.getItem(SESSION_STORAGE_KEY) === null) {
      const legacy = localStorage.getItem(LEGACY_SESSION_STORAGE_KEY);
      if (legacy !== null) localStorage.setItem(SESSION_STORAGE_KEY, legacy);
    }
    localStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  } catch { /* storage disabled / private mode — nothing to migrate */ }
}

// Helper to load session from localStorage (migrates old entries missing `name`)
function loadSessionFromStorage(): SessionInfo | null {
  try {
    migrateLegacySessionKey();
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        sessionId: parsed.sessionId,
        name: parsed.name || 'Untitled Project',
        createdAt: parsed.createdAt,
      };
    }
  } catch (e) {
    console.error('Failed to load session from storage:', e);
  }
  return null;
}

// Default caption style
export const defaultCaptionStyle: CaptionStyle = {
  fontFamily: 'Inter',
  fontSize: 52,
  fontWeight: 'bold',
  color: '#FFFFFF',
  textOpacity: 100,
  backgroundColor: 'rgba(0,0,0,0.45)',
  backgroundEnabled: true,
  backgroundPadding: 100,
  backgroundRadius: 10,
  backgroundOpacity: 45,
  strokeColor: '#000000',
  strokeWidth: 4,
  position: 'bottom',
  positionX: 0,
  positionY: 0,
  animation: 'fade',
  highlightColor: '#FFD700',
};

// ── Render Options Types ────────────────────────────────────────────
export type VideoCodec = 'h264' | 'h265' | 'vp8' | 'vp9' | 'av1' | 'prores';
export type AudioCodec = 'aac' | 'mp3' | 'pcm-16' | 'opus';
export type ContainerFormat = 'mp4' | 'mkv' | 'webm' | 'mov';
export type HwAccelMode = 'disable' | 'if-possible' | 'required';

export interface RenderOptions {
  presetId: string;
  codec: VideoCodec;
  audioCodec: AudioCodec;
  containerFormat: ContainerFormat;
  outputWidth: number;
  outputHeight: number;
  outputFps: number;
  qualityMode: 'crf' | 'bitrate';
  crf: number | null;
  videoBitrate: string;
  audioBitrate: string;
  sampleRate: number;
  muted: boolean;
  hardwareAcceleration: HwAccelMode;
  x264Preset: string;
  proResProfile: string;
  scale: number;
  pixelFormat: string;
  enableCustomFfmpegFlags: boolean;
  customFfmpegFlags: string;
  concurrency: number;
  // False until the user explicitly picks resolution/fps in the render dialog;
  // while false, project settings seed outputWidth/outputHeight/outputFps
  outputCustomized: boolean;
}

export const defaultRenderOptions: RenderOptions = {
  presetId: 'custom',
  codec: 'h264',
  audioCodec: 'aac',
  containerFormat: 'mp4',
  outputWidth: 1920,
  outputHeight: 1080,
  // 60fps default: the "Custom" preset is a true reset-to-defaults, so a lower
  // value here silently halves exports after preset-hopping
  outputFps: 60,
  // bitrate, not crf: the default hardwareAcceleration below is incompatible
  // with CRF (Remotion constraint) — crf 23 is kept for when HW is disabled
  qualityMode: 'bitrate',
  crf: 23,
  videoBitrate: '10M',
  audioBitrate: '192k',
  sampleRate: 48000,
  muted: false,
  hardwareAcceleration: 'if-possible',
  x264Preset: 'fast',
  proResProfile: 'hq',
  scale: 1,
  pixelFormat: 'yuv420p',
  enableCustomFfmpegFlags: false,
  customFfmpegFlags: '',
  concurrency: 4,
  outputCustomized: false,
};

export function useProject() {
  // Initialize session from localStorage if available
  const [session, setSessionInternal] = useState<SessionInfo | null>(loadSessionFromStorage);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [tracks, setTracks] = useState<Track[]>([
    { id: 'T1', type: 'text', name: 'T1', order: 0 },   // Captions/text track (top)
    { id: 'V3', type: 'video', name: 'V3', order: 1 },  // Top overlay
    { id: 'V2', type: 'video', name: 'V2', order: 2 },  // Overlay
    { id: 'V1', type: 'video', name: 'V1', order: 3 },  // Base video track
    { id: 'A1', type: 'audio', name: 'A1', order: 4 },  // Audio track 1
    { id: 'A2', type: 'audio', name: 'A2', order: 5 },  // Audio track 2
  ]);
  const [clips, setClips] = useState<TimelineClip[]>([]);
  const [transitions, setTransitions] = useState<JunctionTransition[]>([]);
  const [timelineTransitions, setTimelineTransitions] = useState<TimelineTransition[]>([]);
  const [captionData, setCaptionData] = useState<Record<string, CaptionData>>({});

  // Timeline tabs for editing clips in isolation
  const [timelineTabs, setTimelineTabs] = useState<TimelineTab[]>([
    { id: 'main', name: 'Main', type: 'main', clips: [], timelineTransitions: [] }
  ]);
  const [activeTabId, setActiveTabId] = useState('main');

  const [settings, setSettings] = useState<ProjectSettings>({
    width: 1920,
    height: 1080,
    fps: 30,
  });
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [serverAvailable, setServerAvailable] = useState<boolean | null>(null);
  const [renderOptions, setRenderOptions] = useState<RenderOptions>(defaultRenderOptions);

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs to track latest state values for saveProject (avoids stale closure issues)
  const tracksRef = useRef(tracks);
  const clipsRef = useRef(clips);
  const settingsRef = useRef(settings);
  const captionDataRef = useRef(captionData);
  const transitionsRef = useRef(transitions);
  const timelineTransitionsRef = useRef(timelineTransitions);
  const renderOptionsRef = useRef(renderOptions);

  // Keep refs in sync with state
  useEffect(() => { tracksRef.current = tracks; }, [tracks]);
  useEffect(() => { clipsRef.current = clips; }, [clips]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { captionDataRef.current = captionData; }, [captionData]);
  useEffect(() => { transitionsRef.current = transitions; }, [transitions]);
  useEffect(() => { timelineTransitionsRef.current = timelineTransitions; }, [timelineTransitions]);
  useEffect(() => { renderOptionsRef.current = renderOptions; }, [renderOptions]);

  // Tell pollJob which session is active so long jobs that outlive a session
  // switch abandon their (stale) result instead of applying it to the new
  // project. Also clear any status/loading left over from that abandoned job so
  // the new session doesn't inherit a stuck "Rendering…" message (handlers that
  // clear status only on their success path can't, since the poll threw).
  useEffect(() => {
    setActivePollSession(session?.sessionId ?? null);
    setStatus('');
    setLoading(false);
  }, [session?.sessionId]);

  // Wrapper to persist session to localStorage
  const setSession = useCallback((sessionOrUpdater: SessionInfo | null | ((prev: SessionInfo | null) => SessionInfo | null)) => {
    setSessionInternal(prev => {
      const newSession = typeof sessionOrUpdater === 'function' ? sessionOrUpdater(prev) : sessionOrUpdater;
      if (newSession) {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(newSession));
      } else {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      }
      return newSession;
    });
  }, []);

  // Check if local server is available
  const checkServer = useCallback(async (): Promise<boolean> => {
    if (serverAvailable !== null) return serverAvailable;

    try {
      const response = await fetch(`${LOCAL_FFMPEG_URL}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000)
      });
      const data = await response.json();
      const available = data.status === 'ok';
      setServerAvailable(available);
      return available;
    } catch {
      setServerAvailable(false);
      return false;
    }
  }, [serverAvailable]);

  // Validate stored session on mount - clear if server doesn't recognize it
  useEffect(() => {
    const validateSession = async () => {
      if (!session) return;

      try {
        const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/project`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000)
        });

        if (response.status === 404) {
          // Session no longer exists on server - clear it
          console.log('Stored session is invalid, clearing...');
          localStorage.removeItem(SESSION_STORAGE_KEY);
          setSessionInternal(null);
          setAssets([]);
          setClips([]);
          setTransitions([]);
          setCaptionData({});
        }
      } catch (error) {
        // Server might be down - don't clear session yet
        console.log('Could not validate session:', error);
      }
    };

    validateSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Create a new session
  const createSession = useCallback(async (): Promise<SessionInfo> => {
    // We'll create a session by uploading the first asset
    // For now, just generate a client-side session ID that will be
    // confirmed when we upload the first file
    const tempId = crypto.randomUUID();
    const sessionInfo: SessionInfo = {
      sessionId: tempId,
      name: 'Untitled Project',
      createdAt: Date.now(),
    };
    return sessionInfo;
  }, []);

  // Upload asset
  const uploadAsset = useCallback(async (file: File): Promise<Asset> => {
    setLoading(true);
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
    setStatus(`Uploading ${file.name} (${fileSizeMB} MB)...`);

    try {
      let currentSession = session;

      // If no session yet, create one first
      if (!currentSession) {
        const createResponse = await fetch(`${LOCAL_FFMPEG_URL}/session/create`, {
          method: 'POST',
        });

        if (!createResponse.ok) {
          const error = await createResponse.json();
          throw new Error(error.error || 'Failed to create session');
        }

        const createResult = await createResponse.json();
        currentSession = {
          sessionId: createResult.sessionId,
          name: createResult.name || 'Untitled Project',
          createdAt: Date.now(),
        };
        setSession(currentSession);
      }

      // Upload the asset
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${currentSession.sessionId}/assets`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Upload failed');
      }

      const result = await response.json();
      const asset: Asset = {
        id: result.asset.id,
        type: result.asset.type,
        filename: result.asset.filename,
        duration: result.asset.duration,
        size: result.asset.size,
        width: result.asset.width,
        height: result.asset.height,
        fps: result.asset.fps,
        // Cache-bust the thumbnail (parity with refreshAssets/loadProject): the
        // background ingest re-writes this JPEG under the same id, and the
        // endpoint is cached (max-age), so a bare URL would pin the first frame.
        thumbnailUrl: result.asset.thumbnailUrl
          ? `${LOCAL_FFMPEG_URL}${result.asset.thumbnailUrl}${result.asset.thumbnailUrl.includes('?') ? '&' : '?'}v=${Date.now()}`
          : null,
      };

      setAssets(prev => [...prev, asset]);

      // Fresh upload: the proxy is built in the background, so the preview first
      // serves the raw source (the stream tier only serves a proxy once it's
      // `ready`). When the ingest job reports done, re-stamp this asset's
      // streamUrl so the preview <video> reloads and switches to the proxy —
      // otherwise it stays committed to the raw source (unscrubbable for long
      // sources) until a manual reload. Fire-and-forget; pollJob's active-session
      // guard drops the result if the user switched sessions mid-build, and any
      // failure just leaves the preview on the (always-valid) source.
      if (result.ingestJobId) {
        const sid = currentSession.sessionId;
        pollJob(sid, result.ingestJobId)
          .then(() => setAssets(prev => prev.map(a => a.id === asset.id
            ? { ...a, streamUrl: `${LOCAL_FFMPEG_URL}/session/${sid}/assets/${asset.id}/stream?v=${Date.now()}&tier=proxy` }
            : a)))
          .catch(() => {});
      }

      setStatus('');
      return asset;
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Delete asset
  const deleteAsset = useCallback(async (assetId: string): Promise<void> => {
    if (!session) return;

    const res = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/assets/${assetId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      // Server refused (e.g. 409 while a job is using this asset). Do NOT drop it
      // from client state — the file still exists on disk, so the next
      // refreshAssets() would resurrect a "deleted" asset and desync the UI.
      const data = await res.json().catch(() => ({}));
      throw new Error(data.hint || data.error || `Could not delete asset (${res.status})`);
    }

    setAssets(prev => prev.filter(a => a.id !== assetId));
    setClips(prev => prev.filter(c => c.assetId !== assetId));
    // Tab timelines reference assets too — leaving their clips dangling breaks
    // tab previews after the file is gone (caption clips have assetId '' and
    // are unaffected)
    setTimelineTabs(prev => prev.map(tab =>
      tab.clips.some(c => c.assetId === assetId)
        ? { ...tab, clips: tab.clips.filter(c => c.assetId !== assetId) }
        : tab
    ));
  }, [session]);

  // Get asset stream URL. ?tier=proxy asks the server for the 540p preview proxy
  // (Phase 5 §7.4) — it silently falls back to the source when no proxy exists
  // (fresh upload, non-video, ingest failed), so this is always safe. Preview
  // only: the render path builds its own spec URLs server-side with no tier
  // param, so render-reads-source holds by construction.
  const getAssetStreamUrl = useCallback((assetId: string): string | null => {
    if (!session) return null;
    return `${LOCAL_FFMPEG_URL}/session/${session.sessionId}/assets/${assetId}/stream?tier=proxy`;
  }, [session]);

  // Refresh assets from server (useful after server-side asset generation)
  const refreshAssets = useCallback(async (): Promise<Asset[]> => {
    if (!session) return [];

    const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/assets`);
    if (!response.ok) {
      throw new Error('Failed to fetch assets');
    }

    const data = await response.json();
    const serverAssets: Asset[] = (data.assets || []).map((a: {
      id: string;
      type: 'video' | 'image' | 'audio';
      filename: string;
      duration: number;
      size: number;
      width?: number;
      height?: number;
      fps?: number;
      thumbnailUrl?: string | null;
      aiGenerated?: boolean;
    }) => ({
      id: a.id,
      type: a.type,
      filename: a.filename,
      duration: a.duration,
      size: a.size,
      width: a.width,
      height: a.height,
      fps: a.fps,
      // Cache-bust the thumbnail too: an in-place edit (dead-air, animation-edit)
      // regenerates the JPEG under the same asset id, and the thumbnail endpoint
      // is cached (max-age), so without a version stamp the timeline keeps the
      // pre-edit frame. Same reason streamUrl is busted below.
      thumbnailUrl: a.thumbnailUrl
        ? `${LOCAL_FFMPEG_URL}${a.thumbnailUrl}${a.thumbnailUrl.includes('?') ? '&' : '?'}v=${Date.now()}`
        : null,
      streamUrl: `${LOCAL_FFMPEG_URL}/session/${session.sessionId}/assets/${a.id}/stream?v=${Date.now()}&tier=proxy`,
      // Preserve aiGenerated flag for Remotion-generated animations (critical for edit workflow detection)
      aiGenerated: a.aiGenerated || false,
    }));

    setAssets(serverAssets);
    return serverAssets;
  }, [session]);

  // Refresh ONLY the thumbnails of assets already in state — used after a
  // background ingest finishes rebuilding a post-edit thumbnail (dead-air). It
  // deliberately leaves streamUrl untouched so the preview <video> does NOT
  // reload (playback/sync stays intact); it only re-stamps the thumbnail URL so
  // the asset-library card drops the cached pre-edit frame.
  const refreshThumbnails = useCallback(async (): Promise<void> => {
    if (!session) return;
    const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/assets`);
    if (!response.ok) return;
    const data = await response.json();
    const byId = new Map<string, string | null>();
    for (const a of (data.assets || []) as { id: string; thumbnailUrl?: string | null }[]) {
      byId.set(a.id, a.thumbnailUrl
        ? `${LOCAL_FFMPEG_URL}${a.thumbnailUrl}${a.thumbnailUrl.includes('?') ? '&' : '?'}v=${Date.now()}`
        : null);
    }
    setAssets(prev => prev.map(a => (byId.has(a.id) ? { ...a, thumbnailUrl: byId.get(a.id) ?? null } : a)));
  }, [session]);

  // Add clip to timeline
  const addClip = useCallback((
    assetId: string,
    trackId: string,
    start: number,
    duration?: number,
    inPoint?: number,
    outPoint?: number
  ): TimelineClip => {
    const asset = assets.find(a => a.id === assetId);

    // For images, use provided duration or default to 5 seconds
    // For video/audio, use asset duration
    // If asset not found (race condition with refreshAssets), use provided duration or default
    let clipDuration: number;
    if (duration !== undefined) {
      clipDuration = duration;
    } else if (asset) {
      clipDuration = asset.type === 'image' ? 5 : asset.duration;
    } else {
      clipDuration = 5; // Default fallback
      console.warn(`Asset ${assetId} not found in state, using default duration`);
    }

    const clip: TimelineClip = {
      id: crypto.randomUUID(),
      assetId,
      trackId,
      start,
      duration: clipDuration,
      inPoint: inPoint ?? 0,
      outPoint: outPoint ?? clipDuration,
    };

    setClips(prev => [...prev, clip]);
    return clip;
  }, [assets]);

  // Update clip
  const updateClip = useCallback((clipId: string, updates: Partial<TimelineClip>): void => {
    setClips(prev => prev.map(c =>
      c.id === clipId ? { ...c, ...updates } : c
    ));
  }, []);

  // Remove clips and their caption data in one pass — the single canonical
  // captionData pruner; every clip-removal path funnels through it (missing
  // ids are no-ops, so callers may pass ids that only exist in tab timelines)
  const deleteCaptionClips = useCallback((clipIds: string[]): void => {
    if (clipIds.length === 0) return;
    const ids = new Set(clipIds);
    // Identity-stable: callers like deleteClip/tab paths pass ids that are
    // often already gone from main clips — returning prev avoids a pointless
    // re-render of the whole tree per delete
    setClips(prev => {
      const next = prev.filter(c => !ids.has(c.id));
      return next.length === prev.length ? prev : next;
    });
    setCaptionData(prev => {
      const next = { ...prev };
      let changed = false;
      for (const id of clipIds) {
        if (id in next) { delete next[id]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, []);

  // Delete clip (with optional ripple/autosnap to shift subsequent clips)
  const deleteClip = useCallback((clipId: string, ripple: boolean = false): void => {
    setClips(prev => {
      const clipToDelete = prev.find(c => c.id === clipId);
      if (!clipToDelete) return prev.filter(c => c.id !== clipId);

      // Remove the clip
      const filtered = prev.filter(c => c.id !== clipId);

      if (!ripple) return filtered;

      // Ripple mode: shift subsequent clips on the same track backward
      const deletedEnd = clipToDelete.start + clipToDelete.duration;
      const gapDuration = clipToDelete.duration;

      return filtered.map(c => {
        // Only shift clips on the same track that start at or after the deleted clip's end
        if (c.trackId === clipToDelete.trackId && c.start >= deletedEnd) {
          return {
            ...c,
            start: Math.max(0, c.start - gapDuration),
          };
        }
        return c;
      });
    });
    // Clean up orphaned transitions referencing the deleted clip
    setTransitions(prev => prev.filter(
      t => t.fromClipId !== clipId && t.toClipId !== clipId
    ));
    // Clean up v2 timeline transitions referencing the deleted clip
    setTimelineTransitions(prev => prev.filter(
      t => t.fromClipId !== clipId && t.toClipId !== clipId
    ));
    // Clean up the clip's caption data (no-op for non-caption clips). The
    // clips-filter inside is redundant here (already removed above) but keeps
    // one canonical pruner.
    deleteCaptionClips([clipId]);
  }, [deleteCaptionClips]);

  // Move clip
  const moveClip = useCallback((clipId: string, newStart: number, newTrackId?: string): void => {
    setClips(prev => prev.map(c => {
      if (c.id !== clipId) return c;
      return {
        ...c,
        start: Math.max(0, newStart),
        trackId: newTrackId ?? c.trackId,
      };
    }));
  }, []);

  // Resize clip (change in/out points or duration)
  const resizeClip = useCallback((clipId: string, newInPoint: number, newOutPoint: number): void => {
    setClips(prev => prev.map(c => {
      if (c.id !== clipId) return c;
      const newDuration = newOutPoint - newInPoint;
      return {
        ...c,
        inPoint: newInPoint,
        outPoint: newOutPoint,
        duration: newDuration,
      };
    }));
  }, []);

  // Split clip at a specific time, creating two clips
  const splitClip = useCallback((clipId: string, splitTime: number): string | null => {
    const clip = clips.find(c => c.id === clipId);
    if (!clip) return null;

    // Calculate the time within the clip where the split occurs
    const timeInClip = splitTime - clip.start;

    // Validate: split must be within the clip's duration (with small buffer)
    if (timeInClip <= 0.05 || timeInClip >= clip.duration - 0.05) {
      return null; // Split too close to edge
    }

    // Calculate the in-point offset for the split
    const splitInPoint = clip.inPoint + timeInClip;

    // Create the second clip (after the split)
    const secondClip: TimelineClip = {
      id: crypto.randomUUID(),
      assetId: clip.assetId,
      trackId: clip.trackId,
      start: splitTime,
      duration: clip.duration - timeInClip,
      inPoint: splitInPoint,
      outPoint: clip.outPoint,
      transform: clip.transform ? { ...clip.transform } : undefined,
    };

    // Update the first clip (before the split) and add the second clip
    setClips(prev => [
      ...prev.map(c => {
        if (c.id !== clipId) return c;
        return {
          ...c,
          duration: timeInClip,
          outPoint: splitInPoint,
        };
      }),
      secondClip,
    ]);

    // Split caption words across the two halves: words are clip-relative, so
    // the first half keeps words starting before the cut (ends clamped to it)
    // and the second half gets the rest re-offset to its own clip start.
    // Without this the second clip's id has no captionData (wordless captions).
    setCaptionData(prev => {
      const data = prev[clipId];
      if (!data) return prev;
      // Distribute the word straddling the cut per the project's split mode:
      // 'both' keeps it in both halves (ends clamped), 'left' keeps it whole
      // in the first clip only, 'right' moves it whole to the second clip
      const mode = settingsRef.current.captionSplitMode ?? 'both';
      const firstWords = data.words
        // A zero-duration word sitting exactly at the cut matches neither
        // half's predicate in 'both' mode — keep it in the first half
        .filter(w => (mode === 'right' ? w.end <= timeInClip : w.start < timeInClip)
          || (mode === 'both' && w.start === timeInClip && w.end === timeInClip))
        .map(w => (w.end > timeInClip ? { ...w, end: timeInClip } : w));
      const secondWords = data.words
        .filter(w => (mode === 'left' ? w.start >= timeInClip : w.end > timeInClip))
        .map(w => ({
          ...w,
          start: Math.max(0, w.start - timeInClip),
          end: w.end - timeInClip,
        }));
      return {
        ...prev,
        [clipId]: { ...data, words: firstWords },
        [secondClip.id]: { ...data, style: { ...data.style }, words: secondWords },
      };
    });

    // Re-wire legacy transitions: any transition where the original clip was the "from" clip
    // should now reference the second clip (which ends where the original ended)
    setTransitions(prev => prev.map(t => {
      if (t.fromClipId === clipId) {
        return { ...t, fromClipId: secondClip.id };
      }
      return t;
    }));
    // Re-wire v2 timeline transitions similarly
    setTimelineTransitions(prev => prev.map(t => {
      if (t.fromClipId === clipId) {
        return { ...t, fromClipId: secondClip.id };
      }
      return t;
    }));

    return secondClip.id;
  }, [clips]);

  // Create a new timeline tab for editing a clip/animation in isolation
  const createTimelineTab = useCallback((name: string, assetId: string, initialClips?: TimelineClip[]): string => {
    const tabId = crypto.randomUUID();
    const newTab: TimelineTab = {
      id: tabId,
      name,
      type: 'clip',
      assetId,
      clips: initialClips || [],
      timelineTransitions: [],
    };

    setTimelineTabs(prev => [...prev, newTab]);
    setActiveTabId(tabId);

    return tabId;
  }, []);

  // Switch to a different timeline tab
  const switchTimelineTab = useCallback((tabId: string): void => {
    setActiveTabId(tabId);
  }, []);

  // Close a timeline tab (cannot close main)
  const closeTimelineTab = useCallback((tabId: string): void => {
    if (tabId === 'main') return; // Cannot close main tab

    // Prune caption data for the tab's clips (tab text clips write into the
    // global captionData map; tabs aren't persisted, so entries left behind
    // become permanent orphans in project.json)
    const closingTab = timelineTabs.find(tab => tab.id === tabId);
    if (closingTab && closingTab.clips.length > 0) {
      // handleAddText dual-lists tab text clips in MAIN clips too — those must
      // survive the tab closing; prune only ids that live solely in the tab
      const mainIds = new Set(clipsRef.current.map(c => c.id));
      deleteCaptionClips(closingTab.clips.filter(c => !mainIds.has(c.id)).map(c => c.id));
    }

    setTimelineTabs(prev => prev.filter(tab => tab.id !== tabId));

    // If closing the active tab, switch to main
    setActiveTabId(currentId => {
      if (currentId === tabId) return 'main';
      return currentId;
    });
  }, [timelineTabs, deleteCaptionClips]);

  // Update clips in a specific tab
  const updateTabClips = useCallback((tabId: string, clips: TimelineClip[]): void => {
    setTimelineTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, clips } : tab
    ));
  }, []);

  // Update a tab's animation asset (used when editing an animation - now in-place)
  // This updates the V1 clip duration (asset ID stays the same for in-place edits)
  const updateTabAsset = useCallback((tabId: string, newAssetId: string, newDuration: number): void => {
    setTimelineTabs(prev => prev.map(tab => {
      if (tab.id !== tabId) return tab;

      const updatedClips = tab.clips.map(clip => {
        if (clip.trackId === 'V1') {
          return {
            ...clip,
            assetId: newAssetId,
            duration: newDuration,
            outPoint: newDuration,
          };
        }
        return clip;
      });

      return {
        ...tab,
        assetId: newAssetId,
        clips: updatedClips,
      };
    }));
  }, []);

  // Get the active timeline tab
  const getActiveTab = useCallback((): TimelineTab | undefined => {
    return timelineTabs.find(tab => tab.id === activeTabId);
  }, [timelineTabs, activeTabId]);

  // addCaptionClip logic below

  // Add caption clip to timeline
  const addCaptionClip = useCallback((
    words: CaptionWord[],
    start: number,
    duration: number,
    style?: Partial<CaptionStyle>
  ): TimelineClip => {
    const clipId = crypto.randomUUID();

    // Create the timeline clip
    const clip: TimelineClip = {
      id: clipId,
      assetId: '', // No asset for captions
      trackId: 'T1',
      start,
      duration,
      inPoint: 0,
      outPoint: duration,
    };

    // Store caption data separately
    const captionInfo: CaptionData = {
      words,
      style: { ...defaultCaptionStyle, ...style },
    };

    setClips(prev => [...prev, clip]);
    setCaptionData(prev => ({ ...prev, [clipId]: captionInfo }));

    return clip;
  }, []);

  // Add multiple caption clips at once (batched for performance)
  const addCaptionClipsBatch = useCallback((
    captions: Array<{
      words: CaptionWord[];
      start: number;
      duration: number;
      style?: Partial<CaptionStyle>;
      generated?: boolean;
    }>
  ): TimelineClip[] => {
    const newClips: TimelineClip[] = [];
    const newCaptionData: Record<string, CaptionData> = {};

    for (const caption of captions) {
      const clipId = crypto.randomUUID();

      newClips.push({
        id: clipId,
        assetId: '',
        trackId: 'T1',
        start: caption.start,
        duration: caption.duration,
        inPoint: 0,
        outPoint: caption.duration,
      });

      newCaptionData[clipId] = {
        words: caption.words,
        style: { ...defaultCaptionStyle, ...caption.style },
        ...(caption.generated ? { generated: true } : {}),
      };
    }

    // Single state update for all clips
    setClips(prev => [...prev, ...newClips]);
    setCaptionData(prev => ({ ...prev, ...newCaptionData }));

    return newClips;
  }, []);

  // Update a caption clip's word list (in-place text fixes; per-word timing
  // edits are a future extension of the same surface)
  const updateCaptionWords = useCallback((clipId: string, words: CaptionWord[]): void => {
    setCaptionData(prev => {
      const existing = prev[clipId];
      if (!existing) return prev;
      return { ...prev, [clipId]: { ...existing, words, wordsEdited: true } };
    });
  }, []);

  // Update caption style
  const updateCaptionStyle = useCallback((clipId: string, styleUpdates: Partial<CaptionStyle>): void => {
    setCaptionData(prev => {
      const existing = prev[clipId];
      if (!existing) return prev;
      return {
        ...prev,
        [clipId]: {
          ...existing,
          style: { ...existing.style, ...styleUpdates },
        },
      };
    });
  }, []);

  // Get caption data for a clip
  const getCaptionData = useCallback((clipId: string): CaptionData | null => {
    return captionData[clipId] || null;
  }, [captionData]);

  // --- Legacy v1 transition CRUD (kept for backward compat) ---
  const addLegacyTransition = useCallback((
    fromClipId: string,
    toClipId: string,
    type: JunctionTransitionType = 'crossfade',
    durationSec: number = 0.5,
    customTransitionId?: string
  ): JunctionTransition => {
    const transition: JunctionTransition = {
      id: crypto.randomUUID(),
      fromClipId,
      toClipId,
      type,
      durationSec,
      easing: 'ease-in-out',
      fallbackBehavior: 'clamp',
      ...(customTransitionId ? { customTransitionId } : {}),
    };
    setTransitions(prev => {
      const filtered = prev.filter(
        t => !(t.fromClipId === fromClipId && t.toClipId === toClipId)
      );
      return [...filtered, transition];
    });
    return transition;
  }, []);

  // --- V2 Timeline Transition CRUD ---
  // Each op takes an optional tabId: when a timeline tab is active its
  // transitions live in tab.timelineTransitions, not the main array — writing
  // main state while a tab is active silently no-ops against what the user sees
  const addTransition = useCallback((
    fromClipId: string | null,
    toClipId: string | null,
    transitionFileId: string,
    startTime: number,
    durationSec: number = 0.5,
    params: Record<string, number | string | boolean> = {},
    easing?: string,
    tabId?: string
  ): TimelineTransition => {
    const transition: TimelineTransition = {
      id: crypto.randomUUID(),
      startTime,
      durationSec,
      fromClipId,
      toClipId,
      transitionFileId,
      easing: easing ?? 'ease-in-out',
      params,
    };
    if (tabId && tabId !== 'main') {
      setTimelineTabs(prev => prev.map(tab =>
        tab.id === tabId
          ? { ...tab, timelineTransitions: [...tab.timelineTransitions, transition] }
          : tab
      ));
    } else {
      setTimelineTransitions(prev => [...prev, transition]);
    }
    return transition;
  }, []);

  // Update an existing v2 transition. Transition-agnostic by design: custom
  // transitions are per-user plugins — the core never inspects transitionFileId
  // or coordinates entities (multi-entity looks belong inside one transition
  // component; see docs/transition-authoring-spec.md)
  const updateTransition = useCallback((
    transitionId: string,
    updates: Partial<Omit<TimelineTransition, 'id'>>,
    tabId?: string
  ): void => {
    const apply = (prev: TimelineTransition[]) =>
      prev.map(t => (t.id === transitionId ? { ...t, ...updates } : t));
    if (tabId && tabId !== 'main') {
      setTimelineTabs(prev => prev.map(tab =>
        tab.id === tabId
          ? { ...tab, timelineTransitions: apply(tab.timelineTransitions) }
          : tab
      ));
    } else {
      setTimelineTransitions(apply);
    }
  }, []);

  // Remove a v2 transition
  const removeTransition = useCallback((transitionId: string, tabId?: string): void => {
    if (tabId && tabId !== 'main') {
      setTimelineTabs(prev => prev.map(tab =>
        tab.id === tabId
          ? { ...tab, timelineTransitions: tab.timelineTransitions.filter(t => t.id !== transitionId) }
          : tab
      ));
    } else {
      setTimelineTransitions(prev => prev.filter(t => t.id !== transitionId));
    }
  }, []);

  // Update transitions for a specific tab
  const updateTabTransitions = useCallback((tabId: string, newTransitions: TimelineTransition[]): void => {
    setTimelineTabs(prev => prev.map(tab =>
      tab.id === tabId ? { ...tab, timelineTransitions: newTransitions } : tab
    ));
  }, []);

  // Save project to server (debounced)
  // Uses refs to always get latest state, avoiding stale closure issues
  const saveProject = useCallback(async (): Promise<void> => {
    if (!session) return;

    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce saves - use refs to get latest state values
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/project`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tracks: tracksRef.current,
            clips: clipsRef.current,
            settings: settingsRef.current,
            captionData: captionDataRef.current,
            transitions: transitionsRef.current,
            timelineTransitions: timelineTransitionsRef.current,
            renderOptions: renderOptionsRef.current,
          }),
        });
        console.log('[Project] Saved');
      } catch (error) {
        console.error('[Project] Save failed:', error);
      }
    }, 500);
  }, [session]);

  // Immediate (non-debounced) save — used before session switch
  const saveProjectImmediate = useCallback(async (): Promise<void> => {
    if (!session) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    try {
      await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/project`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tracks: tracksRef.current,
          clips: clipsRef.current,
          settings: settingsRef.current,
          captionData: captionDataRef.current,
          transitions: transitionsRef.current,
          timelineTransitions: timelineTransitionsRef.current,
          renderOptions: renderOptionsRef.current,
        }),
      });
      console.log('[Project] Saved (immediate)');
    } catch (error) {
      console.error('[Project] Immediate save failed:', error);
    }
  }, [session]);

  // Reset all hook-owned project state for clean session switch
  const resetProjectState = useCallback((): void => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    setAssets([]);
    setClips([]);
    setTransitions([]);
    setTimelineTransitions([]);
    setCaptionData({});
    setTimelineTabs([{ id: 'main', name: 'Main', type: 'main', clips: [], timelineTransitions: [] }]);
    setActiveTabId('main');
    setRenderOptions(defaultRenderOptions);
    setSettings({ width: 1920, height: 1080, fps: 30 });
    setLoading(false);
    setStatus('');
  }, []);

  // Load project from server (including assets)
  const loadProject = useCallback(async (): Promise<void> => {
    if (!session) return;

    try {
      // Fetch assets first
      const assetsResponse = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/assets`);
      if (assetsResponse.ok) {
        const assetsData = await assetsResponse.json();
        const serverAssets: Asset[] = (assetsData.assets || []).map((a: {
          id: string;
          type: 'video' | 'image' | 'audio';
          filename: string;
          duration: number;
          size: number;
          width?: number;
          height?: number;
          fps?: number;
          thumbnailUrl?: string | null;
          aiGenerated?: boolean;
        }) => ({
          id: a.id,
          type: a.type,
          filename: a.filename,
          duration: a.duration,
          size: a.size,
          width: a.width,
          height: a.height,
          fps: a.fps,
          // Cache-bust the thumbnail too (parity with refreshAssets): an
          // in-place edit rewrites the JPEG under the same id, and the endpoint
          // is cached (max-age), so a bare URL keeps the pre-edit frame on reload.
          thumbnailUrl: a.thumbnailUrl
            ? `${LOCAL_FFMPEG_URL}${a.thumbnailUrl}${a.thumbnailUrl.includes('?') ? '&' : '?'}v=${Date.now()}`
            : null,
          // Add cache-busting timestamp to force reload after file changes;
          // ?tier=proxy serves the 540p preview proxy with silent source fallback (§7.4).
          streamUrl: `${LOCAL_FFMPEG_URL}/session/${session.sessionId}/assets/${a.id}/stream?v=${Date.now()}&tier=proxy`,
          // Preserve aiGenerated flag for Remotion-generated animations (critical for edit workflow detection)
          aiGenerated: a.aiGenerated || false,
        }));
        setAssets(serverAssets);
      }

      // Then fetch project
      const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/project`);
      if (response.ok) {
        const data = await response.json();
        // Don't load tracks from server - always use client's default tracks
        // Server tracks may be outdated (e.g., missing T1, V3, A2)
        if (data.clips) setClips(data.clips);
        if (data.settings) setSettings(data.settings);
        if (data.captionData) {
          // Orphan sweep: drop caption entries whose clip no longer exists.
          // Tabs are not persisted, so main clips are the full live set here;
          // pre-sweep projects accumulated orphans from deletes/regenerations.
          const liveClipIds = new Set(((data.clips || []) as TimelineClip[]).map(c => c.id));
          const swept = Object.fromEntries(
            Object.entries(data.captionData as Record<string, CaptionData>)
              .filter(([clipId]) => liveClipIds.has(clipId))
          );
          setCaptionData(swept);
        }
        if (data.transitions) setTransitions(data.transitions);
        if (data.timelineTransitions) setTimelineTransitions(data.timelineTransitions);
        if (data.renderOptions) setRenderOptions({ ...defaultRenderOptions, ...data.renderOptions });
      }
    } catch (error) {
      console.error('[Project] Load failed:', error);
    }
  }, [session]);

  // Render project
  // Uses refs to always get latest state
  const renderProject = useCallback(async (preview = false, exportRenderOptions?: RenderOptions): Promise<string> => {
    if (!session) throw new Error('No session');

    setLoading(true);
    setStatus(preview ? 'Rendering preview...' : 'Rendering export...');

    try {
      // Save project first - use refs to get latest state
      await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/project`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tracks: tracksRef.current,
          clips: clipsRef.current,
          settings: settingsRef.current,
          captionData: captionDataRef.current,
          transitions: transitionsRef.current,
          timelineTransitions: timelineTransitionsRef.current,
          renderOptions: renderOptionsRef.current,
        }),
      });

      const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preview,
          renderOptions: exportRenderOptions || renderOptionsRef.current,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        if (response.status === 422) {
          // Spec validation error — surface structured details
          const details = (errorData.details || [])
            .map((d: { path: string; message: string }) => `${d.path}: ${d.message}`)
            .join('; ');
          throw new Error(`Spec validation failed: ${details || errorData.message}`);
        }
        throw new Error(errorData.error || 'Render failed');
      }

      // 202 { jobId } — progress and result are polled from the jobs endpoint
      const { jobId } = await response.json();
      const result = await pollJob(session.sessionId, jobId, {
        onUpdate: (job) => {
          if (job.state === 'queued') {
            const position = job.queuePosition ?? 0;
            setStatus(position > 0
              ? `Render queued — waiting for ${position} earlier render${position === 1 ? '' : 's'}…`
              : 'Render queued…');
          } else if (job.state === 'running' && job.progress) {
            const { pct, frames, total, elapsed } = job.progress as { pct: number; frames: number; total: number; elapsed: string };
            setStatus(`Rendering: ${pct}% (${frames}/${total} frames) [${elapsed}]`);
          }
        },
      }) as { warnings?: { message: string }[]; downloadUrl: string };

      if (result.warnings?.length) {
        console.warn('[Render] Transition warnings:', result.warnings);
      }

      setStatus('Render complete!');

      // Return download URL
      return `${LOCAL_FFMPEG_URL}${result.downloadUrl}`;
    } finally {
      setLoading(false);
      setTimeout(() => setStatus(''), 2000);
    }
  }, [session]);

  // Get total project duration
  const getDuration = useCallback((): number => {
    if (clips.length === 0) return 0;
    return Math.max(...clips.map(c => c.start + c.duration));
  }, [clips]);

  // Create animated GIF from an image asset
  const createGif = useCallback(async (
    sourceAssetId: string,
    options: {
      effect?: 'pulse' | 'zoom' | 'rotate' | 'bounce' | 'fade' | 'shake';
      duration?: number;
      fps?: number;
      width?: number;
      height?: number;
    } = {}
  ): Promise<Asset> => {
    if (!session) throw new Error('No session');

    setLoading(true);
    setStatus('Creating animated GIF...');

    try {
      const response = await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}/create-gif`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceAssetId,
          ...options,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'GIF creation failed');
      }

      // 202 { jobId } — poll until the gif job settles
      const { jobId } = await response.json();
      const result = await pollJob(session.sessionId, jobId) as { asset: Asset & { thumbnailUrl: string | null } };
      const asset: Asset = {
        id: result.asset.id,
        type: result.asset.type,
        filename: result.asset.filename,
        duration: result.asset.duration,
        size: result.asset.size,
        width: result.asset.width,
        height: result.asset.height,
        fps: result.asset.fps,
        thumbnailUrl: result.asset.thumbnailUrl
          ? `${LOCAL_FFMPEG_URL}${result.asset.thumbnailUrl}`
          : null,
      };

      setAssets(prev => [...prev, asset]);
      setStatus('GIF created!');
      return asset;
    } finally {
      setLoading(false);
      setTimeout(() => setStatus(''), 2000);
    }
  }, [session]);

  // Close session
  const closeSession = useCallback(async (): Promise<void> => {
    if (session) {
      try {
        await fetch(`${LOCAL_FFMPEG_URL}/session/${session.sessionId}`, {
          method: 'DELETE',
        });
      } catch { /* explicitly ignore */ }
    }
    setSession(null);
    setAssets([]);
    setClips([]);
    setTransitions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Auto-save when clips change
  // Note: This is commented out to prevent excessive saves during drag operations
  // useEffect(() => {
  //   if (session && clips.length > 0) {
  //     saveProject();
  //   }
  // }, [clips, session, saveProject]);

  return {
    // State
    session,
    assets,
    tracks,
    clips,
    settings,
    loading,
    status,
    serverAvailable,

    // Session
    setSession,
    checkServer,
    createSession,
    closeSession,
    saveProjectImmediate,
    resetProjectState,

    // Assets
    uploadAsset,
    deleteAsset,
    getAssetStreamUrl,
    refreshAssets,
    refreshThumbnails,
    createGif,

    // Clips
    addClip,
    updateClip,
    deleteClip,
    moveClip,
    resizeClip,
    splitClip,

    // Captions
    captionData,
    addCaptionClip,
    addCaptionClipsBatch,
    deleteCaptionClips,
    updateCaptionStyle,
    updateCaptionWords,
    getCaptionData,

    // Live-state refs for async flows (read-only)
    clipsRef,

    // Transitions (legacy v1)
    transitions,
    addLegacyTransition,
    setTransitions,

    // Timeline Transitions (v2)
    timelineTransitions,
    addTransition,
    updateTransition,
    removeTransition,
    setTimelineTransitions,
    updateTabTransitions,

    // Project
    saveProject,
    loadProject,
    renderProject,
    getDuration,

    // Setters for direct state manipulation
    setTracks,
    setClips,
    setSettings,
    setStatus,

    // Render options
    renderOptions,
    setRenderOptions,

    // Timeline tabs
    timelineTabs,
    activeTabId,
    createTimelineTab,
    switchTimelineTab,
    closeTimelineTab,
    updateTabClips,
    updateTabAsset,
    getActiveTab,
  };
}
