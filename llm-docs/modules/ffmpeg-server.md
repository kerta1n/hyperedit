---
title: Local FFmpeg Server
type: module
source_files:
  - scripts/local-ffmpeg-server.js
  - scripts/hw-detect.js
  - scripts/hwaccel-config.js
  - scripts/whisper-transcribe.py
tags: [backend, ffmpeg, remotion, sessions, transcription, rendering, ai, hardware-acceleration]
---

## Overview

The local FFmpeg server is HyperEdit's primary execution engine. It runs as a standalone Node.js `http.createServer` process on **port 3333** — no framework, regex-based route dispatch. All video processing, asset management, Remotion rendering, Whisper transcription, and fal.ai calls flow through it. The Cloudflare Worker generates FFmpeg commands via LLM but never executes them; this server does.

The server depends on two satellite modules:

- **`hw-detect.js`** — one-time hardware capability probe (GPU, FFmpeg encoders, CPU/RAM)
- **`hwaccel-config.js`** — translates capabilities + env toggles into concrete Remotion/FFmpeg options

Startup sequence: load `.dev.vars` → `detectCapabilities()` → restore sessions from disk → `server.listen(3333)`.

```text
┌─────────────────────────────────────────────────────────┐
│                 local-ffmpeg-server.js                  │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │ Sessions │  │  hw-detect   │  │  hwaccel-config   │ │
│  │  Map<>   │  │ (one-shot,   │  │ getRenderMedia    │ │
│  │ + disk   │  │  cached)     │  │ getFFmpegEncode   │ │
│  └────┬─────┘  └──────┬───────┘  └────────┬──────────┘ │
│       │               │                   │             │
│  ┌────▼───────────────▼───────────────────▼──────────┐  │
│  │          http.createServer (port 3333)             │  │
│  │   regex dispatch → handler functions               │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         │                    │                   │
   System FFmpeg          Remotion CLI       fal.ai / Gemini
   (GPU encoders)         renderMedia()      (AI generation)
```

---

## Key Components

### Constants & Configuration

| Constant | Line | Value / Notes |
|---|---|---|
| `PORT` | 178 | `3333` |
| `TEMP_DIR` | 179–181 | `join(HYPEREDIT_TEMP_DIR \|\| tmpdir(), 'hyperedit-ffmpeg')` |
| `SESSIONS_DIR` | 182 | `join(TEMP_DIR, 'sessions')` — override via `HYPEREDIT_SESSIONS_DIR` |
| `RENDER_STEM_RE` | 2888 | `/^export-\d+$/` — validates render stem in URL |
| `RENDER_FILE_RE` | 2889 | `/^export-\d+\.(mp4\|webm\|mkv\|mov)$/` — validates render filename |
| `activeRenders` | 2890 | `new Set()` — tracks in-progress renders to block concurrent deletes |
| `DEFAULT_PROJECT_TRACKS` | 392–399 | T1 (text), V3 (video), V2 (video), V1 (video), A1 (audio), A2 (audio) |
| `DEFAULT_BRAND_THEME` | 401–410 | Inter font, `#f97316` accent, `#22d3ee` secondary, `#0a0a0a` background |
| `KNOWN_KEYWORDS` | 3230–3248 | Hardcoded list of tech brand/person names for keyword extraction |
| `CUSTOM_TRANSITIONS_DIR` | 8247 | `join(cwd(), 'src/remotion/transitions/custom')` |
| `TRANSITION_IMPORT_WHITELIST` | 8248 | `['remotion', '@remotion/shapes', 'react']` |

**Environment variables (read from `.dev.vars`):**

| Variable | Module | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | server | — | Google GenAI SDK; also used as LLM provider |
| `OPENAI_API_KEY` | server | — | OpenAI Whisper API fallback |
| `OPENAI_API_BASE_URL` | server | — | OpenAI-compatible LLM endpoint |
| `FAL_API_KEY` | server | — | Aliased to `FAL_KEY` at line 49 for fal.ai SDK |
| `GIPHY_API_KEY` | server | — | GIPHY search/trending |
| `HYPEREDIT_TEMP_DIR` | server | `os.tmpdir()` | Override base temp directory |
| `HYPEREDIT_SESSIONS_DIR` | server | `TEMP_DIR/sessions` | Override sessions directory |
| `WHISPER_MODEL` | server | `base` | Whisper model size (tiny/base/small/medium/large/turbo) |
| `WHISPER_MODEL_DIR` | server | — | Pre-downloaded model directory |
| `WHISPER_CONDITION_ON_PREV_TEXT` | server | `true` | Pass `--no-condition-on-previous-text` when `false` |
| `HWACCEL_REMOTION` | hwaccel-config | `true` | Enable Remotion HW options (VideoToolbox on macOS only) |
| `HWACCEL_FFMPEG` | hwaccel-config | `true` | Enable GPU encoder for system FFmpeg spawns |
| `HWACCEL_HEADFUL` | hwaccel-config | auto | `true` on Windows/macOS, `false` on Linux |

---

### Session Object Structure (lines 505–517)

```js
{
  id,           // UUID
  dir,          // SESSIONS_DIR/{id}/
  assetsDir,    // dir/assets/
  rendersDir,   // dir/renders/
  currentVideo, // path to current.mp4 (legacy)
  originalName,
  createdAt,
  editCount,
  assets: Map<assetId, Asset>,
  project: ProjectState,
  transcriptCache: Map,       // in-memory; prevents re-transcription
  customTransitions: Map,     // in-memory; records this session's custom uploads
}
```

### Asset Object Structure (lines 1957–1968)

```js
{
  id, type, filename, path, thumbPath,
  duration, size, width, height, createdAt,
  // optional:
  aiGenerated, description, sceneCount, sceneDataPath, editCount,
  sourceAssetId, isMuted, transcriptAnimation, contextual, animationType,
}
```

---

### Startup & Infrastructure Functions

| Function | Line | Description |
|---|---|---|
| `loadEnvVars()` | 22 | Reads `.dev.vars` key=value pairs into `process.env` |
| `cleanupStaleTempFiles()` | 205 | Deletes 0-byte or files older than 12 h from `TEMP_DIR` |
| `restoreSessionsFromDisk()` | 228 | Walks `SESSIONS_DIR` on startup; re-populates `sessions` Map |
| `saveSessionMeta()` | 479 | Writes `session-meta.json` (name + createdAt) |
| `saveAssetMetadata()` | 361 | Writes `assets-meta.json` (persists aiGenerated, duration, editCount) |

### Session Management Functions

| Function | Line | Description |
|---|---|---|
| `createSession(originalName)` | 492 | Creates dir structure, returns session object |
| `getSession(sessionId)` | 524 | Lookup in `sessions` Map |
| `cleanupSession(sessionId)` | 528 | Deletes session dir + removes from Map |
| `createDefaultProjectState()` | 412 | Returns project with `DEFAULT_PROJECT_TRACKS` |
| `ensureProjectDefaults(project)` | 428 | Fills missing fields on loaded project |
| `serializeProjectForClient(project)` | 453 | Converts Maps to arrays for JSON response |
| `getSessionAssetsAsArray(session)` | 468 | Returns `[...session.assets.values()]` |

### FFmpeg Utility Functions

| Function | Line | Description |
|---|---|---|
| `runFFmpeg(args, jobId, {timeout})` | 553 | Spawns ffmpeg, logs progress; optional SIGKILL timeout |
| `streamRender(res, renderFn)` | 595 | Writes NDJSON progress events; final `{type:'result'}` or `{type:'error'}` |
| `runFFmpegProbe(args, jobId)` | 626 | Spawns ffprobe, returns stdout |
| `detectSilence(inputPath, jobId, options)` | 652 | Runs `silencedetect` filter; parses stderr output |
| `getVideoDuration(inputPath)` | 695 | `execSync` + ffprobe; returns seconds |
| `calculateKeepSegments(silencePeriods, totalDuration, minSegmentDuration)` | 709 | Returns non-silent time ranges |
| `generateThumbnail(inputPath, outputPath, isImage)` | 1850 | 160×90 JPEG; 15 s timeout |
| `getMediaInfo(inputPath)` | 1875 | Returns `{width, height, duration}` via ffprobe JSON |
| `parseFFmpegArgs(command)` | 889 | Shell-like quote-aware tokenizer for command strings |

### LLM Abstraction Functions

| Function | Line | Description |
|---|---|---|
| `getLLMProvider()` | 56 | Returns `'google'`, `'openai'`, or `null` |
| `hasLLMProvider()` | 65 | Boolean check |
| `callOpenAICompat(messages, options)` | 70 | `fetch` to `OPENAI_API_BASE_URL/chat/completions` |
| `callGeminiSDK(contents, options)` | 105 | Google GenAI SDK wrapper |
| `generateWithLLM(prompt, options)` | 140 | Unified entry point routing to Google or OpenAI |
| `parseLLMJson(text)` | 164 | Tries direct parse → markdown fence strip → regex extraction |

### Transcription Functions

| Function | Line | Description |
|---|---|---|
| `transcribeVideo(videoPath, jobId)` | 3303 | Uses **OpenAI Whisper API** (not local Python) |
| `extractKeywordsFromTranscript(transcript, words)` | 3251 | Matches against `KNOWN_KEYWORDS` list |
| `tryPythonWhisper(cmd)` | 3604 | Tests if `import whisper` works for a given python binary |
| `checkLocalWhisper()` | 3616 | Tries `python3` then `python`; caches result in `_pythonCmd` |
| `runLocalWhisper(audioPath, jobId)` | 3632 | Spawns `whisper-transcribe.py`; reads JSON from stdout |
| `getOrTranscribeVideo(session, videoAsset, jobId)` | 3695 | Checks `session.transcriptCache` before transcribing |
| `getTranscriptSegment(transcription, startTime, endTime)` | 3809 | Slices word list to a time window |
| `extractNumericValue(valueStr)` | 3827 | Parses `"$10K+"`, `"50%"`, `"2.5M"` for counting animations |

### Rendering Functions

| Function | Line | Description |
|---|---|---|
| `buildSessionRemotionSpec(session, sessionId, options)` | 2252 | `timelineToRemotionSpec` → `normalizeSpec`; used by GET endpoint |
| `saveSpecSnapshot(session, filename, spec)` | 2273 | Writes spec JSON to session dir |
| `parseIncomingRemotionSpec(spec, source)` | 2279 | Validates/normalizes externally-supplied spec |
| `sendSpecValidationError(res, error)` | 2283 | Returns HTTP 422 |

### Custom Transitions Functions

| Function | Line | Description |
|---|---|---|
| `detectExportStyle(code)` | 8250 | Returns `{style:'default'}` or `{style:'named', name}` |
| `validateTransitionCode(code)` | 8258 | Checks exports, remotion import, whitelist; returns `{valid, errors, warnings}` |
| `regenerateBarrelFile()` | 8293 | Rewrites `custom/index.ts` from all `.tsx` files in `CUSTOM_TRANSITIONS_DIR` |
| `extractTransitionMeta(code)` | 8475 | Static regex extraction of `meta.name` / `meta.description` |
| `extractTransitionParams(code)` | 8488 | Static regex extraction of `params` schema object |

---

## HTTP Endpoints

All endpoints are on `localhost:3333`. CORS headers (`*`) are set on every response.

### Top-Level / Legacy Routes

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| `GET` | `/sessions` | `handleSessionList` (1226) | List all active sessions |
| `POST` | `/process` | `handleProcess` (924) | Legacy: multipart upload + FFmpeg command string |
| `POST` | `/remove-dead-air` | `handleRemoveDeadAir` (739) | Legacy: multipart upload, filter_complex trim+concat |
| `POST` | `/generate-chapters` | `handleGenerateChapters` (1051) | Legacy: multipart upload → extract audio → Gemini |
| `GET` | `/hwaccel-info` | `getAccelSummary()` (hwaccel-config:181) | Diagnostic JSON of caps + effective settings |
| `GET` | `/health` | inline | Returns `{status:'ok', sessions: N}` |

### Session Lifecycle

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| `POST` | `/session/create` | `handleSessionCreate` (1284) | Returns `{sessionId}` |
| `POST` | `/session/upload` | `handleSessionUpload` (1305) | Legacy single-video upload |
| `PATCH` | `/session/:id/name` | `handleSessionRename` (1242) | Renames session; updates `session-meta.json` |
| `DELETE` | `/session/:id` | `handleSessionDelete` (1841) | Removes session dir + Map entry |

### Session Info & Legacy Single-Video

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| `GET` | `/session/:id/stream` | `handleSessionStream` (1349) | Range-request for `current.mp4` |
| `GET` | `/session/:id/info` | `handleSessionInfo` (1396) | Returns video info + edit count |
| `GET` | `/session/:id/download` | `handleSessionDownload` (1810) | Downloads `current.mp4` |
| `POST` | `/session/:id/process` | `handleSessionProcess` (1425) | In-place FFmpeg edit on `current.mp4` |
| `POST` | `/session/:id/remove-dead-air` | `handleSessionRemoveDeadAir` (1490) | Segment extract+concat approach |
| `POST` | `/session/:id/chapters` | `handleSessionChapters` (1646) | Chapter generation via Gemini |

### Assets

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| `POST` | `/session/:id/assets` | `handleAssetUpload` (1894) | 10 GB limit; auto-generates thumbnail; detects type from extension |
| `GET` | `/session/:id/assets` | `handleAssetList` (1998) | Returns array of all assets |
| `DELETE` | `/session/:id/assets/:assetId` | `handleAssetDelete` (2023) | Also removes all clips using that asset |
| `GET` | `/session/:id/assets/:assetId/thumbnail` | `handleAssetThumbnail` (2060) | Serves 160×90 JPEG |
| `GET` | `/session/:id/assets/:assetId/stream` | `handleAssetStream` (2089) | Range-request support; MIME from extension |

### Project State

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| `GET` | `/session/:id/project` | `handleProjectGet` (2183) | Returns serialized `ProjectState` |
| `PUT` | `/session/:id/project` | `handleProjectSave` (2207) | Writes `project.json` |

### Remotion Spec & Rendering

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| `GET` | `/session/:id/remotion-spec` | `handleGetRemotionSpec` (2294) | Builds normalized spec from current project |
| `POST` | `/session/:id/remotion-spec/variants` | `handleGenerateRemotionVariants` (2324) | Calls `generateAdVariants` via LLM |
| `POST` | `/session/:id/render` | `handleProjectRenderRemotion` (2715) | **Primary render path** — Remotion Node API; streams NDJSON progress; generates thumbnail for non-preview exports |
| `POST` | `/session/:id/render-from-spec` | `handleRenderFromSpec` (2468) | Renders from externally-supplied spec JSON |
| `POST` | `/session/:id/render-variants` | `handleRenderVariants` (2385) | `renderVariantBatch` + `scoreVariantBatch` |
| `POST` | `/session/:id/render-ffmpeg` | `handleProjectRender` (2540) | **Legacy** FFmpeg filter_complex compositor; builds black base + overlay pipeline |

### Render Gallery

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| `GET` | `/session/:id/renders` | `handleListRenders` (2892) | Lists all `export-N.*` files in `rendersDir` |
| `DELETE` | `/session/:id/renders/:stem` | `handleDeleteRender` (2940) | Returns 409 if render in `activeRenders` |
| `PATCH` | `/session/:id/renders/:stem/name` | `handleRenameRender` (2974) | Updates spec JSON title; validates with `RENDER_STEM_RE` |
| `GET` | `/session/:id/renders/:stem/thumbnail` | `handleRenderThumbnail` (3006) | Serves thumbnail JPEG |
| `GET` | `/session/:id/renders/:filename/download` | `handleRenderFileDownload` (3030) | Validated with `RENDER_FILE_RE` |
| `GET` | `/session/:id/renders/:type` | `handleRenderDownload` (2837) | Download by type string (e.g. `preview`, `export`) |

### GIF & GIPHY

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| `POST` | `/session/:id/create-gif` | `handleCreateGif` (3066) | Effects: pulse, zoom, rotate, bounce, fade, shake |
| `GET` | `/session/:id/giphy/search` | `handleGiphySearch` (3470) | Proxies GIPHY search API |
| `GET` | `/session/:id/giphy/trending` | `handleGiphyTrending` (3512) | Proxies GIPHY trending |
| `POST` | `/session/:id/giphy/add` | `handleGiphyAdd` (3546) | Downloads GIF and registers as session asset |

### Transcription

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| `POST` | `/session/:id/transcribe` | `handleTranscribe` (3894) | Cascade: local Whisper → OpenAI API → Gemini |
| `POST` | `/session/:id/transcribe-and-extract` | `handleTranscribeAndExtract` (4220) | Transcribe + keyword extract + GIPHY download |

### AI Generation

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| `POST` | `/session/:id/generate-broll` | `handleGenerateBroll` (4416) | B-roll images via Gemini image generation |
| `POST` | `/session/:id/render-motion-graphic` | `handleRenderMotionGraphic` (4669) | **PLACEHOLDER** — uses FFmpeg `drawtext`, not Remotion. Disabled/incomplete. See line 4669. |
| `POST` | `/session/:id/generate-animation` | `handleGenerateAnimation` (4766) | LLM → scene JSON → `renderDynamicAnimation`; streams NDJSON progress |
| `POST` | `/session/:id/analyze-for-animation` | `handleAnalyzeForAnimation` (6844) | Returns concept JSON without rendering (approval workflow) |
| `POST` | `/session/:id/render-from-concept` | `handleRenderFromConcept` (7175) | Renders pre-approved concept; skips analysis step |
| `POST` | `/session/:id/generate-contextual-animation` | `handleGenerateContextualAnimation` (7646) | Transcribes video first, then generates relevant animation |
| `POST` | `/session/:id/generate-transcript-animation` | `handleGenerateTranscriptAnimation` (7337) | Kinetic typography from speech; local Whisper → OpenAI → Gemini cascade |
| `POST` | `/session/:id/edit-animation` | `handleEditAnimation` (5416) | Modifies original scene data in-place; reuses same asset ID |
| `POST` | `/session/:id/generate-batch-animations` | `handleGenerateBatchAnimations` (6577) | Batch animations across timeline |
| `POST` | `/session/:id/generate-image` | `handleGenerateImage` (5784) | Picasso — fal.ai `nano-banana-pro`; prompt enhanced by LLM |
| `POST` | `/session/:id/generate-video` | `handleGenerateVideo` (5967) | DiCaprio — fal.ai `kling-video/v1.5/pro/image-to-video` |
| `POST` | `/session/:id/restyle-video` | `handleRestyleVideo` (6181) | DiCaprio — fal.ai `ltx-2-19b/video-to-video`; compresses to 720p/10 s before upload |
| `POST` | `/session/:id/remove-video-bg` | `handleRemoveVideoBg` (6397) | DiCaprio — fal.ai `ben/v2/video`; outputs WebM |
| `POST` | `/session/:id/process-asset` | `handleProcessAsset` (8112) | Apply FFmpeg command string to specific asset; result is new asset |
| `POST` | `/session/:id/extract-audio` | `handleExtractAudio` (7958) | Splits video into muted video + MP3 audio asset |

### Custom Transitions

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| `GET` | `/session/:id/transitions` | `handleListTransitions` (8427) | Lists built-in (4) + custom `.tsx` files |
| `POST` | `/session/:id/upload-transition` | `handleUploadTransition` (8322) | Validates code; writes `.tsx`; regenerates barrel; invalidates bundle cache |
| `POST` | `/session/:id/generate-transition` | `handleGenerateTransition` (8514) | LLM generates `.tsx` from description; same write pipeline |
| `POST` | `/session/:id/delete-transition` | `handleDeleteTransition` (8390) | Deletes `.tsx`; regenerates barrel; cannot delete built-ins |

---

## hw-detect.js

### Key Functions

| Function | Line | Description |
|---|---|---|
| `detectCapabilities()` | 136 | Async; runs all probes; caches result; logs JSON summary |
| `getCapabilities()` | 171 | Sync; throws if called before `detectCapabilities()` |
| `detectGpuName()` | 33 | `wmic` (Windows), `nvidia-smi`/`lspci` (Linux), `system_profiler` (macOS) |
| `detectFFmpegHwEncoders()` | 77 | Runs `ffmpeg -encoders`; filters against known encoder list |
| `pickPreferredEncoder(platform, available)` | 99 | Priority: win32 `[nvenc, amf, qsv]`, linux `[nvenc, vaapi, qsv]`, darwin `[videotoolbox]` |
| `pickGlBackend(platform, gpuName, headful)` | 115 | win32+GPU → `angle-egl` (headful+headless); win32 no GPU → `swangle`; darwin → `angle`; linux+GPU+headful → `angle-egl`; linux+GPU+headless → `egl`; linux no GPU → `swangle`. Exported — called by hwaccel-config at render time. |
| `pickConcurrency(cpuCores)` | 124 | `<=2→1`, `<=4→2`, else `floor(cores×0.6)` |

### HWCapabilities Shape

```js
{ platform, arch, cpuCores, cpuModel, totalMemoryGB, gpuName,
  ffmpegHwEncoders, preferredEncoder, concurrency }
// preferredGl intentionally absent — GL depends on headful mode (env toggle).
// Use pickGlBackend(platform, gpuName, headful) to resolve at render time.
```

Standalone: `node scripts/hw-detect.js` prints diagnostics.

---

## hwaccel-config.js

### Key Functions

| Function | Line | Description |
|---|---|---|
| `getRenderMediaOptions(isPreview)` | 78 | Builds Remotion `renderMedia()` option overrides |
| `getFFmpegEncodeArgs(quality)` | 162 | Returns FFmpeg arg array for system FFmpeg spawns; quality: `preview\|final\|max` |
| `getAccelSummary()` | 181 | Human-readable summary; used by `/hwaccel-info` endpoint |

### Encoder Argument Tables

**Hardware** (`ENCODER_ARGS`, lines 36–62): nvenc, amf, qsv, vaapi, videotoolbox at preview/final/max bitrates (6M/10M/20M).

**Software** (`SOFTWARE_ARGS`, lines 64–68): libx264 at preview (`ultrafast, crf 18`), final (`fast, crf 20`), max (`medium, crf 18`).

### getRenderMediaOptions logic

```text
Always set:
  chromiumOptions.gl  ← pickGlBackend(platform, gpuName, useHeadful)  [resolved at render time]
  chromeMode          ← 'chrome-for-testing' (headful, real GPU) if HWACCEL_HEADFUL
  concurrency         ← pickConcurrency result
  offthreadVideoThreads ← floor(cores × 0.4), min 2
  offthreadVideoCacheSizeInBytes ← clamp(RAM×0.06, 0.5–2 GB)
  jpegQuality         ← 70 (preview) / 80 (final)

macOS only (VideoToolbox):
  hardwareAcceleration: 'if-possible'
  videoBitrate: '6M' / '10M'

All other platforms (software):
  crf: 30 / 20
  x264Preset: 'ultrafast' / 'fast'
```

**Critical**: Remotion's bundled FFmpeg has no NVENC/AMF/QSV/VAAPI. GPU encoding in direct `spawn()` calls uses the **system FFmpeg** only. VideoToolbox is the sole exception (built into Remotion's FFmpeg on macOS).

---

## whisper-transcribe.py

Standalone Python script invoked by the Node server via `spawn`. Accepts:

```
python3 whisper-transcribe.py <audio_file> [model_size] [--model-dir <path>] [--no-condition-on-previous-text]
```

Outputs JSON to **stdout**: `{text, words: [{text, start, end}], language}`.
Progress messages go to **stderr** so the Node caller can log them without polluting the JSON stream.

Key details:
- `suppress_stdout()` context manager (lines 15–23) silences Whisper's own print statements
- MPS (Apple GPU) **not used** — Whisper sparse tensors crash on MPS; CPU only (line 33 comment)
- `model_size` default: `base`

---

## Data Flow

### Asset Upload Flow

```text
POST /session/:id/assets
  │
  ├─ formidable parse (10 GB limit)
  ├─ detect type from extension
  ├─ copy to assetsDir/{uuid}.ext
  ├─ generateThumbnail() → {uuid}_thumb.jpg (15 s timeout)
  ├─ getMediaInfo() → width, height, duration
  ├─ session.assets.set(uuid, asset)
  └─ saveAssetMetadata() → assets-meta.json
```

### Render Flow (Primary Path)

```text
POST /session/:id/render
  │
  ├─ streamRender(res, async () => {
  │    buildSessionRemotionSpec(session)
  │    → timelineToRemotionSpec → normalizeSpec
  │    renderMedia(spec, getRenderMediaOptions(isPreview))
  │      [Remotion Node API — bundled FFmpeg, libx264]
  │    generateThumbnail(outputPath) if not preview
  │    return { renderPath, duration, ... }
  │  })
  │
  └─ NDJSON stream: {type:'progress', percent} ... {type:'result', ...}
```

### Transcription Cascade

```text
POST /session/:id/transcribe
  │
  ├─ checkLocalWhisper()
  │     yes → runLocalWhisper(audioPath)
  │             spawn whisper-transcribe.py
  │             read JSON from stdout
  │
  ├─ else if OPENAI_API_KEY → OpenAI Whisper API
  │     POST https://api.openai.com/v1/audio/transcriptions
  │     response_format: verbose_json, timestamp_granularities: word
  │
  └─ else → Gemini (base64 inline audio, no word timestamps)
```

### Dead Air Removal Flow

```text
POST /session/:id/remove-dead-air
  │
  ├─ detectSilence() → silence periods
  ├─ calculateKeepSegments() → non-silent ranges
  ├─ for each segment:
  │     runFFmpeg [-ss start -t duration -i input libx264/aac segment.mp4]
  ├─ write concat manifest
  ├─ runFFmpeg [-f concat -c copy output.mp4]
  └─ replace input file in-place; update asset duration
```

### Custom Transition Upload Flow

```text
POST /session/:id/upload-transition  (or generate-transition)
  │
  ├─ validateTransitionCode(code)
  │     check: export present, 'remotion' import, whitelist-only imports
  ├─ write {transitionId}.tsx to CUSTOM_TRANSITIONS_DIR
  ├─ regenerateBarrelFile()
  │     reads all .tsx → writes custom/index.ts with registerTransition() calls
  └─ invalidateBundleCache()
       forces Remotion to re-bundle on next render
```

---

## Connections

- [[useProject]] — calls every session/asset/project/render endpoint; manages `sessionId` in `localStorage('clipwise-session')`
- [[Home]] — calls `transcribe`, `generate-animation`, `generate-broll`, `remove-dead-air`, `extract-audio`, `render`
- [[AIPromptPanel]] (Director) — sends user prompt to [[Cloudflare Worker]] which returns FFmpeg command; panel calls `process-asset` or `process` to execute
- [[PicassoPanel]] — calls `generate-image`
- [[DiCaprioPanel]] — calls `generate-video`, `restyle-video`, `remove-video-bg`
- [[Cloudflare Worker]] — generates FFmpeg commands via Gemini but does NOT execute; this server executes
- [[DynamicAnimation]] — `handleGenerateAnimation` renders this Remotion composition via `renderDynamicAnimation()`
- [[remotion-transitions]] — `CUSTOM_TRANSITIONS_DIR` feeds into the Remotion bundle; `invalidateBundleCache()` triggers re-bundle after upload/delete

---

## Known Issues

1. **`render-motion-graphic` is a placeholder** (`handleRenderMotionGraphic`, line 4669): creates a solid-color video with FFmpeg `drawtext` instead of rendering a Remotion template. The `MotionGraphicsPanel` in the frontend is never wired to this endpoint for actual rendering.

2. **Legacy `handleProjectRender` (line 2540) is effectively dead code**: the routing block maps `POST /session/:id/render` → `handleProjectRenderRemotion`. The legacy FFmpeg filter_complex compositor is only reachable via `POST /session/:id/render-ffmpeg`, which no frontend code calls.

3. **`session.transcriptCache` is in-memory only**: server restart loses all cached transcriptions. Re-upload or re-transcription required.

4. **`WHISPER_CONDITION_ON_PREV_TEXT=false` disables conditioning** to reduce hallucination loops in long audio files — documented behavior, not a bug, but worth knowing when captions loop repetitively.

5. **`handleRestyleVideo` (line 6181) hard-compresses input to 720p/10 s before fal.ai upload**: videos longer than 10 s are silently truncated. No UI warning is shown.

6. **Remotion bundle cache invalidation** (`invalidateBundleCache()`) is called on every transition upload/delete but does not exist as a named function in the file — it is defined inline elsewhere and referenced at lines 8370, 8415, 8576. If the Remotion bundle cache path changes, all three call sites must be updated.

7. **`handleGenerateTranscriptAnimation` and `handleGenerateContextualAnimation` both re-implement the full transcription cascade** (local Whisper → OpenAI → Gemini) inline rather than calling `handleTranscribe`. They are not DRY with the shared `handleTranscribe` path.
