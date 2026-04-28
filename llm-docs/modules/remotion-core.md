---
title: remotion-core
type: module
source_files:
  - src/remotion/ProjectTimeline.tsx
  - src/shared/remotion-core.ts
  - scripts/remotion-core-cli.js
  - scripts/remotion-core/render.js
  - scripts/remotion-core/spec.js
  - scripts/remotion-core/timeline-to-spec.js
  - scripts/remotion-core/ad-intelligence.js
tags:
  - remotion
  - rendering
  - spec
  - ad-variants
  - timeline
  - captions
  - transitions
---

# remotion-core

## Overview

The remotion-core module is the complete pipeline that converts a HyperEdit project timeline into a rendered MP4 video using Remotion. It defines the `RemotionProjectSpec` data contract (shared TypeScript types and Zod schemas), normalises and validates specs through a version-migration layer, renders them via a cached Chromium bundle, and provides a campaign-grade CLI that generates scored ad-copy variants and batches them through the renderer. The module also includes a heuristic scoring engine (`ad-intelligence`) that ranks variants by hook/body/CTA quality without requiring an AI call.

---

## Data Flow

```text
  HyperEdit project state (useProject hook)
           │
           ▼
  timeline-to-spec.js ──── timelineToRemotionSpec()
           │                  Maps TimelineClip[] + assets + captionData
           │                  → RemotionProjectSpec (v2 JSON)
           ▼
  spec.js ──────────────── parseSpecInput()
           │                  normalizeBaseSpec()  (sanitise all fields)
           │                  migrateSpecToV2()    (v1 → v2, derive transitions)
           │                  validateSpecV2()     (Zod schema check)
           │
           ▼
  render.js ────────────── renderSpecWithRemotion()
           │                  getBundleUrl()        (webpack bundle, cached)
           │                  copyAssetsToBundle()  (hard-link session assets)
           │                  getBrowser()          (Chrome, cached)
           │                  selectComposition()   → "ProjectTimeline"
           │                  renderMedia()         (Remotion → MP4)
           ▼
  ProjectTimeline.tsx ───── React component (run inside Chrome by Remotion)
           │                  visualClips  → VideoVisualClip (OffthreadVideo / Img)
           │                  audioClips   → AudioClip (Audio)
           │                  voiceover    → Audio sequences
           │                  transitions  → resolveTimelineTransitions()
           │                               → TransitionCompositor
           │                  captions     → CaptionOverlay
           ▼
           output .mp4

  CLI variant flow (remotion-core-cli.js):
  ┌─────────────────────────────────────────────────┐
  │  spec.json  ──► parseSpecInput()                │
  │               ──► generateAdVariants()          │
  │                    ├─ applyToneProfile()        │
  │                    ├─ applyCaptionStyleProfile()│
  │                    └─ N × RemotionProjectSpec   │
  │               ──► (optional) renderVariantBatch()│
  │               ──► scoreVariantBatch()           │
  │               ──► writeCampaignReport()         │
  └─────────────────────────────────────────────────┘
```

---

## Key Components

### `src/shared/remotion-core.ts` — Shared TypeScript Types and Constants

This file is the single source of truth for all spec types. It is imported by both the React app (frontend) and the server-side scripts.

#### Type Aliases

| Name | Line | Values |
|---|---|---|
| `RemotionTrackType` | 1 | `'video' \| 'audio' \| 'text'` |
| `CaptionPresetId` | 3 | `'clean-lower-third' \| 'highlight-mode'` |
| `RemotionSpecVersion` | 5 | `'1.0' \| '2.0'` |
| `RemotionEasing` | 7 | `'linear' \| 'ease-in' \| 'ease-out' \| 'ease-in-out'` |
| `LegacyTransitionType` | 9 | `'none' \| 'fade' \| 'slide-left' \| 'slide-right' \| 'zoom'` |
| `RemotionJunctionTransitionType` | 11 | `'none' \| 'crossfade' \| 'slide-left' \| 'slide-right' \| 'dip-to-black' \| 'custom'` |

#### Interfaces

**`RemotionTransition`** (line 13) — legacy v1 per-clip transition field.
- `type: LegacyTransitionType`
- `durationSec: number`
- `easing?: RemotionEasing`

**`RemotionClipJunctionTransition`** (line 19) — v1 junction-based transition (between two named clips).
- `id: string`
- `fromClipId: string`
- `toClipId: string`
- `type: RemotionJunctionTransitionType`
- `durationSec: number`
- `easing?: RemotionEasing`
- `fallbackBehavior?: 'cut' | 'clamp' | 'crossfade'`
- `customTransitionId?: string`

**`RemotionTimelineTransition`** (line 31) — v2 timeline-entity transition (cross-track, any timing scenario).
- `id: string`
- `startTime: number` — absolute position in seconds
- `durationSec: number`
- `fromClipId: string | null` — `null` means fade from black
- `toClipId: string | null` — `null` means fade to black
- `transitionFileId: string` — key into the transition registry
- `easing?: string`
- `params: Record<string, number | string | boolean>`

**`RemotionClipTransform`** (line 42) — 2D spatial transform applied to a clip.
- `x?: number`
- `y?: number`
- `scale?: number`
- `rotation?: number`
- `opacity?: number`

**`RemotionTrack`** (line 50).
- `id: string`
- `type: RemotionTrackType`
- `name: string`
- `order: number`

**`RemotionClip`** (line 57).
- `id: string`
- `trackId: string`
- `assetId?: string`
- `src?: string`
- `assetType?: 'video' | 'image' | 'audio'`
- `startSec: number`
- `durationSec: number`
- `inPointSec: number`
- `outPointSec: number`
- `playbackRate?: number`
- `volume?: number`
- `muted?: boolean`
- `transform?: RemotionClipTransform`
- `transitionIn?: RemotionTransition` — legacy v1-compatible field
- `transitionOut?: RemotionTransition` — legacy v1-compatible field
- `segmentRole?: 'hook' | 'body' | 'cta' | 'generic'`

**`RemotionCaptionWord`** (line 76).
- `text: string`
- `startSec: number`
- `endSec: number`

**`RemotionCaptionStyle`** (line 82).
- `presetId: CaptionPresetId`
- `fontFamily: string`
- `fontSize: number`
- `fontWeight: 'normal' | 'bold' | 'black'`
- `color: string`
- `textOpacity?: number` — 0–100
- `backgroundColor?: string`
- `backgroundEnabled?: boolean`
- `backgroundPadding?: number` — 0–200, scales default padding
- `backgroundRadius?: number` — 0–100, 0=square, 100=oval, linear interpolation
- `backgroundOpacity?: number` — 0–100
- `strokeColor?: string`
- `strokeWidth?: number`
- `position: 'top' | 'center' | 'bottom'`
- `positionX?: number` — −50 to 50, percentage offset from center
- `positionY?: number` — −50 to 50, percentage offset from base position
- `animation: 'none' | 'karaoke' | 'fade' | 'pop' | 'bounce' | 'typewriter' | 'highlight'`
- `highlightColor?: string`
- `textCase?: 'none' | 'upper'`
- `maxWidthPercent?: number`
- `lineHeight?: number`
- `letterSpacing?: number`
- `shadow?: boolean`

**`RemotionCaption`** (line 108).
- `id: string`
- `clipId?: string`
- `startSec: number`
- `endSec: number`
- `text: string`
- `words?: RemotionCaptionWord[]`
- `style: RemotionCaptionStyle`
- `segmentRole?: 'hook' | 'body' | 'cta' | 'generic'`

**`BrandTheme`** (line 119).
- `name: string`
- `fontFamily: string`
- `accentColor: string`
- `secondaryColor: string`
- `backgroundColor: string`
- `textColor: string`
- `glow: number`
- `motionSpeed: number`

**`AdSegmentTemplate`** (line 130).
- `id: 'hook' | 'body' | 'cta'`
- `startSec: number`
- `endSec: number`
- `textOptions: string[]`
- `captionPreset: CaptionPresetId`

**`AdTemplate`** (line 138).
- `name: string`
- `segments: { hook: AdSegmentTemplate; body: AdSegmentTemplate; cta: AdSegmentTemplate }`

**`VoiceoverLayer`** (line 147).
- `assetId?: string`
- `src?: string`
- `startSec: number`
- `durationSec?: number`
- `volume: number`

**`RemotionProjectSpec`** (line 155) — root document type.
- `version: RemotionSpecVersion`
- `id: string`
- `title: string`
- `createdAt: string`
- `updatedAt: string`
- `settings: { width: number; height: number; fps: number; backgroundColor: string }`
- `tracks: RemotionTrack[]`
- `clips: RemotionClip[]`
- `captions: RemotionCaption[]`
- `voiceover: VoiceoverLayer[]`
- `transitions?: RemotionClipJunctionTransition[]` — legacy v1 array
- `timelineTransitions?: RemotionTimelineTransition[]` — v2 independent entities
- `brandTheme: BrandTheme`
- `adTemplate: AdTemplate`
- `meta?: Record<string, unknown>`

**`VariantGenerationOptions`** (line 178).
- `count: number`
- `hooks?: string[]`
- `hookPool?: string[]`
- `bodies?: string[]`
- `bodyPool?: string[]`
- `ctas?: string[]`
- `ctaPool?: string[]`
- `toneProfile?: 'direct-response' | 'educational' | 'playful' | 'premium' | string`
- `captionStyleProfile?: 'balanced' | 'punchy' | 'minimal' | string`

#### Constants

**`CAPTION_STYLE_PRESETS`** (line 190) — `Record<CaptionPresetId, Partial<RemotionCaptionStyle>>`.

`'clean-lower-third'` values:
- fontFamily: `'Inter'`, fontSize: `52`, fontWeight: `'bold'`
- color: `'#FFFFFF'`, strokeColor: `'#000000'`, strokeWidth: `4`
- position: `'bottom'`, animation: `'fade'`
- backgroundColor: `'rgba(0,0,0,0.45)'`
- maxWidthPercent: `86`, lineHeight: `1.2`, letterSpacing: `0.2`, shadow: `true`

`'highlight-mode'` values:
- fontFamily: `'Inter'`, fontSize: `58`, fontWeight: `'black'`
- color: `'#FFFFFF'`, strokeColor: `'#0A0A0A'`, strokeWidth: `5`
- position: `'bottom'`, animation: `'highlight'`, highlightColor: `'#FDE047'`
- backgroundColor: `'rgba(0,0,0,0.38)'`
- maxWidthPercent: `90`, lineHeight: `1.2`, letterSpacing: `0.3`, shadow: `true`

---

### `src/remotion/ProjectTimeline.tsx` — Remotion Root Composition

The React component rendered by Remotion inside Chrome. It consumes a `RemotionProjectSpec` and produces every frame of the output video. Registered as composition `id="ProjectTimeline"` via `src/remotion/Root.tsx`.

#### Local Interface

**`ProjectTimelineProps`** (line 23).
- `spec: RemotionProjectSpec`

**`ResolvedTransition`** (line 28) — internal, not exported.
- `id: string`
- `transitionFileId: string`
- `fromSrc: string | undefined`
- `toSrc: string | undefined`
- `fromAssetType: 'video' | 'image' | undefined`
- `toAssetType: 'video' | 'image' | undefined`
- `fromStartFrom: number`
- `toStartFrom: number`
- `startFrame: number`
- `durationInFrames: number`
- `params: Record<string, number | string | boolean>`

#### Internal Constants

**`DEFAULT_SPEC`** (line 42) — the fallback spec used when `spec` prop is null/undefined. Defines 6 default tracks (T1, V3, V2, V1, A1, A2), brand theme with accentColor `'#f97316'`, and an `adTemplate` with hook 0–2s / body 2–6s / cta 6–8s.

#### Internal Functions (not exported)

| Function | Line | Purpose |
|---|---|---|
| `toFrames(seconds, fps)` | 86 | Converts seconds to integer frame count; clamps to `≥ 0` via `Math.max(0, Math.round(...))` |
| `resolveCaptionStyle(style)` | 88 | Merges `CAPTION_STYLE_PRESETS[style.presetId]` base with per-caption overrides |
| `getTrackOrder(trackId, tracks)` | 96 | Returns `track.order` or `999` if not found |
| `clipTransformValues(clip)` | 101 | Extracts `scale`, `rotation`, `x`, `y`, `opacity` from `clip.transform` with defaults |
| `migrateLegacyTransitions(spec)` | 112 | Converts `spec.transitions` (v1 `RemotionClipJunctionTransition[]`) to `RemotionTimelineTransition[]`; maps type strings via `typeToFileId` lookup; computes `startTime` from clip overlap |
| `resolveTimelineTransitions(spec, fps)` | 157 | Prefers `spec.timelineTransitions`; falls back to `migrateLegacyTransitions()`; resolves each transition's `fromSrc`, `toSrc`, `fromStartFrom`, `toStartFrom`, `startFrame`, `durationInFrames` |

#### Internal React Components (not exported)

**`TransitionCompositor`** (line 224) — renders a single `ResolvedTransition` via its `.tsx` component fetched from `getTransition(transition.transitionFileId)`. Wraps in `<AbsoluteFill style={{ zIndex: 3500 }}>`. Returns `null` if the transition component is not registered.

**`CaptionOverlay`** (line 245) — renders a single `RemotionCaption`. Props: `caption: RemotionCaption`, `brandFont: string`.
- Uses `spring()` for enter animation (damping: 18, stiffness: 120, up to 12 frames).
- Computes `activeWordIndex` for karaoke/highlight word tracking via `globalTimeSec`.
- Position logic: `'top'` → `top: 7+offsetY%`; `'center'` → `top: 50+offsetY%, transform: translate(-50%,-50%)`; `'bottom'` → `bottom: 7-offsetY%`.
- Text case: applies `.toUpperCase()` when `style.textCase === 'upper'`.
- Background: only rendered when `style.backgroundEnabled !== false`; opacity from `style.backgroundOpacity ?? 45`.
- Font weight: `'black'` → 900, `'bold'` → 700, else 400.
- zIndex: `5000` (above transitions at 3500).
- Text shadow formula: `0 2px 12px rgba(0,0,0,0.75), 0 0 ${Math.max(8, fontSize * 0.2)}px rgba(0,0,0,0.35)`.

**`VideoVisualClip`** (line 354) — renders one video or image clip with transforms. Props: `clip: RemotionClip`, `fps: number`, `tracks: RemotionTrack[]`.
- `assetType === 'video'` → `<OffthreadVideo>` with `startFrom`, `endAt`, `playbackRate`, `volume`.
- Otherwise → `<Img>` (image, static).
- zIndex: `1000 - trackOrder` (higher-priority tracks render on top).
- objectFit: `'cover'` for both.

**`AudioClip`** (line 394) — renders one audio clip. Props: `clip: RemotionClip`, `fps: number`. Returns `null` if `clip.src` is falsy. Uses Remotion `<Audio>` with `startFrom`, `endAt`, `volume`, `playbackRate`.

#### Exported Component

**`ProjectTimeline`** (line 413) — the composition root. Props: `{ spec?: RemotionProjectSpec }`.

Render order (bottom to top):
1. `<AbsoluteFill>` with `backgroundColor` from `settings` or `brandTheme`.
2. Visual clips (video/image) sorted by `startSec` then `trackOrder`, each in a `<Sequence from=... durationInFrames=...>`.
3. Audio clips, each in a `<Sequence>`.
4. Voiceover layers (skips entries with no `src`); `durationInFrames` defaults to `toFrames(3600, fps)` when `voice.durationSec` is undefined.
5. Transition compositors (zIndex 3500).
6. Caption overlays (zIndex 5000).

`useMemo` is used for `visualClips`, `audioClips`, and `resolvedTransitions` — all depend on `safeSpec`.

---

### `scripts/remotion-core/spec.js` — Spec Normalization, Validation, and Variant Generation

Pure Node.js ESM module. No Remotion dependency. Used by both `render.js` and `remotion-core-cli.js`.

#### Exported Constants

| Name | Line | Value |
|---|---|---|
| `SPEC_VERSION_V1` | 3 | `'1.0'` |
| `SPEC_VERSION_V2` | 4 | `'2.0'` |
| `CAPTION_PRESETS` | 955 (re-export) | Same two presets as `remotion-core.ts` plus `highlightColor: '#FFD700'` for `clean-lower-third` and `textCase: 'upper'` for `highlight-mode` |
| `DEFAULT_TRACKS` | 955 (re-export) | T1/V3/V2/V1/A1/A2 with orders 0–5 |
| `TONE_PROFILES` | 955 (re-export) | `direct-response`, `educational`, `playful`, `premium` (see below) |
| `CAPTION_STYLE_PROFILES` | 955 (re-export) | `balanced`, `punchy`, `minimal` (see below) |

**`TONE_PROFILES`** (line 58):
- `direct-response`: hookPrefix `['Stop scrolling: ', 'Quick truth: ']`, ctaSuffix `' today.'`
- `educational`: hookPrefix `['Here's the logic: ', 'Let's break it down: ']`, ctaSuffix `' Learn more.'`
- `playful`: hookPrefix `['🔥 ', '✨ ']`, ctaSuffix `' Let's go!'`
- `premium`: hookPrefix `['Premium fix: ', 'High-performance move: ']`, ctaSuffix `' Upgrade now.'`

**`CAPTION_STYLE_PROFILES`** (line 81):
- `balanced`: empty overrides for hook/body/cta (no changes).
- `punchy`: hook → textCase `'upper'`, animation `'pop'`, fontWeight `'black'`, fontSizeDelta `+6`; body → animation `'fade'`, fontSizeDelta `+2`; cta → textCase `'upper'`, animation `'highlight'`, fontWeight `'black'`, fontSizeDelta `+4`.
- `minimal`: hook/body/cta → animation `'fade'`, varying backgroundOpacity, strokeWidth `2`, fontSizeDelta `−4/−5/−3`.

#### Zod Schemas (internal, not exported directly)

| Schema | Line | Validates |
|---|---|---|
| `zLegacyTransition` | 99 | `RemotionTransition` (type, durationSec, easing) |
| `zJunctionTransition` | 105 | `RemotionClipJunctionTransition`; superRefine: `type === 'custom'` requires `customTransitionId` |
| `zCaptionStyle` | 119 | `RemotionCaptionStyle` |
| `zClipTransform` | 138 | `RemotionClipTransform` |
| `zTrack` | 146 | `RemotionTrack` |
| `zClip` | 153 | `RemotionClip`; volume range 0–4; playbackRate min 0 |
| `zCaptionWord` | 172 | `RemotionCaptionWord` |
| `zCaption` | 178 | `RemotionCaption` |
| `zVoiceover` | 189 | `VoiceoverLayer` |
| `zBrandTheme` | 197 | `BrandTheme`; glow 0–1; motionSpeed 0.25–3 |
| `zAdSegment` | 208 | `AdSegmentTemplate` |
| `zAdTemplate` | 216 | `AdTemplate` |
| `zSpecV2` | 225 | Full `RemotionProjectSpec` v2; superRefine checks transition clip references and same-track constraint for non-custom transitions |

#### Internal Helper Functions (not exported)

| Function | Line | Purpose |
|---|---|---|
| `numberOr(value, fallback)` | 278 | Returns `Number(value)` if finite, else `fallback` |
| `positiveNumberOr(value, fallback, min)` | 282 | Like `numberOr` but clamps to `≥ min` (default 0.0001) |
| `clamp(value, min, max)` | 288 | Standard clamp |
| `stringOr(value, fallback)` | 292 | Returns value if string, else fallback |
| `arrayOr(value, fallback)` | 296 | Returns value if array, else fallback |
| `ensureLegacyTransition(value, fallbackType)` | 300 | Coerces a raw object to a valid `RemotionTransition` |
| `ensureJunctionTransition(value, index)` | 309 | Coerces raw object to valid `RemotionClipJunctionTransition` |
| `mapLegacyTransitionToJunction(type)` | 326 | `'fade'` → `'crossfade'`; `'slide-left'` → `'slide-left'`; `'slide-right'` → `'slide-right'`; all others → `'none'` |
| `getSpecDurationSec(spec)` | 351 | Max of clip ends, caption ends, voiceover ends; minimum `2` |
| `normalizeTemplate(template, durationSec)` | 461 | Merges caller template with `createHookBodyCtaTemplate` defaults |
| `normalizeTracks(rawTracks)` | 492 | Falls back to `DEFAULT_TRACKS`; sorts by `order` |
| `normalizeClips(rawClips)` | 503 | Sanitises all numeric fields; `assetType` defaults to `'video'` |
| `normalizeCaptions(rawCaptions)` | 535 | Synthesises `words` via `textToWords()` when missing |
| `normalizeVoiceover(rawVoiceover)` | 564 | Sanitises fields; `durationSec` becomes `undefined` if not finite |
| `deriveTransitionsFromLegacyClips(clips)` | 574 | Inspects per-clip `transitionIn`/`transitionOut` fields; emits junction transitions between adjacent clips on the same track |
| `clampTransitionsToOverlap(clips, rawTransitions)` | 615 | Skips transitions where clips don't overlap or are cross-track; clamps duration to actual overlap; returns `{ transitions, warnings }` |
| `normalizeBaseSpec(rawSpec)` | 661 | Assembles the normalised v1 base; calls all `normalize*` helpers; runs `tagCaptionSegments` |
| `getRoleForTime(timeSec, adTemplate)` | 431 | Maps a timeline position to `'hook' | 'body' | 'cta' | 'generic'` based on `adTemplate.segments` boundaries |
| `replaceTemplateTokens(text, values)` | 811 | Replaces `{{HOOK}}`, `{{BODY}}`, `{{CTA}}` placeholders |
| `pickFrom(values, index, fallback)` | 818 | Cycles through array using `index % values.length` |
| `resolvePool(primary, secondary, fallback)` | 823 | Selects first non-empty array among three |
| `canonicalText(text)` | 829 | Collapses whitespace and trims |
| `withSentenceEnding(text)` | 833 | Appends `.` if text does not end with `.`, `!`, or `?` |
| `applyToneProfile(text, role, toneProfile, index)` | 840 | Prepends hookPrefix (hook role) or appends ctaSuffix (cta role) from `TONE_PROFILES[toneProfile]` |
| `applyCaptionStyleProfile(style, role, captionStyleProfile)` | 868 | Merges `CAPTION_STYLE_PROFILES[captionStyleProfile][role]` into style; applies `fontSizeDelta` clamped 18–220 |

#### Exported Functions

**`deepClone(value)`** (line 333) — `JSON.parse(JSON.stringify(value))`. Used to clone base specs before mutating for variants.

**`createDefaultBrandTheme(overrides?)`** (line 337) — Returns a brand theme object with defaults: name `'HyperEdit Growth Theme'`, fontFamily `'Inter'`, accentColor `'#f97316'`, secondaryColor `'#22d3ee'`, backgroundColor `'#0a0a0a'`, textColor `'#ffffff'`, glow `0.4`, motionSpeed `1`. Merged with `overrides`.

**`createHookBodyCtaTemplate(durationSec?, overrides?)`** (line 361) — Builds a `hook-body-cta` `AdTemplate`. hookEnd = `max(1.5, durationSec * 0.2)`. ctaStart = `max(hookEnd + 0.5, durationSec * 0.78)`. Contains example copy for a "Cloud Pillow" product. Accepts `overrides` to replace defaults.

**`normalizeCaptionStyle(style?, fallbackPreset?)`** (line 406) — Merges a preset base with caller overrides. Clamps `fontSize` 8–220. Validates enum fields (`fontWeight`, `position`, `animation`, `textCase`) against allowed values. Returns a complete `RemotionCaptionStyle`.

**`tagCaptionSegments(captions, adTemplate)`** (line 440) — Maps each caption's `startSec` to a segment role via `getRoleForTime`. Only assigns if `caption.segmentRole` is not already set.

**`textToWords(text?, startSec?, endSec?)`** (line 447) — Splits text on whitespace; distributes equal time per word across `[startSec, endSec]`. Returns `RemotionCaptionWord[]`. Last word's `endSec` is exactly `endSec`.

**`RemotionSpecValidationError`** (line 695) — Custom error class. Fields: `name = 'RemotionSpecValidationError'`, `issues: Array<{path, message, code}>`, `payload: Record<string, unknown>`.

**`formatZodIssues(issues?)`** (line 704) — Maps Zod issues to `{ path: string; message: string; code: string }[]`.

**`migrateSpecToV2(rawSpec?, { fromVersion }?)`** (line 712) — Normalises raw input via `normalizeBaseSpec`, then upgrades transitions. Prefers `rawSpec.transitions` if present; otherwise derives them from legacy per-clip fields via `deriveTransitionsFromLegacyClips`. Runs `clampTransitionsToOverlap`. Stores migration metadata and `transitionWarnings` in `spec.meta`.

**`validateSpecV2(spec)`** (line 739) — Runs `zSpecV2.safeParse`. Throws `RemotionSpecValidationError` on failure. Returns `parsed.data` on success.

**`parseSpecInput(rawSpec?, options?)`** (line 754) — The primary public entry point for spec normalisation. Accepts any version (`'1.0'`, `'2.0'`, `''`, `'v1'`). Always normalises to v2 then validates. Returns `{ spec, migration: { migrated, fromVersion, toVersion }, warnings }`. Throws `RemotionSpecValidationError` for unsupported versions.

**`normalizeSpec(rawSpec?)`** (line 807) — Thin wrapper around `parseSpecInput`. Returns only `spec`.

**`generateAdVariants(baseSpecInput, options?)`** (line 880) — Generates `options.count` (default 1) `RemotionProjectSpec` variants. Each variant:
1. Picks hook/body/cta text from pools via `pickFrom` (cycling with `index`, `index*2`, `index*3`).
2. Applies tone profile via `applyToneProfile`.
3. Deep-clones base spec; updates `id`, `title`, `updatedAt`, `meta.variantIndex`, `meta.strategy`, `meta.profiles`, `meta.selections`.
4. For each caption: replaces `{{HOOK}}`/`{{BODY}}`/`{{CTA}}` tokens; assigns role-appropriate preset; applies caption style profile; regenerates `words` via `textToWords`.

---

### `scripts/remotion-core/render.js` — Remotion Renderer

Server-side ESM module. Imported by both `local-ffmpeg-server.js` and `remotion-core-cli.js`.

#### Module-Level State (singletons)

| Variable | Line | Description |
|---|---|---|
| `_dirs` | 45 | Cached directory config; initialised lazily by `getDirs()` |
| `cachedBundlePromise` | 74 | In-flight or resolved webpack bundle promise |
| `cachedBundlePath` | 75 | Resolved path to the last successful bundle |
| `bundledTransitionSet` | 76 | Sorted comma-joined string of custom transition IDs; key for cache invalidation |
| `cachedBrowserPromise` | 127 | In-flight or resolved Chrome instance promise |
| `cachedBrowserInstance` | 128 | Resolved Chrome instance for explicit `.close()` on invalidation |
| `browserConfigKey` | 129 | JSON fingerprint of `chromeMode` + `gl` + `headless`; invalidates on config change |

#### Directory Layout (resolved by `getDirs()`, line 47)

- `HYPEREDIT_OUTPUT` env var (default: `{projectRoot}/.output`) controls root.
- `{HYPEREDIT_OUTPUT}/cache/bundles` — webpack bundles.
- `{HYPEREDIT_OUTPUT}/cache/temp` — Remotion intermediate files (JPEG frames, pre-encode MP4).
- On init, `process.env.TMPDIR`, `TEMP`, `TMP` are all set to `tempDir` so Remotion's internal temp creation goes to the output drive.
- Chrome profile goes to `HYPEREDIT_TEMP_DIR` (ramdisk) when set; otherwise falls back to `tempDir`.

#### Internal Functions (not exported)

| Function | Line | Purpose |
|---|---|---|
| `makeProgressLogger(totalFrames, onProgressCallback)` | 15 | Returns an `onProgress` callback; writes `\r[Remotion] Rendering: X% ...` to stdout; calls optional `onProgressCallback({pct, renderedFrames, totalFrames, elapsed})` |
| `getDirs()` | 47 | Lazy-initialises directory paths and env vars; creates directories if missing |
| `getBrowserConfigKey(hw)` | 138 | Returns `JSON.stringify({chromeMode, gl, headless})` for cache keying |
| `getBrowser(hwOptions)` | 146 | Returns (and caches) a Chrome browser instance via `openBrowser('chrome', ...)`; swaps `TEMP` to ramdisk before launch; restores `TEMP` to `tempDir` after launch |
| `getBundleUrl(customTransitionIds?)` | 92 | Returns (and caches) a webpack bundle path via `bundle()`; cache is invalidated if the set of custom transition IDs changes; `enableCaching` is false when custom transitions are present |
| `copyAssetsToBundle(bundlePath, spec, assetPathMap)` | 193 | Hard-links (falls back to `copyFile`) session asset files into the bundle directory; rewrites `clip.src` from `http://localhost:3333/session/{id}/assets/{assetId}/stream` to a relative path like `/session/{id}/assets/{assetId}/stream.mp4`; processes both `spec.clips` and `spec.voiceover` entries |
| `withDefaults(spec)` | 253 | Calls `parseSpecInput` then fills in `settings`, `clips`, `captions`, `voiceover`, `tracks`, `transitions` with defaults |

#### Exported Functions

**`invalidateBundleCache()`** (line 78) — Clears `cachedBundlePromise`, `cachedBundlePath`, `bundledTransitionSet`. Deletes old bundle directory asynchronously via `rm(..., { recursive: true, force: true })`.

**`invalidateBrowserCache()`** (line 130) — Clears browser cache variables; calls `old.close({ silent: true })` on the previous instance.

**`renderSpecWithRemotion({ spec, outputPath, compositionId?, preview?, codec?, imageFormat?, logLevel?, concurrency?, assetPathMap?, renderOptions?, onProgress? })`** (line 274) — Primary render function.

Parameters:
- `spec` — `RemotionProjectSpec` (required)
- `outputPath` — output MP4 path (required)
- `compositionId` — defaults to `'ProjectTimeline'`
- `preview` — boolean; affects CRF/bitrate/JPEG quality via `getRenderMediaOptions`
- `codec` — explicit codec override; default `'h264'`
- `imageFormat` — default `'jpeg'`
- `logLevel` — default `'info'`
- `concurrency` — parallel Chrome instances; overrides HW config
- `assetPathMap` — `Map<assetId, filePath>` for hard-linking assets into bundle
- `renderOptions` — user-facing render overrides (see below)
- `onProgress` — `({pct, renderedFrames, totalFrames, elapsed}) => void`

`renderOptions` fields processed (lines 383–469):
- `qualityMode: 'bitrate' | 'crf'` + `videoBitrate` or `crf` — mutually exclusive
- `audioCodec` — passed through to `renderMedia`
- `audioBitrate` — passed through
- `muted: true` — passed through
- `qualityMode === 'crf'` → deletes `hardwareAcceleration` (incompatible with Remotion HW accel)
- `hardwareAcceleration` — passed through if qualityMode is not crf
- `x264Preset` — e.g. `'fast'`, `'medium'`
- `proResProfile` — only applied when `codec === 'prores'`, mapped to `proResProfileName`
- `concurrency > 0` — overrides HW config concurrency
- `scale !== 1` — render scale factor
- `pixelFormat` — e.g. `'yuv420p'`
- `enableCustomFfmpegFlags + customFfmpegFlags` — appended to stitcher pass via `ffmpegOverride`
- `sampleRate !== 48000` — injected as `-ar` flag via `ffmpegOverride`
- `outputWidth + outputHeight` — override composition dimensions
- `outputFps` — override composition frame rate

Returns `{ outputPath, compositionId, width, height, fps, durationInFrames }`.

**`renderDynamicAnimation({ sceneData, outputPath, width?, height?, fps?, logLevel?, onProgress? })`** (line 486) — Renders the `'DynamicAnimation'` composition. Uses `sceneData.scenes` as `inputProps`. Always `codec: 'h264'`, `audioCodec: 'aac'`. No `assetPathMap` support. Returns `{ outputPath, compositionId, width, height, fps, durationInFrames, durationInSeconds }`.

**`renderVariantBatch({ variants, outDir, prefix?, preview?, compositionId?, logLevel? })`** (line 568) — Iterates `variants` array sequentially; calls `renderSpecWithRemotion` for each; output filenames are `{prefix}-01.mp4`, `{prefix}-02.mp4`, etc. Returns array of render results.

---

### `scripts/remotion-core/timeline-to-spec.js` — Timeline-to-Spec Converter

Converts HyperEdit's internal project model (as stored in `useProject` state) into a `RemotionProjectSpec`. Used by `local-ffmpeg-server.js` when handling `POST /session/{id}/render`.

#### Internal Functions (not exported)

| Function | Line | Purpose |
|---|---|---|
| `getProjectDurationSec(clips)` | 18 | `max(clip.start + clip.duration)` across all clips |
| `inferSegmentRole(clip, adTemplate)` | 22 | Maps `clip.startSec` to hook/body/cta/generic using `adTemplate.segments` boundaries |
| `buildAssetSrc({ sessionId, assetId, asset, baseUrl })` | 33 | Returns asset URL; prefers `asset.publicPath`, then `asset.path` (when no sessionId), then `{baseUrl}/session/{sessionId}/assets/{assetId}/stream` |
| `convertCaptionWords(words, captionStartSec, captionEndSec, fallbackText)` | 49 | Converts editor-format words (`{text, start, end}` relative to clip) to spec-format words (`{text, startSec, endSec}` absolute); falls back to `textToWords()` when `words` is empty |

#### Exported Function

**`timelineToRemotionSpec({ project, assets?, captionData?, transitions?, timelineTransitions?, sessionId, baseUrl?, specId?, title?, brandTheme?, adTemplate?, defaultCaptionPreset? })`** (line 61).

Parameters:
- `project` — project state object with `tracks`, `clips`, `settings`
- `assets` — array of asset objects (each with `id`, `type`, `publicPath`, `path`)
- `captionData` — `Record<clipId, { words, style }>` (caption content keyed by clip ID)
- `transitions` — v1 junction transitions array (only included if non-empty)
- `timelineTransitions` — v2 timeline transitions array (only included if non-empty)
- `sessionId` — used to build asset stream URLs
- `baseUrl` — defaults to `'http://localhost:3333'`
- `specId`, `title` — override spec identity fields
- `brandTheme`, `adTemplate` — override theme and template
- `defaultCaptionPreset` — preset for captions not on hook/cta roles; defaults to `'clean-lower-third'`

Processing logic:
- Tracks without matching `trackMap` entry are still processed.
- Clips on track `T1` or `clip.trackId === 'T1'` → converted to captions (not `clips`). Caption text is derived from `captionData[clip.id].words`. Role-to-preset mapping: hook/cta → `'highlight-mode'`; body/generic → `defaultCaptionPreset`.
- Clips on track `A2` additionally produce a `voiceover` entry.
- All clips use `playbackRate: 1`, `volume: 1`, `muted: false` as defaults (not read from source clip).
- Default `transitionIn` and `transitionOut` on non-caption clips: `{ type: 'fade', durationSec: 0.12 }`.
- Calls `normalizeSpec()` at the end to guarantee a valid v2 spec.

Returns a fully validated `RemotionProjectSpec`.

---

### `scripts/remotion-core/ad-intelligence.js` — Heuristic Ad Scoring

Deterministic scoring engine. No AI, no external calls. Pure text analysis.

#### Module-Level Constants

| Name | Line | Value |
|---|---|---|
| `STOP_WORDS` | 4 | Set of 33 common English words excluded from repeat-token analysis |
| `CLARITY_KEYWORDS` | 9 | `['how', 'why', 'because', 'simple', 'easy', 'clear', 'proven', 'exact', 'step', 'real']` |
| `URGENCY_KEYWORDS` | 10 | `['now', 'today', 'limited', 'hurry', 'instant', 'instantly', 'before', 'deadline', 'last chance', 'quick']` |
| `BENEFIT_KEYWORDS` | 11 | `['save', 'comfort', 'better', 'faster', 'easier', 'growth', 'results', 'pain-free', 'risk-free', 'improve']` |
| `ROLE_IDEAL_WORDS` | 13 | hook: 4–12 words; body: 10–28 words; cta: 3–12 words |

#### Internal Functions (not exported)

| Function | Line | Purpose |
|---|---|---|
| `clamp(value, min, max)` | 19 | Standard clamp |
| `tokenize(text)` | 23 | Lowercases, strips non-alphanumeric (except `-`), splits on whitespace |
| `keywordHits(text, dictionary)` | 32 | `dictionary.filter(kw => text.includes(kw))`; returns matching keywords |
| `countRepeatedTokens(tokens)` | 37 | Counts tokens appearing >1 time (excluding stop words and tokens shorter than 3 chars); returns `{ repeatedWordTypes, repeatedWordInstances }` |
| `lengthScore(role, wordCount)` | 60 | 30 pts if within `ROLE_IDEAL_WORDS[role]` ideal range; penalty of `3.5 × distance` outside range; clamped 4–30 |
| `segmentScore(role, text)` | 70 | Computes per-segment score: `lengthScore + clarityScore(max 20) + urgencyScore(max 18 for hook/cta, 12 for body) + benefitScore(max 20 for hook/cta, 16 for body) - repetitionPenalty(max 22)`; returns full breakdown object |
| `extractSegments(spec)` | 114 | Prefers `spec.meta.selections.{hook,body,cta}`; falls back to first caption with matching `segmentRole` |

#### Exported Functions

**`scoreVariant(spec, index?)`** (line 136) — Scores one `RemotionProjectSpec`.

1. Calls `extractSegments(spec)` to get hook/body/cta text.
2. Calls `segmentScore` for each role.
3. Computes cross-segment token repetition penalty (max 15 pts): repeated types × 1.8 + instances × 0.8.
4. Weighted blend: hook × 0.45 + body × 0.2 + cta × 0.35 − crossSegmentPenalty; clamped 0–100.

Returns:
```
{
  variantIndex: number,
  variantId: string,
  title: string,
  score: number,          // 2 decimal places
  penalties: {
    crossSegmentRepetitionPenalty: number,
    repeatedWordTypes: number,
    repeatedWordInstances: number,
  },
  segments: {
    hook: segmentScoreResult,
    body: segmentScoreResult,
    cta: segmentScoreResult,
  },
}
```

Each `segmentScoreResult`:
```
{
  role, text, words, score,
  breakdown: { lengthScore, clarityScore, urgencyScore, benefitScore, repetitionPenalty },
  signals: { clarityHits, urgencyHits, benefitHits, repeatedWordTypes, repeatedWordInstances },
}
```

**`scoreVariantBatch(variants?, options?)`** (line 174) — Maps `scoreVariant` over all variants; sorts descending by score; adds `rank` field (1-indexed). Returns:
```
{
  generatedAt: string,
  batchLabel: string,
  variantCount: number,
  averageScore: number,
  bestVariant: scoredVariant | null,
  variants: scoredVariant[],   // sorted by rank
  rubric: {
    deterministic: true,
    weightedBlend: { hook: 0.45, body: 0.2, cta: 0.35 },
    signals: { clarityKeywords, urgencyKeywords, benefitKeywords },
  },
}
```

**`buildMarkdownSummary(report)`** (line 208) — Generates a markdown string from a `scoreVariantBatch` report. Sections: header, batch metadata, ranked variants table (rank, ID, hook/body/cta text, repetition penalty), notes footer.

**`writeCampaignReport(outDir, report, options?)`** (line 243) — Writes two files:
- `{outDir}/{prefix}.json` — `JSON.stringify(report, null, 2)`
- `{outDir}/{prefix}.md` — `buildMarkdownSummary(report)`

`options.prefix` defaults to `'campaign-intelligence'`. Returns `{ jsonPath, mdPath }`.

---

### `scripts/remotion-core-cli.js` — CLI Entry Point

Node.js ESM script with shebang (`#!/usr/bin/env node`). Dispatches to sub-commands.

#### Internal Functions (not exported)

| Function | Line | Purpose |
|---|---|---|
| `parseArgs(argv)` | 12 | Minimal `--key value` and `--flag` parser; positional args go to `args._` |
| `readSpec(path)` | 34 | Reads JSON from path; calls `parseSpecInput` with `source: 'cli:{path}'`; returns `{ spec, migration, warnings }` |
| `csv(input, fallback)` | 41 | Converts a comma-separated string or array to `string[]` |
| `getVariantOptions(args)` | 47 | Maps CLI args to `VariantGenerationOptions` |
| `logMigration(migration, warnings)` | 61 | Logs migration and transition warnings to stdout |
| `writeVariantSpecs(variants, specPath, specsDir)` | 72 | Writes each variant as `{basename}-variant-NN.json` to `specsDir` |
| `commandRender(args)` | 80 | Implements `render` command; requires `--spec` and `--out` |
| `commandVariants(args, shouldRender, forceScoreReport)` | 101 | Implements `variants` and `batch` commands; generates variants, writes specs, optionally renders and scores |
| `commandCampaign(args)` | 168 | Implements `campaign` command; auto-generates `--campaign-label` timestamp; calls `commandVariants(args, true, true)` |
| `printHelp()` | 181 | Prints usage to stdout |
| `main()` | 193 | Entry point; dispatches on `args._[0]` |

#### CLI Commands

| Command | Required flags | Optional flags | Behaviour |
|---|---|---|---|
| `render` | `--spec <file.json>`, `--out <output.mp4>` | `--preview` | Renders one spec to MP4 |
| `variants` | `--spec <file.json>`, `--out-dir <dir>` | `--count`, `--hook-pool`, `--body-pool`, `--cta-pool`, `--hooks`, `--bodies`, `--ctas`, `--tone-profile`, `--caption-style-profile`, `--scores`, `--scores-prefix`, `--campaign-label` | Generates N variant spec JSON files; optionally scores |
| `batch` | `--spec <file.json>`, `--out-dir <dir>` | Same as `variants` plus `--preview`, `--prefix`, `--no-scores` | Generates + renders N variants; always scores unless `--no-scores` |
| `campaign` | `--spec <file.json>`, `--out-dir <dir>` | Same as `batch` | Alias for batch with `forceScoreReport = true` and auto-generated `--campaign-label` |

Error handling: `RemotionSpecValidationError` is caught in `main().catch()`; prints structured issue list and exits with code `2`. Other errors exit with code `1`.

---

## Connections

- [[local-ffmpeg-server]] — calls `renderSpecWithRemotion`, `renderDynamicAnimation`, and `timelineToRemotionSpec` directly; provides `assetPathMap` for hard-linking; is single-threaded and therefore blocks during `renderMedia()`, which is why hard-linking is mandatory
- [[remotion-transitions-registry]] — `getTransition(id)` called by `TransitionCompositor` at line 227 of `ProjectTimeline.tsx`; `registerTransition` called by each transition component at module load
- [[remotion-root]] — `src/remotion/Root.tsx` registers `ProjectTimeline` and `DynamicAnimation` as Remotion compositions; `src/remotion/index.tsx` registers the root and re-exports types
- [[hwaccel-config]] — `getRenderMediaOptions(isPreview)` called at line 319 of `render.js`; determines CRF/bitrate, concurrency, offthreadVideoThreads, Chrome mode
- [[hw-detect]] — imported by `hwaccel-config.js`; provides `getCapabilities()` which reports CPU cores, RAM, preferred GPU encoder, GL backend
- [[useProject]] — the React hook that owns `clips`, `assets`, `captionData`, `settings`; serialises state into the shape consumed by `timelineToRemotionSpec`
- [[DynamicAnimation]] — separate Remotion composition rendered by `renderDynamicAnimation()`; not rendered by `ProjectTimeline`

---

## Known Issues

### Disabled / Incomplete Features

1. **Several `RemotionCaptionStyle` animation types are declared but not rendered.** `RemotionCaptionStyle.animation` accepts `'none' | 'karaoke' | 'fade' | 'pop' | 'bounce' | 'typewriter' | 'highlight'`. In `CaptionOverlay.renderText()` (line 278 of `ProjectTimeline.tsx`), only `'karaoke'` and `'highlight'` trigger word-level rendering; all other values (`'fade'`, `'pop'`, `'bounce'`, `'typewriter'`) return the raw string without any animation effect. The `spring()` enter animation at line 256 applies to all captions regardless of `animation` value — it is not conditional.

2. **`timelineToRemotionSpec` ignores clip volume, muted, and playbackRate.** At lines 143–148 of `timeline-to-spec.js`, `playbackRate`, `volume`, and `muted` are all hardcoded to `1`, `1`, and `false` respectively. Any values set on the source clip by the user are silently discarded.

3. **`timelineToRemotionSpec` ignores `clip.transitionIn` / `clip.transitionOut` from the source clip.** Lines 145–146 always write `{ type: 'fade', durationSec: 0.12 }` regardless of the editor state. User-configured per-clip transitions are not passed to the spec.

4. **Bundle cache is disabled for any spec containing custom transitions.** In `getBundleUrl()` at line 105 of `render.js`, `enableCaching: !hasCustom` — so any render involving a registered custom transition forces a full webpack rebuild every time `invalidateBundleCache()` is called.

5. **`CAPTION_PRESETS` in `spec.js` and `CAPTION_STYLE_PRESETS` in `remotion-core.ts` are not identical.** The server-side `spec.js` version of `clean-lower-third` includes `highlightColor: '#FFD700'` and `textCase: 'none'`; the frontend `remotion-core.ts` version does not include those fields. The `highlight-mode` preset in `spec.js` includes `textCase: 'upper'`; the `remotion-core.ts` version does not. This divergence can cause different styling between preview (frontend) and final render (server).

6. **Remotion bundled FFmpeg has no GPU encoder on Windows/Linux.** Documented at line 129 of `render.js` and in `hwaccel-config.js` line 130. On non-macOS platforms, `hardwareAcceleration` is never set; all Remotion encoding uses `libx264`. Only direct FFmpeg spawn calls (`local-ffmpeg-server.js`) use the system FFmpeg with NVENC/VAAPI/etc.

7. **`renderVariantBatch` renders sequentially, not in parallel.** Line 582 of `render.js` uses a `for` loop with `await` inside, so each variant renders one-at-a-time. There is no parallelisation option.

8. **`VoiceoverLayer` entries do not receive `assetPathMap` treatment in `copyAssetsToBundle`.** The function at line 193 of `render.js` does process `spec.voiceover` entries (line 202–203), so voiceover `src` URLs are rewritten. However, if `assetPathMap` is not provided by the caller, voiceover assets point at `localhost:3333` and will fail to load during rendering (same deadlock risk as video assets).

9. **`zSpecV2` superRefine cross-track transition check only applies to non-custom transitions.** Line 268 of `spec.js`: `if (from.trackId !== to.trackId && transition.type !== 'custom')` — custom transitions on different tracks silently pass validation even though support for cross-track custom transitions in `migrateLegacyTransitions` is limited to the type-to-fileId mapping.

10. **`migrateLegacyTransitions` in `ProjectTimeline.tsx` maps `type === 'custom'` using `t.customTransitionId`** (line 132–134), but this field is typed as `unknown` via a cast (`as Record<string, unknown>`). If the junction transition was not created through the typed interface, `customTransitionId` will silently fall back to `'builtin-crossfade'`.
