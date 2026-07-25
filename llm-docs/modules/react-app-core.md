---
title: React App Core
type: module
source_files:
  - src/react-app/main.tsx
  - src/react-app/App.tsx
  - src/react-app/pages/Home.tsx
  - src/react-app/hooks/useProject.ts
  - src/react-app/hooks/useFFmpeg.ts
  - src/react-app/hooks/useVideoSession.ts
  - src/react-app/hooks/useSessionManager.ts
  - src/react-app/hooks/useDeliverables.ts
tags:
  - react
  - hooks
  - state-management
  - timeline
  - ffmpeg
  - sessions
---

# React App Core

## Overview

This module is the entire frontend of HyperEdit: the React entry point, the single-page editor layout (`Home.tsx`), and the suite of custom hooks that manage project state, FFmpeg processing, session lifecycle, and render gallery. `useProject` is the authoritative state manager for the multi-track timeline; all other hooks are either legacy, supplementary, or scoped utilities that delegate to the FFmpeg server at `http://localhost:3333`.

---

## Architecture Diagram

```text
main.tsx
  └── App.tsx  (BrowserRouter → Route "/")
        └── Home.tsx  (main editor layout, 2353 lines)
              │
              ├── useProject()          ← primary state: assets, clips, tracks, captions, transitions, tabs
              ├── useVideoSession()     ← legacy single-video session (generateChapters only)
              │
              ├── LEFT PANEL (ResizablePanel, default 220px)
              │     ├── AssetLibrary
              │     ├── ClipPropertiesPanel   (clip selected, not on T1)
              │     ├── CaptionPropertiesPanel (clip on T1 selected)
              │     ├── TransitionPropertiesPanel (transition selected)
              │     └── TrackPropertiesPanel  (track label clicked, nothing else selected)
              │
              ├── CENTER
              │     ├── VideoPreview   (layers computed by getPreviewLayers())
              │     └── Timeline       (ResizableVerticalPanel, default 224px)
              │
              └── RIGHT PANEL (ResizablePanel, default 320px)
                    ├── AIPromptPanel   ("Director" agent)
                    ├── PicassoPanel    ("Picasso" agent, image gen)
                    └── DiCaprioPanel   ("DiCaprio" agent, video gen)
                    (all three always mounted, toggled via `hidden` CSS class)

Hooks dependency map:
  useProject          → FFmpeg server (localhost:3333)
  useFFmpeg           → FFmpeg WASM fallback + FFmpeg server
  useVideoSession     → FFmpeg server (legacy upload endpoint)
  useSessionManager   → FFmpeg server /sessions list
  useDeliverables     → FFmpeg server /renders list
```

---

## Key Components

### `src/react-app/main.tsx`

| Item | Line | Description |
|------|------|-------------|
| `createRoot(...).render(<App />)` | 6–8 | Mounts React 19 app into `#root`; imports `index.css` and `@/remotion/transitions/init` side-effect |

### `src/react-app/App.tsx`

| Item | Line | Description |
|------|------|-------------|
| `export default function App()` | 4 | Wraps the entire SPA in `<BrowserRouter>`; single route `"/"` → `<HomePage />` |

### `src/react-app/pages/Home.tsx`

#### Local State Variables (all `useState`)

| Variable | Type | Line | Description |
|----------|------|------|-------------|
| `selectedClipId` | `string \| null` | 33 | Single selected clip on timeline |
| `selectedClipIds` | `string[]` | 34 | Multi-select (max 2 clips for transitions) |
| `selectedTransitionId` | `string \| null` | 35 | Selected v2 timeline transition |
| `selectedAssetId` | `string \| null` | 36 | Selected asset in asset library |
| `availableTransitions` | `{ builtIn: string[]; custom: { id: string; name: string }[] }` | 37 | Populated from server `/transitions` endpoint; initial value has 4 built-ins |
| `currentTime` | `number` | 38 | Playhead position in seconds |
| `isPlaying` | `boolean` | 39 | Playback running flag |
| `chapterData` | `ChapterData \| null` | 40 | Result from `legacyGenerateChapters` |
| `showChapters` | `boolean` | 41 | Controls chapter modal visibility |
| `copied` | `boolean` | 42 | Clipboard copy confirmation (2-second reset) |
| `previewAssetId` | `string \| null` | 43 | When set, preview only this asset (library preview mode) |
| `aspectRatio` | `'16:9' \| '9:16'` | 44 | Canvas aspect ratio |
| `selectedTrackId` | `string \| null` | 45 | Track selected via label click |
| `trackAutoSnap` | `Record<string, boolean>` | 46 | Per-track ripple-delete toggle |
| `activeAgent` | `'director' \| 'picasso' \| 'dicaprio'` | 47 | Which right-panel AI tab is visible |
| `showGifSearch` | `boolean` | 48 | GIF search modal visibility |
| `showRenderSettings` | `boolean` | 49 | Render settings modal visibility |
| `recommendedConcurrency` | `number` | 50 | Fetched from `/hwaccel-info`; defaults to 4 |

#### Refs

| Ref | Type | Line | Description |
|-----|------|------|-------------|
| `videoPreviewRef` | `VideoPreviewHandle` | 52 | Imperative handle to `VideoPreview` (used for chapter-click seek) |
| `playbackRef` | `number \| null` | 53 | `requestAnimationFrame` ID for playback loop |
| `lastTimeRef` | `number` | 54 | Timestamp of last animation frame (performance.now()) for delta calculation |

#### Local Interface

| Interface | Fields | Line |
|-----------|--------|------|
| `ChapterData` | `chapters: Array<{ start: number; title: string }>`, `youtubeFormat: string`, `summary: string` | 26–30 |

#### Computed / Memoized Values

| Name | Line | Description |
|------|------|-------------|
| `activeClips` | 128–134 | `useMemo`: returns `clips` if `activeTabId === 'main'`, else the active tab's `clips` array |
| `previewActiveTransitions` | 278–310 | `useMemo`: filters `timelineTransitions` to those overlapping `currentTime`; maps to `ActiveTransition[]` with `fromStartFrom`/`toStartFrom` in frames at 30 fps |
| `duration` | 313–316 | `useMemo`: `max(clip.start + clip.duration)` across `activeClips`; 0 if empty |
| `selectedClip` | 739–742 | `useMemo`: finds clip by `selectedClipId` in `clips` |
| `selectedClipAsset` | 744–747 | `useMemo`: resolves `selectedClip.assetId` → `Asset` |
| `selectedCaptionData` | 750–753 | `useMemo`: returns `getCaptionData(selectedClip.id)` only if `selectedClip.trackId === 'T1'` |
| `previewLayers` | 274 | Computed on every render via `getPreviewLayers()` call |
| `hasPreviewContent` | 275 | `previewLayers.length > 0` |
| `isProcessing` | 1883 | `loading || legacyProcessing` |
| `currentStatus` | 1884 | `status || legacyStatus` |

#### Handler Functions (all `useCallback`)

| Function | Line | Description |
|----------|------|-------------|
| `resetLocalState` | 112–125 | Resets all local `useState` fields to defaults; called during session switch |
| `getPreviewLayers` | 158–272 | Builds layer array for `VideoPreview`: video tracks V1/V2/V3, audio tracks A1/A2, caption track T1; converts caption word timestamps to clip-relative time; returns `[]` in library-preview mode |
| `handlePlayPause` | 350–356 | Toggles `isPlaying`; if at end, resets `currentTime` to 0 first |
| `handleStop` | 359–362 | Sets `isPlaying = false`, `currentTime = 0` |
| `handleTimelineSeek` | 365–368 | Sets `currentTime` from timeline scrub |
| `handleAssetUpload` | 372–388 | Calls `uploadAsset` per file; auto-detects `aspectRatio` from first uploaded video's dimensions |
| `handleGifAdded` | 391–395 | Calls `refreshAssets()` then closes GIF search |
| `handleAssetDragStart` | 398–400 | No-op placeholder |
| `handleAssetSelect` | 403–409 | Sets `selectedAssetId` and `previewAssetId`; clears `selectedClipId` |
| `handleDropAsset` | 412–450 | Adds clip on drop; redirects audio→A1 if dropped on video track and vice versa; images get 5-second duration; tab-aware (dispatches to `updateTabClips` if not on main) |
| `handleMoveClip` | 453–474 | Tab-aware clip move; in main tab delegates to `moveClip` |
| `handleResizeClip` | 477–512 | Tab-aware clip resize: updates `inPoint`, `outPoint`, `duration`, `start` |
| `handleDeleteClip` | 515–532 | Tab-aware clip delete; in main tab reads `trackAutoSnap[clip.trackId]` for ripple |
| `handleCutAtPlayhead` | 535–551 | Finds all `clips` spanning `currentTime`, calls `splitClip` on each; saves |
| `handleAddText` | 554–570 | Creates caption clip with text "Text" at playhead for 5 seconds; tab-aware |
| `handleToggleAspectRatio` | 573–584 | Cycles `'16:9'` ↔ `'9:16'`; updates `settings` width/height via `setSettings` |
| `handleSelectClip` | 587–610 | Single select or shift-click multi-select (capped at 2 clips); clears `previewAssetId` |
| `fetchAvailableTransitions` | 613–622 | `GET /session/{id}/transitions`; populates `availableTransitions` |
| `handleUploadTransition` | 632–645 | `POST /session/{id}/upload-transition` with `.tsx` file + name |
| `handleDeleteTransition` | 648–658 | `POST /session/{id}/delete-transition` |
| `handleGenerateTransition` | 661–672 | `POST /session/{id}/generate-transition` with text description |
| `handleApplyTransitionV2` | 675–710 | Computes `startTime` from clip positions (overlap / adjacent / gap cases); calls `addTransition` |
| `handleApplyTransition` | 713–730 | Legacy bridge: maps old type strings to v2 `transitionFileId` then calls `handleApplyTransitionV2` |
| `handleUpdateClipTransform` | 733–736 | Calls `updateClip` with `{ transform }` then saves |
| `handleLayerMove` | 756–764 | Updates clip `transform.x` and `transform.y` from video preview drag |
| `handleLayerSelect` | 767–770 | Sets `selectedClipId` from video preview layer click |
| `handleApplyEdit` | 773–832 | Finds target video asset (selected clip's, or first video); `POST /process-asset`; refreshes assets; if new `assetId` returned, updates all clips using old ID |
| `handleGenerateChapters` | 835–849 | Uses legacy `legacyGenerateChapters`; sets `chapterData` and shows modal |
| `handleCopyChapters` | 852–858 | Copies `chapterData.youtubeFormat` to clipboard; sets `copied = true` for 2 seconds |
| `handleChapterCuts` | 861–978 | Fetches chapters from server; reads current project from server directly; splits clips on V1 at chapter timestamps (skipping those within 0.05s of edges); saves modified clips directly to server; calls `loadProject()` to sync |
| `handleExtractKeywordsAndAddGifs` | 981–1016 | `POST /transcribe-and-extract`; adds each returned `gifAsset` to V2 track at its timestamp with 3-second duration |
| `handleGenerateBroll` | 1019–1101 | `POST /generate-broll`; reads current project from server directly; appends new V3 clips with `scale: 0.2, x: 0, y: 0`; saves to server; calls `loadProject()` |
| `handleRemoveDeadAir` | 1104–1166 | `POST /remove-dead-air` with `-26 dB` threshold and `0.4s` minimum silence; refreshes assets; updates V1 clip duration and potentially fixes stale `assetId` |
| `handleTranscribeAndAddCaptions` | 1169–1269 | Transcribes non-AI video on V1 with trim bounds; chunks words by `PAUSE_THRESHOLD = 0.7s` and `MAX_WORDS_PER_CHUNK = 5`; converts to clip-relative timestamps; calls `addCaptionClipsBatch` |
| `handleUpdateCaptionStyle` | 1272–1275 | Calls `updateCaptionStyle` then saves |
| `handleAddMotionGraphicFromPrompt` | 1278–1330 | `POST /render-motion-graphic` with template ID and props; adds to V2 at `startTime ?? currentTime`; switches to main tab |
| `handleCreateCustomAnimation` | 1333–1436 | `POST /generate-animation` with NDJSON streaming progress; finds video context from V1 clips; auto-places at `startTime`, or by parsing description for "intro"/"outro"; always adds to V2 |
| `handleAnalyzeForAnimation` | 1439–1475 | `POST /analyze-for-animation`; returns concept for caller approval |
| `handleRenderFromConcept` | 1478–1551 | `POST /render-from-concept`; places result on V2 at explicit `startTime`, or by type |
| `handleGenerateTranscriptAnimation` | 1554–1590 | `POST /generate-transcript-animation`; adds to V2 at `currentTime` |
| `handleGenerateBatchAnimations` | 1593–1632 | `POST /generate-batch-animations` with `count`; adds each returned animation to V2 at its planned position |
| `handleExtractAudio` | 1635–1684 | `POST /extract-audio`; refreshes assets; updates V1 clip to muted video; adds audio to A1 at same position |
| `handleCreateContextualAnimation` | 1687–1749 | `POST /generate-contextual-animation`; places intro at 0, outro at `getDuration()` |
| `handleExport` | 1752–1774 | Calls `renderProject(false, opts)`; triggers browser download |
| `handleEditAnimation` | 1777–1859 | `POST /edit-animation` with NDJSON streaming; calls `updateTabAsset` if `tabIdToUpdate` provided |
| `handleOpenAnimationInTab` | 1862–1881 | Creates a new timeline tab with a single V1 clip for the animation asset |

#### Effects

| Effect | Line | Trigger | Action |
|--------|------|---------|--------|
| Server check on mount | 145–147 | `[checkServer]` | Calls `checkServer()` |
| Load project on session | 150–155 | `[session, loadProject]` | Calls `loadProject()` when session becomes non-null |
| Timeline playback loop | 319–347 | `[isPlaying, duration]` | Starts `requestAnimationFrame` loop; increments `currentTime` by delta; stops at `duration` |
| Fetch transitions on session | 625–629 | `[session, fetchAvailableTransitions]` | Calls `fetchAvailableTransitions()` when session is set |

---

## `src/react-app/hooks/useProject.ts`

### Exported Interfaces / Types

#### `Asset` (line 8–19)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | UUID |
| `type` | `'video' \| 'image' \| 'audio'` | Media type |
| `filename` | `string` | Original filename |
| `duration` | `number` | Duration in seconds (0 for images) |
| `size` | `number` | File size in bytes |
| `width` | `number?` | Pixel width (video/image only) |
| `height` | `number?` | Pixel height (video/image only) |
| `thumbnailUrl` | `string \| null` | Absolute URL with `LOCAL_FFMPEG_URL` prefix |
| `streamUrl` | `string?` | URL with `?v=Date.now()` cache-busting appended by `refreshAssets`/`loadProject` |
| `aiGenerated` | `boolean?` | True for Remotion-rendered animations; used to deprioritize for animation context |

#### `TimelineClip` (line 22–41)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | UUID |
| `assetId` | `string` | References `Asset.id`; empty string `''` for caption clips |
| `trackId` | `string` | One of: `T1`, `V3`, `V2`, `V1`, `A1`, `A2` |
| `start` | `number` | Start position on timeline in seconds |
| `duration` | `number` | Visible duration in seconds (= `outPoint - inPoint`) |
| `inPoint` | `number` | Source in-point in seconds |
| `outPoint` | `number` | Source out-point in seconds |
| `transform.x` | `number?` | Horizontal offset (percentage units) |
| `transform.y` | `number?` | Vertical offset (percentage units) |
| `transform.scale` | `number?` | Scale factor (1.0 = 100%) |
| `transform.rotation` | `number?` | Rotation in degrees |
| `transform.opacity` | `number?` | Opacity 0–1 |
| `transform.cropTop` | `number?` | Crop from top (percentage) |
| `transform.cropBottom` | `number?` | Crop from bottom (percentage) |
| `transform.cropLeft` | `number?` | Crop from left (percentage) |
| `transform.cropRight` | `number?` | Crop from right (percentage) |

#### `Track` (line 44–49)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | `T1`, `V3`, `V2`, `V1`, `A1`, `A2` |
| `type` | `'video' \| 'audio' \| 'text'` | Track kind |
| `name` | `string` | Display label |
| `order` | `number` | Render order (0 = top/T1, 5 = bottom/A2) |

#### `CaptionWord` (line 52–56)

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | Word text |
| `start` | `number` | Relative to clip start (seconds) |
| `end` | `number` | Relative to clip start (seconds) |

#### `CaptionStyle` (line 59–78)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `fontFamily` | `string` | `'Inter'` | CSS font family |
| `fontSize` | `number` | `52` | Size in px |
| `fontWeight` | `'normal' \| 'bold' \| 'black'` | `'bold'` | Font weight |
| `color` | `string` | `'#FFFFFF'` | Text color |
| `textOpacity` | `number?` | `100` | 0–100 percentage |
| `backgroundColor` | `string?` | `'rgba(0,0,0,0.45)'` | Background box color |
| `backgroundEnabled` | `boolean?` | `true` | Toggle background box |
| `backgroundPadding` | `number?` | `100` | 0–200 percentage of base padding |
| `backgroundRadius` | `number?` | `10` | 0–100 percentage; 0=square, 100=oval |
| `backgroundOpacity` | `number?` | `45` | 0–100 percentage alpha |
| `strokeColor` | `string?` | `'#000000'` | Text outline color |
| `strokeWidth` | `number?` | `4` | Text outline width |
| `position` | `'bottom' \| 'center' \| 'top'` | `'bottom'` | Vertical base position |
| `positionX` | `number?` | `0` | -50 to 50 percentage offset from center |
| `positionY` | `number?` | `0` | -50 to 50 percentage offset from base |
| `animation` | `'none' \| 'karaoke' \| 'fade' \| 'pop' \| 'bounce' \| 'typewriter' \| 'highlight'` | `'fade'` | Animation style |
| `highlightColor` | `string?` | `'#FFD700'` | Color for highlight animation |
| `timeOffset` | `number?` | — | Sync offset in seconds (negative = earlier) |

#### `CaptionData` (line 81–84)

| Field | Type | Description |
|-------|------|-------------|
| `words` | `CaptionWord[]` | All words in the chunk |
| `style` | `CaptionStyle` | Rendering style for this chunk |

#### `ProjectSettings` (line 87–91)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `width` | `number` | `1920` | Canvas width in pixels |
| `height` | `number` | `1080` | Canvas height in pixels |
| `fps` | `number` | `30` | Frames per second |

#### `JunctionTransitionType` (line 94)

Union: `'none' \| 'crossfade' \| 'slide-left' \| 'slide-right' \| 'dip-to-black' \| 'custom'`

#### `JunctionTransition` (line 96–105) — Legacy v1

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | UUID |
| `fromClipId` | `string` | Source clip |
| `toClipId` | `string` | Destination clip |
| `type` | `JunctionTransitionType` | Transition kind |
| `durationSec` | `number` | Overlap duration in seconds |
| `easing` | `'linear' \| 'ease-in' \| 'ease-out' \| 'ease-in-out'?` | Easing function |
| `fallbackBehavior` | `'cut' \| 'clamp' \| 'crossfade'?` | Behavior when clips don't overlap |
| `customTransitionId` | `string?` | References custom `.tsx` transition |

#### `CustomTransitionMeta` (line 107–112)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Transition ID |
| `name` | `string` | Display name |
| `filename` | `string` | Filename of the `.tsx` file |
| `installedAt` | `string \| null` | ISO timestamp or null |

#### `TimelineTransition` (line 115–124) — V2

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | UUID |
| `startTime` | `number` | Absolute position on timeline (seconds) |
| `durationSec` | `number` | Duration of the transition effect |
| `fromClipId` | `string \| null` | Null = fade from black |
| `toClipId` | `string \| null` | Null = fade to black |
| `transitionFileId` | `string` | e.g. `'builtin-crossfade'`, `'builtin-dip-to-black'` |
| `easing` | `string?` | e.g. `'ease-in-out'` |
| `params` | `Record<string, number \| string \| boolean>` | Transition-specific parameters |

#### `ProjectState` (line 127–145)

| Field | Type | Description |
|-------|------|-------------|
| `tracks` | `Track[]` | Track definitions |
| `clips` | `TimelineClip[]` | All timeline clips |
| `settings` | `ProjectSettings` | Canvas settings |
| `captionData` | `Record<string, CaptionData>?` | Map of clipId → CaptionData |
| `transitions` | `JunctionTransition[]?` | Legacy v1 transitions |
| `timelineTransitions` | `TimelineTransition[]?` | V2 transitions |
| `brandTheme.name` | `string?` | — |
| `brandTheme.fontFamily` | `string?` | — |
| `brandTheme.accentColor` | `string?` | — |
| `brandTheme.secondaryColor` | `string?` | — |
| `brandTheme.backgroundColor` | `string?` | — |
| `brandTheme.textColor` | `string?` | — |
| `brandTheme.glow` | `number?` | — |
| `brandTheme.motionSpeed` | `number?` | — |
| `adTemplate` | `unknown?` | Reserved |

#### `TimelineTab` (line 148–155)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | UUID or `'main'` |
| `name` | `string` | Display name |
| `type` | `'main' \| 'clip'` | Tab kind |
| `assetId` | `string?` | For clip tabs, the animation asset being edited |
| `clips` | `TimelineClip[]` | Tab-local clip list |
| `timelineTransitions` | `TimelineTransition[]` | Tab-local transitions |

#### `SessionInfo` (line 158–162)

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Server-assigned session UUID |
| `name` | `string` | Project name (persisted to localStorage) |
| `createdAt` | `number` | `Date.now()` timestamp |

#### `RenderOptions` (line 209–231)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `presetId` | `string` | `'custom'` | Render preset identifier |
| `codec` | `VideoCodec` | `'h264'` | `h264 \| h265 \| vp8 \| vp9 \| av1 \| prores` |
| `audioCodec` | `AudioCodec` | `'aac'` | `aac \| mp3 \| pcm-16 \| opus` |
| `containerFormat` | `ContainerFormat` | `'mp4'` | `mp4 \| mkv \| webm \| mov` |
| `outputWidth` | `number` | `1920` | Output width in pixels |
| `outputHeight` | `number` | `1080` | Output height in pixels |
| `outputFps` | `number` | `30` | Output frames per second |
| `qualityMode` | `'crf' \| 'bitrate'` | `'crf'` | Quality control mode |
| `crf` | `number \| null` | `23` | Constant Rate Factor (null in bitrate mode) |
| `videoBitrate` | `string` | `'10M'` | Target video bitrate |
| `audioBitrate` | `string` | `'192k'` | Target audio bitrate |
| `sampleRate` | `number` | `48000` | Audio sample rate in Hz |
| `muted` | `boolean` | `false` | Strip audio from output |
| `hardwareAcceleration` | `HwAccelMode` | `'if-possible'` | `disable \| if-possible \| required` |
| `x264Preset` | `string` | `'fast'` | libx264 speed preset |
| `proResProfile` | `string` | `'hq'` | ProRes profile |
| `scale` | `number` | `1` | Output scale factor |
| `pixelFormat` | `string` | `'yuv420p'` | FFmpeg pixel format |
| `enableCustomFfmpegFlags` | `boolean` | `false` | Enable `customFfmpegFlags` |
| `customFfmpegFlags` | `string` | `''` | Raw FFmpeg flag string |
| `concurrency` | `number` | `4` | Remotion render concurrency |

### Exported Constants

| Name | Line | Value |
|------|------|-------|
| `defaultCaptionStyle` | 183–201 | Full `CaptionStyle` with defaults (see table above) |
| `defaultRenderOptions` | 233–255 | Full `RenderOptions` with defaults (see table above) |
| `SESSION_STORAGE_KEY` | 6 | `'hyperedit-session'` |
| `LOCAL_FFMPEG_URL` | 4 | `'http://localhost:3333'` |

### Exported Function: `useProject()` (line 257)

#### Internal State

| State | Type | Initial Value | Line |
|-------|------|---------------|------|
| `session` | `SessionInfo \| null` | `loadSessionFromStorage()` | 259 |
| `assets` | `Asset[]` | `[]` | 260 |
| `tracks` | `Track[]` | 6-track array (T1, V3, V2, V1, A1, A2) | 261–268 |
| `clips` | `TimelineClip[]` | `[]` | 269 |
| `transitions` | `JunctionTransition[]` | `[]` | 270 |
| `timelineTransitions` | `TimelineTransition[]` | `[]` | 271 |
| `captionData` | `Record<string, CaptionData>` | `{}` | 272 |
| `timelineTabs` | `TimelineTab[]` | `[{ id:'main', name:'Main', type:'main', clips:[], timelineTransitions:[] }]` | 275–277 |
| `activeTabId` | `string` | `'main'` | 278 |
| `settings` | `ProjectSettings` | `{ width:1920, height:1080, fps:30 }` | 280–284 |
| `loading` | `boolean` | `false` | 285 |
| `status` | `string` | `''` | 286 |
| `serverAvailable` | `boolean \| null` | `null` | 287 |
| `renderOptions` | `RenderOptions` | `defaultRenderOptions` | 288 |

#### Parallel Refs (anti-stale-closure pattern)

| Ref | Line | Synced with |
|-----|------|-------------|
| `saveTimeoutRef` | 290 | Save debounce timer |
| `tracksRef` | 293 | `tracks` state |
| `clipsRef` | 294 | `clips` state |
| `settingsRef` | 295 | `settings` state |
| `captionDataRef` | 296 | `captionData` state |
| `transitionsRef` | 297 | `transitions` state |
| `timelineTransitionsRef` | 298 | `timelineTransitions` state |
| `renderOptionsRef` | 299 | `renderOptions` state |

Refs are kept in sync via `useEffect` at lines 302–308 (one effect per ref).

#### Private Helper

| Function | Line | Description |
|----------|------|-------------|
| `loadSessionFromStorage()` | 165–180 | Reads `localStorage['hyperedit-session']` (after `migrateLegacySessionKey()` rolls any pre-rename pointer forward); migrates entries missing `name` field by injecting `'Untitled Project'` |

#### Methods Returned

| Method | Line | Signature | Description |
|--------|------|-----------|-------------|
| `setSession` | 311–321 | `(SessionInfo \| null \| updater) → void` | Wraps `setSessionInternal`; persists to / removes from localStorage |
| `checkServer` | 324–340 | `() → Promise<boolean>` | `GET /health` with 2s timeout; caches result in `serverAvailable` |
| `createSession` | 374–385 | `() → Promise<SessionInfo>` | Generates client-side temp UUID; returns `SessionInfo`; does NOT call server (session confirmed on first upload) |
| `uploadAsset` | 388–451 | `(file: File) → Promise<Asset>` | Creates session via `POST /session/create` if none exists; then `POST /session/{id}/assets`; appends to `assets` state |
| `deleteAsset` | 454–463 | `(assetId: string) → Promise<void>` | `DELETE /session/{id}/assets/{assetId}`; removes asset and all clips referencing it from state |
| `getAssetStreamUrl` | 466–469 | `(assetId: string) → string \| null` | Returns `/session/{id}/assets/{assetId}/stream` (no cache-busting) |
| `refreshAssets` | 472–510 | `() → Promise<Asset[]>` | `GET /session/{id}/assets`; appends `?v=Date.now()` to each `streamUrl`; replaces entire `assets` state; returns new array |
| `addClip` | 513–548 | `(assetId, trackId, start, duration?, inPoint?, outPoint?) → TimelineClip` | Creates clip; images default to 5s if no duration; appends to `clips` state |
| `updateClip` | 551–555 | `(clipId, updates: Partial<TimelineClip>) → void` | Merges partial updates into matching clip |
| `deleteClip` | 558–591 | `(clipId, ripple?: boolean) → void` | Removes clip; if `ripple=true`, shifts all subsequent clips on same track by `clip.duration`; cleans orphaned transitions from both v1 and v2 |
| `moveClip` | 594–603 | `(clipId, newStart, newTrackId?) → void` | Updates `start` (clamped to 0) and optionally `trackId` |
| `resizeClip` | 606–617 | `(clipId, newInPoint, newOutPoint) → void` | Recalculates `duration = newOutPoint - newInPoint` |
| `splitClip` | 620–677 | `(clipId, splitTime) → string \| null` | 0.05s guard at both edges; creates second clip; re-wires both v1 and v2 transitions from original clip to new second clip; returns new clip ID or null |
| `createTimelineTab` | 680–695 | `(name, assetId, initialClips?) → string` | Creates tab, appends to `timelineTabs`, switches `activeTabId`; returns new tab ID |
| `switchTimelineTab` | 698–700 | `(tabId) → void` | Sets `activeTabId` |
| `closeTimelineTab` | 703–713 | `(tabId) → void` | Cannot close `'main'`; switches to main if closing active tab |
| `updateTabClips` | 716–720 | `(tabId, clips) → void` | Replaces `clips` array in matching tab |
| `updateTabAsset` | 724–746 | `(tabId, newAssetId, newDuration) → void` | Updates all V1 clips in tab with new asset + duration; also updates `tab.assetId` |
| `getActiveTab` | 749–751 | `() → TimelineTab \| undefined` | Finds tab by `activeTabId` |
| `addCaptionClip` | 756–785 | `(words, start, duration, style?) → TimelineClip` | Creates T1 clip with empty `assetId`; stores data in `captionData` map |
| `addCaptionClipsBatch` | 788–823 | `(captions[]) → TimelineClip[]` | Single `setClips` + `setCaptionData` call for all captions (performance) |
| `updateCaptionStyle` | 826–838 | `(clipId, styleUpdates) → void` | Merges partial style into existing `captionData[clipId].style` |
| `getCaptionData` | 841–843 | `(clipId) → CaptionData \| null` | Reads from `captionData` map |
| `addLegacyTransition` | 846–870 | `(fromClipId, toClipId, type?, durationSec?, customTransitionId?) → JunctionTransition` | Upserts (deduplicates by from+to pair) into `transitions` |
| `addTransition` | 873–894 | `(fromClipId, toClipId, transitionFileId, startTime, durationSec?, params?, easing?) → TimelineTransition` | Appends to `timelineTransitions` |
| `updateTransition` | 897–904 | `(transitionId, updates) → void` | Merges partial updates into matching v2 transition |
| `removeTransition` | 907–909 | `(transitionId) → void` | Filters matching v2 transition from state |
| `updateTabTransitions` | 912–916 | `(tabId, newTransitions) → void` | Replaces `timelineTransitions` array in matching tab |
| `saveProject` | 920–949 | `() → Promise<void>` | Debounced (500ms): `PUT /session/{id}/project` using refs (not stale state). **Auto-save is disabled** (commented out at lines 1194–1200) |
| `saveProjectImmediate` | 952–978 | `() → Promise<void>` | Non-debounced save; cancels any pending debounce; used before session switch |
| `resetProjectState` | 981–997 | `() → void` | Cancels pending save; resets all state to defaults; used during session switch |
| `loadProject` | 1000–1053 | `() → Promise<void>` | Fetches assets + project from server; **deliberately does NOT load `tracks`** (always uses client defaults to avoid outdated server data, line 1042); merges `renderOptions` with `defaultRenderOptions` |
| `renderProject` | 1057–1116 | `(preview?, exportRenderOptions?) → Promise<string>` | Saves project via refs; `POST /session/{id}/render`; streams NDJSON progress; returns download URL |
| `getDuration` | 1119–1122 | `() → number` | `max(clip.start + clip.duration)` across `clips`; reads live `clips` state |
| `createGif` | 1125–1176 | `(sourceAssetId, options?) → Promise<Asset>` | `POST /session/{id}/create-gif`; appends result to `assets` |
| `closeSession` | 1179–1192 | `() → Promise<void>` | `DELETE /session/{id}`; clears state |

---

## `src/react-app/hooks/useFFmpeg.ts`

### State

| State | Type | Initial | Line |
|-------|------|---------|------|
| `loaded` | `boolean` | `false` | 8 |
| `loading` | `boolean` | `false` | 9 |
| `processing` | `boolean` | `false` | 10 |
| `progress` | `number` | `0` | 11 |
| `status` | `string` | `''` | 12 |
| `useLocalServer` | `boolean \| null` | `null` | 13 |

### Refs

| Ref | Line | Description |
|-----|------|-------------|
| `ffmpegRef` | 14 | Holds the `FFmpeg` WASM instance |

### Methods

| Method | Line | Description |
|--------|------|-------------|
| `checkLocalServer` | 17–35 | `GET /health` with 1s timeout; caches in `useLocalServer`; returns boolean |
| `load` | 37–98 | If local server available, sets `loaded=true` and returns `null` (no WASM needed); otherwise downloads `@ffmpeg/core@0.12.6` from unpkg CDN and initializes WASM instance |
| `isDeadAirRemovalCommand` (private) | 101–108 | Returns true if command starts with `'REMOVE_DEAD_AIR'` or contains `'silenceremove'` or `'silence'` + `'remove'`/`'dead air'` |
| `removeDeadAirLocal` | 111–167 | `POST /remove-dead-air` (non-session endpoint); reads `X-Removed-Duration`, `X-Original-Duration`, `X-New-Duration` response headers; returns blob URL |
| `processVideoLocal` | 170–216 | Checks `isDeadAirRemovalCommand` and delegates; otherwise `POST /process` with file + command; returns blob URL |
| `processVideo` | 218–323 | Primary export method: prefers local server; falls back to WASM; loads WASM via `load()` if needed; uses `parseFFmpegArgs` to split command string |
| `generateChapters` | 326–373 | `POST /generate-chapters` (non-session endpoint) with video file; returns `{ chapters, youtubeFormat, summary, videoDuration }` |

### Private Helper

| Function | Line | Description |
|----------|------|-------------|
| `parseFFmpegArgs(command)` | 388–418 | Splits FFmpeg command string into args array, correctly handling single- and double-quoted strings |

### Return Value

```
{ loaded, loading, processing, progress, status, load, processVideo, generateChapters }
```

---

## `src/react-app/hooks/useVideoSession.ts`

### Internal Interfaces (not exported)

#### `SessionInfo` (line 5–11)

| Field | Type |
|-------|------|
| `sessionId` | `string` |
| `duration` | `number` |
| `size` | `number` |
| `name` | `string` |
| `editCount` | `number` |

#### `ChapterResult` (line 13–18)

| Field | Type |
|-------|------|
| `chapters` | `Array<{ start: number; title: string }>` |
| `youtubeFormat` | `string` |
| `summary` | `string` |
| `videoDuration` | `number` |

### State

| State | Type | Initial | Line |
|-------|------|---------|------|
| `session` | `SessionInfo \| null` | `null` | 21 |
| `processing` | `boolean` | `false` | 22 |
| `status` | `string` | `''` | 23 |
| `serverAvailable` | `boolean \| null` | `null` | 24 |

### Refs

| Ref | Line | Description |
|-----|------|-------------|
| `uploadAbortRef` | 25 | `AbortController` for cancellable upload |

### Methods

| Method | Line | Description |
|--------|------|-------------|
| `checkServer` | 28–44 | `GET /health` with 2s timeout; caches in `serverAvailable` |
| `uploadVideo` | 47–104 | Deletes existing session first (if any); `POST /session/upload` with `AbortController` support; sets `session` state |
| `getStreamUrl` | 107–110 | Returns `/session/{id}/stream` or null |
| `processVideo` | 113–153 | `POST /session/{id}/process` with FFmpeg command; updates `session` with new duration/size/editCount |
| `removeDeadAir` | 156–207 | `POST /session/{id}/remove-dead-air`; updates `session` |
| `generateChapters` | 210–240 | `POST /session/{id}/chapters`; returns `ChapterResult` |
| `downloadVideo` | 243–259 | Creates anchor element with `/session/{id}/download` href; triggers browser download |
| `refreshSession` | 262–287 | `GET /session/{id}/info`; clears `session` on 404 |
| `closeSession` | 290–297 | `DELETE /session/{id}`; clears `session` state |
| `cancelUpload` | 300–304 | Aborts the upload `AbortController` |

### Return Value

```
{ session, processing, status, serverAvailable, checkServer, uploadVideo, getStreamUrl,
  processVideo, removeDeadAir, generateChapters, downloadVideo, refreshSession,
  closeSession, cancelUpload }
```

**Note**: In `Home.tsx`, only `session`, `processing`, `status`, and `generateChapters` are destructured (lines 138–142). The rest of the legacy session API is unused in the current UI.

---

## `src/react-app/hooks/useSessionManager.ts`

### Exported Interface

#### `SessionSummary` (line 6–12)

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `string` | Session UUID |
| `name` | `string` | Project name |
| `createdAt` | `number` | Unix timestamp (ms) |
| `assetCount` | `number` | Number of assets in session |
| `clipCount` | `number` | Number of clips in project |

### Input Options Interface: `UseSessionManagerOptions` (line 14–20)

| Field | Type |
|-------|------|
| `currentSession` | `SessionInfo \| null` |
| `saveProjectImmediate` | `() => Promise<void>` |
| `setSession` | `(s: SessionInfo \| null) => void` |
| `resetProjectState` | `() => void` |
| `resetLocalState` | `() => void` |

### State

| State | Type | Initial | Line |
|-------|------|---------|------|
| `sessions` | `SessionSummary[]` | `[]` | 29 |
| `isLoading` | `boolean` | `false` | 30 |
| `isSwitching` | `boolean` | `false` | 31 |
| `error` | `string \| null` | `null` | 32 |

### Methods

| Method | Line | Description |
|--------|------|-------------|
| `fetchSessions` | 34–50 | `GET /sessions` with 3s timeout; populates `sessions` |
| `renameSession` | 52–79 | Optimistic update; `PATCH /session/{id}/name`; reverts via `fetchSessions` on failure |
| `switchToSession` | 81–103 | Guards against re-entrant switch; calls `saveProjectImmediate` → `resetProjectState` → `resetLocalState` → `setSession` |
| `deleteSession` | 105–117 | Guards: cannot delete current session; `DELETE /session/{id}`; refreshes list |
| `createAndSwitch` | 119–149 | Saves current session; `POST /session/create`; resets state; sets new session |

### Return Value

```
{ sessions, isLoading, isSwitching, error, fetchSessions, renameSession,
  switchToSession, deleteSession, createAndSwitch }
```

---

## `src/react-app/hooks/useDeliverables.ts`

### Exported Interface

#### `RenderItem` (line 5–16)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Filename-based ID |
| `filename` | `string` | Original filename on disk |
| `title` | `string` | User-editable display name |
| `createdAt` | `number \| null` | Unix timestamp (ms) or null |
| `fileSize` | `number` | Size in bytes |
| `duration` | `number \| null` | Duration in seconds or null |
| `codec` | `string \| null` | Video codec string or null |
| `containerFormat` | `string \| null` | Container format or null |
| `thumbnailUrl` | `string \| null` | Thumbnail URL or null |
| `downloadUrl` | `string` | Full download URL |

### State

| State | Type | Initial | Line |
|-------|------|---------|------|
| `renders` | `RenderItem[]` | `[]` | 19 |
| `selectedIds` | `string[]` | `[]` | 20 |
| `loading` | `boolean` | `false` | 21 |
| `error` | `string \| null` | `null` | 22 |
| `pendingDelete` | `string[] \| null` | `null` | 23 |

### Methods

| Method | Line | Description |
|--------|------|-------------|
| `fetchRenders` | 25–41 | `GET /session/{id}/renders`; replaces `renders` state; prunes `selectedIds` of IDs no longer in list |
| `deleteRenders` | 43–53 | Loops and `DELETE /session/{id}/renders/{encodeURIComponent(id)}` for each; then calls `fetchRenders` |
| `renameRender` | 55–62 | Optimistic update to `renders`; `PATCH /session/{id}/renders/{id}/name` |
| `toggleSelect` | 64–66 | Adds/removes ID from `selectedIds` |
| `clearSelection` | 68 | Sets `selectedIds = []` |
| `totalSelectedSize` | 70–73 | `useMemo`: sum of `fileSize` for all `selectedIds` in `renders` |

### Return Value

```
{ renders, selectedIds, loading, error, pendingDelete, fetchRenders, deleteRenders,
  renameRender, toggleSelect, clearSelection, totalSelectedSize, setPendingDelete }
```

---

## Data Flow

```text
1. STARTUP
   main.tsx → App.tsx → Home.tsx mounts
   └── useProject() reads localStorage['hyperedit-session']
         ├── session found: validateSession (GET /project) → 404 clears it
         └── session valid: loadProject() fetches assets + project data

2. ASSET UPLOAD
   User drops file → handleAssetUpload → uploadAsset(file)
     ├── No session: POST /session/create → creates SessionInfo
     ├── POST /session/{id}/assets → server returns Asset metadata
     └── setAssets([...prev, newAsset]) → React re-render

3. CLIP PLACEMENT
   Timeline drag → handleDropAsset(asset, trackId, time)
     ├── Redirects audio ↔ video tracks
     ├── Main tab: addClip(assetId, trackId, time, duration)
     │     └── setClips([...prev, newClip])
     └── Edit tab: updateTabClips(tabId, [...tab.clips, newClip])

4. PLAYBACK
   handlePlayPause → setIsPlaying(true)
     └── useEffect [isPlaying, duration] starts requestAnimationFrame loop
           ├── Each frame: setCurrentTime(prev + delta)
           ├── getPreviewLayers() computes layers from activeClips + currentTime
           └── VideoPreview renders layers

5. CAPTION WORKFLOW
   handleTranscribeAndAddCaptions()
     └── POST /session/{id}/transcribe (with V1 clip inPoint/outPoint trim)
           └── words[] → chunk by PAUSE_THRESHOLD=0.7s / MAX_WORDS_PER_CHUNK=5
                 └── addCaptionClipsBatch(captionsToAdd)
                       ├── setClips([...prev, ...newClips])
                       └── setCaptionData({ ...prev, [clipId]: { words, style } })

6. SAVE
   saveProject() → debounced 500ms → PUT /session/{id}/project
     Payload uses refs, not state:
       { tracks, clips, settings, captionData, transitions,
         timelineTransitions, renderOptions }

7. RENDER / EXPORT
   handleExport(opts) → renderProject(false, opts)
     ├── PUT /session/{id}/project (sync via refs)
     ├── POST /session/{id}/render
     │     └── NDJSON stream → setStatus(`Rendering: X%...`)
     └── returns download URL → browser anchor click

8. SESSION SWITCH
   useSessionManager.switchToSession(summary)
     ├── saveProjectImmediate() (non-debounced PUT)
     ├── resetProjectState() (clears all useProject state)
     ├── resetLocalState()   (clears Home.tsx useState)
     └── setSession(newSession) → triggers loadProject() via useEffect
```

---

## Connections

- [[ffmpeg-server]] — all network calls target `localhost:3333`; session IDs tie frontend state to server-side `/tmp/hyperedit-ffmpeg/sessions/{id}/`
- [[remotion-templates]] — `handleAddMotionGraphicFromPrompt` sends `templateId` to server's `render-motion-graphic` endpoint; `DynamicAnimation` composition is what `generate-animation` renders
- [[timeline-component]] — `Home.tsx` is the sole consumer of the `Timeline` component; all event handlers (`onMoveClip`, `onResizeClip`, `onDeleteClip`, etc.) are defined here
- [[video-preview]] — `getPreviewLayers()` computes the layer array fed to `VideoPreview`; `handleLayerMove` / `handleLayerSelect` receive events back
- [[ai-prompt-panel]] — all AI action handlers (`handleCreateCustomAnimation`, `handleTranscribeAndAddCaptions`, etc.) are passed as props to `AIPromptPanel`
- [[session-manager-component]] — `useSessionManager` is consumed by the `SessionManager` UI component rendered in the header

---

## Known Issues

### Auto-save Disabled

Auto-save on clip changes is commented out at `useProject.ts:1194–1200`:

```ts
// Note: This is commented out to prevent excessive saves during drag operations
// useEffect(() => {
//   if (session && clips.length > 0) {
//     saveProject();
//   }
```

Saves must be explicitly triggered by calling `saveProject()` at the end of handlers. Any operation that forgets to call `saveProject()` after mutating clip state will silently lose changes on page refresh.

### Two Parallel Session Systems

`useProject` and `useVideoSession` maintain independent session objects (`SessionInfo` types with different shapes — the legacy one includes `duration`, `size`, `editCount` fields not in the modern one). In `Home.tsx`, `useVideoSession` is used exclusively for `generateChapters` (line 142); all other operations use `useProject`. The legacy `uploadVideo` / `processVideo` / `removeDeadAir` / `downloadVideo` / `refreshSession` / `closeSession` / `cancelUpload` methods from `useVideoSession` are not connected to any UI in `Home.tsx`.

### Tracks Never Loaded from Server

`loadProject` deliberately skips the `tracks` field in the server response (line 1042 comment, enforced by the `if (data.clips)` pattern that has no corresponding `if (data.tracks)`). If the server stores stale or different track definitions, they are silently ignored. The 6-track array is always initialized client-side.

### `handleChapterCuts` and `handleGenerateBroll` Bypass React State

Both functions read the current project directly from the server (`GET /session/{id}/project`) and write back (`PUT /session/{id}/project`) to avoid React state batching issues, then call `loadProject()` to sync. This means these operations are not atomic with other in-flight state changes.

### `useFFmpeg` WASM Fallback Is Partially Broken

The `load()` method polls `ffmpegRef.current && loading` in a tight `setTimeout(resolve, 100)` busy-wait (lines 48–52). If `loading` is true but `ffmpegRef.current` is set concurrently this loop would run indefinitely in theory. In practice the local server is always expected, so the WASM path is rarely exercised.

### `useDeliverables` Is Not Connected in `Home.tsx`

`useDeliverables` is a standalone hook not imported or used anywhere in `Home.tsx`. It is presumably consumed by a separate render gallery page or modal component not covered in this document set.

### `splitClip` Reads Stale `clips` State

`splitClip` (line 620) uses the `clips` state captured in its `useCallback` dependency array. If called rapidly in sequence (e.g., `handleCutAtPlayhead` iterates over `clipsAtPlayhead`), later calls may not see clips added by earlier calls within the same event handler. This is documented indirectly by `handleChapterCuts` working around it by reading from the server.

### `createSession()` Is Dead Code

`createSession` (lines 374–385) generates a UUID client-side but is never called; actual session creation happens inside `uploadAsset` via `POST /session/create`. It remains in the return value but has no callers in the codebase.
