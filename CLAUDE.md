# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HyperEdit is an AI-powered video editor built with React 19, Remotion for motion graphics, and a local Node.js FFmpeg server as the only backend (the Cloudflare/Mocha scaffold was torn down 2026-07-10).

## Commands

```bash
npm install              # Install dependencies
npm run dev              # Start Vite dev server
npm run ffmpeg-server    # Start local FFmpeg server (port 3333) - run in separate terminal
npm run build            # TypeScript + Vite production build
npm run lint             # ESLint
npm run check            # Full validation: type check + build + tests
npm run test             # Vitest unit tests (tests/, node env)
npm run knip             # Check for unused dependencies
```

**Local development** requires both `npm run dev` and `npm run ffmpeg-server` running simultaneously.

## Code Conventions

- **File length**: ESLint `max-lines` errors at 1,000 lines. That's a tripwire, not a target — the governing rule is **one concern per file: if describing what a file does requires the word "and", split it.** Files oversized at rule adoption are grandfathered in `eslint.config.js`; that list may only shrink (each refactor deletes the entries it decomposes) — never add entries.
- **Naming (non-React files)**: descriptive kebab-case where the name alone states the file's concern, ending in a role word from a fixed vocabulary: `-service`, `-gateway`, `-worker`, `-queue`, `-store`, `-helpers`, `-schema`, `-scene` (e.g. `asset-service.js`, `llm-gateway.js`, `title-scene.tsx`). Role-based searches must work: `rg --glob '*-service.js'` finds all services. React files unchanged: components `PascalCase.tsx`, hooks `useX.ts`.
- **Vendor-neutral code**: model/vendor names (`gemini`, `openai`, `kimi`, `deepseek`, `veo`, `sora`, `kling`, `ltx`, `bria`, and future ones) may appear in exactly three places: (a) the provider adapter implementing that vendor (`*-provider.*` / `*-gateway.*` files), (b) `ai-config.json` entries, (c) env var names referenced through the config's `apiKeyEnv` indirection. Everywhere else — call sites, endpoints, UI text, logs, errors, comments, type names — use task vocabulary: `llm`, `provider`, `textModel`, `video-gen`, `image-gen`, `bg-removal`. Leakage check:
  `rg -i 'gemini|openai|kling|veo' --glob '!*-provider*' --glob '!*-gateway*' src/ scripts/`
  Existing violations are pre-gateway legacy (Phase 2 routes them through the gateway); do not add new ones.

## Architecture

```
src/
├── react-app/           # Frontend React SPA
│   ├── components/      # UI: Timeline, VideoPreview, AssetLibrary, AIPromptPanel, MotionGraphicsPanel
│   ├── hooks/           # useProject (main state)
│   └── pages/Home.tsx   # Main editor layout
├── remotion/            # Motion graphics system
│   └── templates/       # 11 templates with registry in index.ts
scripts/
└── server/              # Session-based FFmpeg/Remotion server (TypeScript, Hono)
    ├── main.ts          # Entry: bootstrap + serve
    ├── http-app.ts      # Hono routing over the service route tables
    ├── *-service.ts     # One concern per service (assets, render, transcription, ...)
    ├── *-gateway.ts     # Provider adapters (vendor names live ONLY here)
    └── *-helpers.ts     # ffmpeg/whisper/http/spa shared substrate
```

**Key patterns:**
- Multi-track timeline with 6 tracks: T1 (captions), V3 (top overlay), V2 (overlay), V1 (base video), A1/A2 (audio)
- `useProject()` hook manages all project state: assets, clips, playback, captions, rendering
- Local FFmpeg server (port 3333) handles sessions, asset storage, thumbnail generation, rendering, and Whisper-based transcription for captions
- The FFmpeg server also generates Director edit commands (`POST /ai-edit` through the configured LLM provider) and serves the built SPA from `dist/`

## State Management

The `useProject()` hook in `src/react-app/hooks/useProject.ts` is the central state manager. Key concepts:

- **Assets**: Source files (video/image/audio) with metadata, thumbnails, and stream URLs
- **TimelineClips**: Instances of assets placed on tracks with start time, duration, in/out points, and transforms
- **CaptionData**: Word-level timing from Whisper transcription, stored separately with style configuration keyed by clip ID. Caption clips on T1 have `assetId: ''` — never look for caption content in the asset library.
- **TimelineTabs**: Each tab stores its own `clips: TimelineClip[]` separately. `activeClips` in Home.tsx switches between main `clips` and `tab.clips`. All move/resize/delete operations must check `activeTabId !== 'main'` and dispatch to `updateTabClips` instead.

**Critical patterns:**
- The hook uses parallel refs (`tracksRef`, `clipsRef`, `settingsRef`) synced via `useEffect` so debounced/async operations read latest state without stale closures. This is essential for `saveProject` and `renderProject`.
- Session ID is persisted in `localStorage` under key `hyperedit-session` (a one-time `migrateLegacySessionKey()` rolls any pre-rename pointer forward). If the FFmpeg server restarts, the stored session may be invalid (404), in which case localStorage is cleared and a new session is created on next asset upload.
- Tracks are always initialized client-side (never loaded from server) to guard against outdated server data.
- Auto-save is intentionally disabled to prevent excessive saves during drag operations. Saves must be triggered explicitly via `saveProject()`.
- `refreshAssets` appends `?v=Date.now()` to `streamUrl` for cache-busting after server-side file modifications.
- Assets with `aiGenerated: true` are deprioritized when selecting context video for new animation generation.

## FFmpeg Server

The local FFmpeg server lives in `scripts/server/` as native-TypeScript modules (Node 24 type stripping — no build step): a thin Hono layer (`http-app.ts`) routes to one-concern `*-service.ts` files, each exporting a typed route table; handlers write raw Node responses (streams, NDJSON, range requests) and provider SDKs are confined to `*-gateway.ts`. It handles all video processing, asset management, Remotion rendering, transcription, generative-media calls, LLM edit-command generation, and SPA hosting. Entry: `scripts/server/main.ts` (`npm run ffmpeg-server`).

Every long-running route runs on the job model (`job-store.ts` + `job-queue.ts` + `job-service.ts`): the route validates synchronously (400/422 stay immediate), answers `202 { jobId }`, and state is polled at `GET /session/{id}/jobs/{jobId}` (DELETE cancels — no WebSockets/SSE by decree). Mid-work user-addressable failures (e.g. no speech in range) surface as job errors with `errorStatus` carrying the old HTTP status. The registry is in-memory with a ramdisk mirror for crash forensics only; finished jobs are capped at ~50 per session; `HYPEREDIT_JOB_HISTORY=1` enables append-only JSONL history. Lane concurrency caps (env-overridable via `HYPEREDIT_{RENDER,TRANSCRIBE,FFMPEG,LLM,FAL,INGEST}_CONCURRENCY`): render 1, transcribe 1, ffmpeg 1 (dead-air/audio-sync/create-gif), llm 3 remote / 1 localhost (keyed off the provider base-URL host), fal 4 (real remote-cancel attempt on DELETE once the provider queue accepts), ingest 1 (its own lane so a proxy build never queues behind dead-air). Job lanes: render ×4 + render-from-concept, transcribe ×2, chapters, dead-air, audio-sync, create-gif, animation ×7, b-roll, gen-media ×4, ingest (per-asset probe→proxy→peaks→thumbnail, auto-enqueued on video upload + on in-place edit). The ingest lane has true in-flight cancel (aborts its ffmpeg proxy encode); the other spawn lanes cancel queued jobs and let an in-flight child settle. **Delete-during-job contract:** deleting an asset or session is refused `409` while a user-initiated job (render/transcribe/…) runs, but background ingest never blocks it — the delete cancels the asset's (or session's) ingest, awaits the ffmpeg child's exit, then removes the files (source + thumbnail + proxy). There is no NDJSON streaming anywhere — the frontend polls via `pollJob` (`utils/api-helpers.ts`).

Key endpoints on `localhost:3333`:
- `POST /session/create` - Create new editing session
- `POST /session/{id}/assets` - Upload asset (auto-generates thumbnails)
- `POST /session/{id}/transcribe` - Whisper transcription for captions
- `POST /session/{id}/render` - Render final video (job model: returns `202 { jobId }`)
- `GET/DELETE /session/{id}/jobs/{jobId}` - Poll job state (`queued|running|done|error|canceled`, progress, result) or cancel; unknown jobId → 404 with hint (registry is in-memory — a server restart empties it)
- `POST /session/{id}/render-motion-graphic` - Render Remotion animation (job model, `202 { jobId }`)
- `POST /session/{id}/generate-animation` - AI-generated Remotion code (Gemini writes JSX → in-process render via @remotion/bundler + @remotion/renderer)
- `POST /session/{id}/edit-animation` - Modify existing Remotion source in-place (same asset ID reused after re-render)
- `POST /session/{id}/process-asset` - Apply FFmpeg command to a specific asset (replaces in-place)
- `POST /session/{id}/extract-audio` - Split video into muted video + audio on A1
- `POST /session/{id}/generate-video` - Image-to-video via fal.ai (DiCaprio)
- `POST /session/{id}/restyle-video` - Video-to-video style transfer (DiCaprio)
- `POST /session/{id}/remove-video-bg` - Background removal (DiCaprio)
- `POST /session/{id}/generate-image` - Picasso image generation
- `POST /session/{id}/giphy/*` - GIPHY search/trending/add proxy
- `POST /session/{id}/create-gif` - Animated GIF from image with motion effects

Sessions persist to `{HYPEREDIT_SESSIONS_DIR}/{sessionId}/` with assets, renders, project.json, and assets-meta.json (stores `aiGenerated`, `duration`, `editCount`). Uploads stage to `HYPEREDIT_UPLOAD_STAGING_DIR` (default `{HYPEREDIT_SESSIONS_DIR}/.upload-staging`), which must share a volume with the sessions directory so the post-parse move is a rename. Storage policy: churn goes to the ramdisk (`HYPEREDIT_TEMP_DIR`), bulk goes to the HDD, flash stays read-mostly.

**In-place mutation contract:** any code path (human or agent) that rewrites an asset's bytes under the SAME asset id (currently only dead-air) MUST route through `onAssetMutated(session, assetId)` in `session-store.ts` — the single choke point that invalidates the transcript cache + both proxy tiers (marks the proxy not-ready, drops the warm copy) + persists metadata, then re-enqueue an ingest job to rebuild derived artifacts. Nothing else evicts proxies on mutation; the ingest lane deliberately does not. (Operations that instead produce a NEW asset id — process-asset, extract-audio, generative outputs — are not mutations and skip this.)

## TypeScript Configuration

Three separate tsconfig files:
- `tsconfig.app.json` - React app (ES2020, strict)
- `tsconfig.node.json` - Build tools

Path alias: `@/` → `./src/`

## Remotion Integration

Motion graphics use Remotion 4.x. Two distinct subsystems coexist:

**Static Templates** (`src/remotion/templates/`): 11 pre-built components registered in `MOTION_TEMPLATES` with categories (text, engagement, data, branding, mockup, showcase). Used by `MotionGraphicsPanel` with `@remotion/player` for live preview.

**AI-Generated Dynamic Animations** (`src/remotion/DynamicAnimation.tsx`): Takes `scenes: Scene[]` prop with types like title, steps, features, stats, chart, countdown, emoji, gif, lottie, etc. Composition `id="DynamicAnimation"` is what the FFmpeg server renders. Uses `@remotion/shapes`, `@remotion/animated-emoji`, `@remotion/gif`, `@remotion/lottie`.

When working on templates, use the `/remotion-best-practices` skill for domain-specific guidance. Tailwind only scans `./src/react-app/` — not the remotion directory.

## Environment Variables

Required in `.dev.vars` for local development:
- `HYPEREDIT_TEMP_DIR` - ramdisk scratch path (e.g. `R:/Temp`); the FFmpeg server **refuses to start** if this or `HYPEREDIT_SESSIONS_DIR` is unset — no silent `os.tmpdir()` fallback
- `HYPEREDIT_SESSIONS_DIR` - session storage on the HDD
- `HYPEREDIT_UPLOAD_STAGING_DIR` - optional; upload staging dir, defaults to `{HYPEREDIT_SESSIONS_DIR}/.upload-staging` (must share a volume with sessions)
- `GEMINI_API_KEY` - Google AI provider key (used when `LLM_PROVIDER` resolves to google)
- `FAL_API_KEY` - fal.ai for Picasso/DiCaprio (note: server aliases this to `FAL_KEY` for the fal.ai SDK)
- `GIPHY_API_KEY` - GIF search
- `OPENAI_API_KEY` - Additional AI features

## AI Agents

The right panel has three AI agents accessible via tabs. All three panels are always mounted but toggled with `hidden` CSS class to preserve chat state.
- **Director** (AIPromptPanel): Video editing commands, captions, motion graphics, animations
- **Picasso** (PicassoPanel): Image generation using fal.ai nano-banana-pro model
- **DiCaprio** (DiCaprioPanel): Video generation with Animate Image (Kling v1.5), Restyle Video (LTX-2 19B), Remove Background (Bria)

## UI Layout Conventions

- **Track placement**: AI-generated animations always go on V2. B-roll images go on V3 with default `scale: 0.2`, centered.
- **Image clips** default to 5-second duration everywhere (`addClip`, `handleDropAsset`, `addCaptionClip`).
- **Caption word timestamps** are relative to clip start, not absolute project time. Conversion happens in `getPreviewLayers()`.
- **Caption chunking**: Max 5 words per chunk OR when there's a 0.7s pause between words (hardcoded in Home.tsx `handleTranscribeAndAddCaptions`).
- **Ripple delete**: When `autoSnap` is true, deleting a clip shifts subsequent clips on the same track backward via the `ripple` parameter on `deleteClip`.
- **`splitClip`** has a 0.05s guard — returns `null` if split point is within 50ms of either edge.
- **Properties panel**: Left panel bottom half shows `CaptionPropertiesPanel` when selected clip is on T1, otherwise `ClipPropertiesPanel`.
- **Resizable panels**: Left (assets + properties), right (AI agents), and timeline height are all user-resizable via `ResizablePanel`/`ResizableVerticalPanel`.

## Local Whisper Transcription

Captions use local OpenAI Whisper (`scripts/whisper-transcribe.py`). Setup:
```bash
pip3 install openai-whisper torch
```
- **MPS (Apple GPU) is NOT supported** — Whisper's sparse tensors crash on MPS. The script runs on CPU only. Do not add `device="mps"`.
- Falls back to Gemini API if local Whisper is unavailable (but Gemini struggles with long audio files).
- The `base` model is used by default (good speed/accuracy balance).

## Dead Air Removal

The remove dead air workflow (`POST /session/{id}/remove-dead-air`) is stable — **do not modify it**. How it works:
1. FFmpeg `silencedetect` finds silence periods (threshold: -26dB, min duration: 0.4s — set in `Home.tsx handleRemoveDeadAir`)
2. Each non-silent segment is extracted individually with `-ss`/`-t` and re-encoded (`libx264 ultrafast, aac`)
3. Segments are concatenated with `-c copy` into the final output
4. The original file is replaced in-place on disk
5. Frontend calls `refreshAssets()` to get a cache-busted URL and updates the V1 clip duration

The segment-based approach (extract + concat) is required — single-pass filter approaches (`select`/`aselect`, `trim`/`atrim`) drop audio streams. The `VideoPreview` component uses a stable `key` on the base video element and manually calls `video.load()` when the source URL changes, preserving browser audio permission from the user's play gesture.

## Build & Deployment

- Plain Vite + React build. `chunkSizeWarningLimit: 5000` due to Remotion's size.
- `knip.json` `ignoreDependencies` carries three deliberate zero-importer keeps: `@remotion/media` (WebCodecs POC core), `@remotion/transitions` (decided transition engine), `hono` (R1 decomposition's HTTP layer). Remove each entry when it gains importers; never park anything else there without a decision note.
- Production hosting: the FFmpeg server serves `dist/` with SPA fallback routing (unmatched GETs return `index.html`); content-hashed assets cache immutably.
- Tests: vitest (`tests/*.test.js`, node environment, config in `vitest.config.js`), run via `npm run test` and as part of `npm run check`. Coverage targets pure functions (project schema/migrations, remotion spec parsing, timeline-to-spec conversion) — no React/browser tests yet. Project state is versioned: `scripts/project-schema.js` holds `PROJECT_SCHEMA_VERSION` + the migration ladder; every server read/write path funnels through `ensureProjectDefaults`, which migrates then defaults. The render spec has its own versioning in `scripts/remotion-core/spec.js` (`SPEC_VERSION_*`, `migrateSpecToV2`).
