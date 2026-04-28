---
title: Shared Types & Utils
type: module
source_files:
  - src/shared/types.ts
  - src/shared/remotion-core.ts
  - src/react-app/utils/ndjson.ts
  - src/types/env.d.ts
tags: [types, remotion, captions, rendering, api, worker]
---

## Overview

Single source of truth for types shared across React frontend, Remotion renderer, and Cloudflare Worker. `remotion-core.ts` defines the complete project spec data model. `ndjson.ts` provides streaming render progress reader. `env.d.ts` types Worker bindings.

## Key Components

### src/shared/types.ts (16 lines)

Re-exports everything from `./remotion-core`. Contains comment block (lines 3–15) noting future Zod schema plans — not yet implemented.

---

### src/shared/remotion-core.ts (225 lines)

#### Type Aliases

| Line | Name | Values |
|------|------|--------|
| 1 | `RemotionTrackType` | `'video' \| 'audio' \| 'text'` |
| 3 | `CaptionPresetId` | `'clean-lower-third' \| 'highlight-mode'` |
| 5 | `RemotionSpecVersion` | `'1.0' \| '2.0'` |
| 7 | `RemotionEasing` | `'linear' \| 'ease-in' \| 'ease-out' \| 'ease-in-out'` |
| 9 | `LegacyTransitionType` | `'none' \| 'fade' \| 'slide-left' \| 'slide-right' \| 'zoom'` |
| 11 | `RemotionJunctionTransitionType` | `'none' \| 'crossfade' \| 'slide-left' \| 'slide-right' \| 'dip-to-black' \| 'custom'` |

#### RemotionTransition (lines 13–17)

Legacy per-clip transition. Fields: `type` (LegacyTransitionType), `durationSec` (number), `easing?` (RemotionEasing)

#### RemotionClipJunctionTransition (lines 19–28)

V1 clip-pair transition. Fields: `id`, `fromClipId`, `toClipId`, `type` (RemotionJunctionTransitionType), `durationSec`, `easing?`, `fallbackBehavior?` ('cut'|'clamp'|'crossfade'), `customTransitionId?`

#### RemotionTimelineTransition (lines 31–40)

V2 independent timeline entity. Fields: `id`, `startTime`, `durationSec`, `fromClipId` (string|null), `toClipId` (string|null), `transitionFileId`, `easing?` (string), `params` (Record)

#### RemotionClipTransform (lines 42–48)

Fields: `x?`, `y?`, `scale?`, `rotation?`, `opacity?` — all optional numbers

#### RemotionTrack (lines 50–55)

Fields: `id`, `type` (RemotionTrackType), `name`, `order`

#### RemotionClip (lines 57–74)

Fields: `id`, `trackId`, `assetId?`, `src?`, `assetType?`, `startSec`, `durationSec`, `inPointSec`, `outPointSec`, `playbackRate?`, `volume?`, `muted?`, `transform?`, `transitionIn?`, `transitionOut?`, `segmentRole?`

#### RemotionCaptionWord (lines 76–80)

Fields: `text`, `startSec`, `endSec` — timing relative to clip start

#### RemotionCaptionStyle (lines 82–106)

Full caption styling: `presetId`, `fontFamily`, `fontSize`, `fontWeight`, `color`, `textOpacity?`, `backgroundColor?`, `backgroundEnabled?`, `backgroundPadding?`, `backgroundRadius?`, `backgroundOpacity?`, `strokeColor?`, `strokeWidth?`, `position` (top|center|bottom), `positionX?`, `positionY?`, `animation` (none|karaoke|fade|pop|bounce|typewriter|highlight), `highlightColor?`, `textCase?`, `maxWidthPercent?`, `lineHeight?`, `letterSpacing?`, `shadow?`

#### RemotionCaption (lines 108–117)

Fields: `id`, `clipId?`, `startSec`, `endSec`, `text`, `words?` (RemotionCaptionWord[]), `style`, `segmentRole?`

#### BrandTheme (lines 119–128)

Fields: `name`, `fontFamily`, `accentColor`, `secondaryColor`, `backgroundColor`, `textColor`, `glow`, `motionSpeed`

#### AdSegmentTemplate (lines 130–136)

Fields: `id` ('hook'|'body'|'cta'), `startSec`, `endSec`, `textOptions` (string[]), `captionPreset`

#### AdTemplate (lines 138–145)

Fields: `name`, `segments.hook`, `segments.body`, `segments.cta`

#### VoiceoverLayer (lines 147–153)

Fields: `assetId?`, `src?`, `startSec`, `durationSec?`, `volume`

#### RemotionProjectSpec (lines 155–176)

Top-level project document. Fields: `version`, `id`, `title`, `createdAt`, `updatedAt`, `settings` ({width, height, fps, backgroundColor}), `tracks`, `clips`, `captions`, `voiceover`, `transitions?` (V1), `timelineTransitions?` (V2), `brandTheme`, `adTemplate`, `meta?`

#### VariantGenerationOptions (lines 178–188)

Ad variant generation options. Fields: `count`, `hooks?`, `hookPool?`, `bodies?`, `bodyPool?`, `ctas?`, `ctaPool?`, `toneProfile?`, `captionStyleProfile?`

**Not wired up in any UI — dead code stub.**

#### CAPTION_STYLE_PRESETS (lines 190–224)

`Record<CaptionPresetId, Partial<RemotionCaptionStyle>>`

Two presets:
- `'clean-lower-third'`: Inter, 52px, bold, white, 4px stroke, bottom, fade animation
- `'highlight-mode'`: Inter, 58px, black weight, white, 5px stroke, bottom, highlight animation with yellow

---

### src/react-app/utils/ndjson.ts (43 lines)

#### RenderProgress (lines 1–6)

Fields: `pct`, `frames`, `total`, `elapsed`

#### readNDJSONStream(response, onProgress) (lines 8–43)

Reads NDJSON streaming response. Handles three message types:
- `progress` → calls `onProgress(msg)`
- `result` → returns msg
- `error` → throws Error(msg.message)

Fallback: if content-type lacks 'ndjson'/'stream', just does `response.json()`.

Tail buffer: parses remaining buffer after stream close (only result/error handled; trailing progress silently dropped).

---

### src/types/env.d.ts (13 lines)

Ambient `Env` interface (no export) for Cloudflare Worker bindings:
`GEMINI_API_KEY`, `R2_BUCKET` (R2Bucket), `DB` (D1Database), `MOCHA_USERS_SERVICE_API_URL`, `MOCHA_USERS_SERVICE_API_KEY`, `LLM_PROVIDER?`, `OPENAI_API_BASE_URL?`, `OPENAI_API_KEY?`, `LLM_MODEL?`

## Data Flow

```text
Frontend (useProject) ──builds──► RemotionProjectSpec ──POST──► FFmpeg Server
                                                                     │
FFmpeg Server ──streams──► NDJSON {progress} lines ──► readNDJSONStream
                                                                     │
                       ──passes spec as props──► Remotion Renderer (ProjectTimeline)
```

## Connections

- [[react-app-core]] — useProject builds RemotionProjectSpec, uses readNDJSONStream
- [[remotion-core]] — ProjectTimeline receives spec as input props
- [[remotion-templates]] — DynamicAnimation uses caption types
- [[worker]] — typed by Env interface
- [[ffmpeg-server]] — serializes/deserializes RemotionProjectSpec

## Known Issues

- `VariantGenerationOptions` defined but unused — no callers in codebase
- `AdTemplate` required on RemotionProjectSpec but no UI to configure it
- No Zod validation — all shared types are pure TS interfaces, no runtime enforcement
- V1/V2 transition systems coexist with no migration path
- `readNDJSONStream` silently drops trailing progress messages in buffer
- `backgroundEnabled` has no default — renderers must handle undefined
