---
title: Video Preview
type: module
source_files:
  - src/react-app/components/VideoPreview.tsx
  - src/react-app/components/CaptionRenderer.tsx
  - src/react-app/components/TransitionPreview.tsx
tags: [preview, video, captions, transitions, playback]
---

## Overview

Composites multi-layer video preview with overlay dragging, caption rendering, and live transition previews via @remotion/player. Manages base video playback, overlay sync, and spatial transforms for all visible clips at current time.

## Architecture

```text
┌─────────────────────────────────────────────────────┐
│ VideoPreview (forwardRef)                            │
│  ├─ Base video <video> (V1 track)                   │
│  ├─ Overlay layers (V2, V3 — video/image)           │
│  │    └─ Draggable with transform                   │
│  ├─ Audio layers (A1, A2 — <audio> elements)        │
│  ├─ CaptionRenderer (T1 track)                      │
│  └─ TransitionPreview × N (@remotion/player)        │
└─────────────────────────────────────────────────────┘
```

## Key Components

### VideoPreview.tsx

#### Interfaces

**ClipTransform** (lines 7–17):
`x`, `y`, `scale`, `rotation`, `opacity`, `cropTop`, `cropBottom`, `cropLeft`, `cropRight` — all optional numbers.

**ClipLayer** (lines 19–29):
`id`, `url`, `type` ('video'|'image'|'audio'|'caption'), `trackId`, `clipTime`, `transform?`, `captionWords?`, `captionStyle?`

**VideoPreviewProps** (lines 31–40):
`layers?`, `isPlaying?`, `aspectRatio?`, `onLayerMove?`, `onLayerSelect?`, `selectedLayerId?`, `activeTransitions?`, `currentTime?`

**VideoPreviewHandle** (lines 42–45):
`seekTo(time)`, `getVideoElement()` — exposed via `useImperativeHandle`

#### Functions

| Function | Line | Purpose |
|----------|------|---------|
| `getTransformStyles` | 48 | Builds CSS from ClipTransform (translate, scale, rotate, opacity, clip-path for crop) |
| `VideoPreview` | 86 | Main forwardRef component |
| Base layer detection | 104 | Finds V1 video layer for audio control |
| `sortedLayers` | 116–125 | Orders by track: V1=0, V2=1, V3=2, T*=10 |
| `useImperativeHandle` | 127–132 | Exposes seekTo/getVideoElement |
| Source reload effect | 136–149 | Manual `video.load()` on URL change preserving audio permission |
| Seek when paused | 152–160 | Syncs `video.currentTime` when scrubbing (threshold 0.1s) |
| Play/pause base | 163–174 | Controls base video play/pause |
| Play/pause overlays | 177–185 | Controls overlay video/audio elements |
| Overlay sync | 188–204 | Seeks overlay media when scrubbing |
| `handleLoaded` | 207–211 | Seek on initial load |
| `handleLayerMouseDown` | 214–232 | Start drag (V1 exempt — only overlays draggable) |
| Drag effect | 235–260 | Window mousemove/mouseup for layer dragging |
| `overlayLayers` | 273–276 | Filters out base video from sorted layers |

#### Rendering Logic

- Empty state: Shows placeholder with icons
- Base video: Rendered as dedicated `<video>` with stable key
- Overlays: Each rendered with transform styles, draggable cursor, selection ring
- Captions: `CaptionRenderer` for layers with `type === 'caption'`
- Transitions: `TransitionPreview` for each `activeTransitions` entry

---

### CaptionRenderer.tsx (187 lines)

#### CaptionRendererProps (lines 4–8)

| Prop | Type |
|------|------|
| `words` | `CaptionWord[]` |
| `style` | `CaptionStyle` |
| `currentTime` | `number` (within caption clip) |

#### Key Logic

- `adjustedTime` (line 12): Applies `style.timeOffset` shift
- `visibleWords` + `activeWordIndex` (lines 15–37): Determines visible words per animation type (typewriter filters by start time)
- `resolvedBgColor` (lines 40–45): Computes background rgba from `backgroundOpacity` (default 45%)
- `positionStyles` (lines 48–83): Absolute positioning based on `style.position` + X/Y offsets
- `textStyles` (lines 86–116): Font, color, stroke via text-shadow, background padding/radius
- `getWordStyle` (lines 119–165): Per-word animation styles

#### Animations Supported

| Animation | Effect |
|-----------|--------|
| `karaoke` | Active word changes color |
| `highlight` | Active word gets background + color change |
| `fade` | Words fade in as they start |
| `pop` | Active word scales to 1.2x |
| `bounce` | Active word translates -4px Y |
| `typewriter` | Words appear sequentially |
| `none` | No per-word animation |

---

### TransitionPreview.tsx (133 lines)

#### ActiveTransition interface (lines 6–18)

| Field | Type |
|-------|------|
| `id` | `string` |
| `transitionFileId` | `string` |
| `startTime` | `number` |
| `durationSec` | `number` |
| `fromSrc` | `string?` |
| `toSrc` | `string?` |
| `fromAssetType` | `'video' \| 'image'?` |
| `toAssetType` | `'video' \| 'image'?` |
| `fromStartFrom` | `number?` |
| `toStartFrom` | `number?` |
| `params` | `Record<string, number \| string \| boolean>` |

#### TransitionPreviewProps (lines 20–26)

`transition`, `currentTime`, `fps`, `width`, `height`

#### Logic

- `TransitionComposition` (line 29): Inner component that loads transition from registry via `getTransitionEntry`
- `TransitionPreview` (line 71): Mounts `@remotion/player` Player once per transition, drives frame via `seekTo` — never re-mounts per tick
- Frame calculation (line 84): `targetFrame = clamp(round((currentTime - startTime) * fps), 0, durationInFrames-1)`
- Player renders with `pointerEvents: 'none'`, `zIndex: 50`

## Data Flow

1. Home.tsx calls `getPreviewLayers()` → produces `ClipLayer[]` with absolute timestamps
2. VideoPreview receives layers + activeTransitions + currentTime
3. Base video plays via native `<video>`, overlays via individual `<video>`/`<img>` elements
4. Captions render as DOM overlays with per-word animation
5. Transitions render via @remotion/player seeked to exact frame

## Connections

- [[react-app-core]] — Home.tsx computes layers from useProject state
- [[remotion-transitions]] — TransitionPreview reads from transition registry
- [[timeline]] — shares currentTime for playhead sync
- [[shared]] — uses CaptionWord, CaptionStyle types

## Known Issues

- Overlay video play() errors silently swallowed (line 181)
- No handling for audio-only layers in preview (audio layers render invisible `<audio>` elements)
- Layer dragging has no snap-to-grid or bounds checking
- Base video memoization uses eslint-disable for exhaustive-deps (line 112)
