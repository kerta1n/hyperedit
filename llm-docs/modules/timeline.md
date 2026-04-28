---
title: Timeline
type: module
source_files:
  - src/react-app/components/Timeline.tsx
  - src/react-app/components/TimelineClip.tsx
  - src/react-app/components/TimelineTabs.tsx
  - src/react-app/components/Toolbar.tsx
tags: [timeline, tracks, clips, transitions, ui]
---

## Overview

Multi-track timeline editor handling clip placement, playhead scrubbing, zoom, drag-and-drop, transitions (V1 junction + V2 entity), and keyboard shortcuts. Renders 6 fixed tracks (T1, V3, V2, V1, A1, A2) with per-type heights.

## Architecture

```text
┌────────────────────────────────────────────────────────────────┐
│ Home.tsx                                                        │
│  ├─ TimelineTabs (tab switching)                               │
│  ├─ Toolbar (non-functional placeholder)                       │
│  └─ Timeline                                                   │
│       ├─ Time ruler (click to seek)                            │
│       ├─ Track headers (labels, bulk-delete for T1)            │
│       ├─ Per-track lanes                                       │
│       │    ├─ TimelineClip × N                                 │
│       │    ├─ TransitionIndicator × N (V1, video tracks only)  │
│       │    └─ TransitionEntity × N (V2, any track)             │
│       └─ Playhead (draggable)                                  │
└────────────────────────────────────────────────────────────────┘
```

## Key Components

### Timeline.tsx (630 lines + private components)

#### TimelineProps (lines 6–40)

| Prop | Type |
|------|------|
| `tracks` | `Track[]` |
| `clips` | `TimelineClipType[]` |
| `assets` | `Asset[]` |
| `selectedClipId` | `string \| null` |
| `selectedClipIds` | `string[]` (optional) |
| `currentTime` | `number` |
| `duration` | `number` |
| `isPlaying` | `boolean` |
| `aspectRatio` | `'16:9' \| '9:16'` |
| `onSelectClip` | `(id: string \| null, shiftKey?: boolean) => void` |
| `onTimeChange` | `(time: number) => void` |
| `onPlayPause` | `() => void` |
| `onStop` | `() => void` |
| `onMoveClip` | `(clipId, newStart, newTrackId?) => void` |
| `onResizeClip` | `(clipId, newInPoint, newOutPoint, newStart?) => void` |
| `onDeleteClip` | `(clipId: string) => void` |
| `onCutAtPlayhead` | `() => void` |
| `onAddText` | `() => void` |
| `onToggleAspectRatio` | `() => void` |
| `onTrackLabelClick` | `(trackId: string) => void` (optional) |
| `onDropAsset` | `(asset, trackId, time) => void` |
| `onSave` | `() => void` |
| `getCaptionData` | `(clipId: string) => CaptionData \| null` (optional) |
| `transitions` | `JunctionTransition[]` |
| `onAddTransition` | `(fromClipId, toClipId, type?, duration?) => JunctionTransition` |
| `onUpdateTransition` | `(transitionId, updates) => void` |
| `onRemoveTransition` | `(transitionId: string) => void` |
| `timelineTransitions` | `TimelineTransition[]` (optional) |
| `selectedTransitionId` | `string \| null` (optional) |
| `onSelectTransition` | `(id: string \| null) => void` (optional) |
| `onUpdateTimelineTransition` | `(id, updates) => void` (optional) |
| `onRemoveTimelineTransition` | `(id: string) => void` (optional) |

#### Constants (lines 42–46)

- `TRACK_HEIGHTS`: `{ video: 56, audio: 44, text: 48 }`

#### Functions/Handlers

| Function | Line | Purpose |
|----------|------|---------|
| `formatTime` | 48 | Format seconds → `M:SS` |
| `Timeline` (component) | 54 | Main export |
| Scroll sync effect | 97–108 | Syncs track headers vertical scroll with track content |
| Shift+scroll zoom effect | 111–130 | Zoom in/out range 0.25–4x |
| Keyboard Delete effect | 133–148 | Delete/Backspace deletes selected clip |
| `getTimeInterval` | 160–167 | Adaptive ruler tick spacing based on zoom |
| `getTrackClips` | 179–182 | Filter clips by trackId |
| `handleTimelineClick` | 185–195 | Seek to click position |
| `handlePlayheadMouseDown` | 198–201 | Start playhead drag |
| `handleMouseMove` | 203–212 | Update time during drag |
| `handleMouseUp` | 214–216 | End drag |
| `handleDragOver` | 219–223 | Track drag-over highlight |
| `handleDragLeave` | 225–227 | Clear highlight |
| `handleDrop` | 229–252 | Parse `application/x-hyperedit-asset` data, calculate drop time, call `onDropAsset` |
| `getAssetForClip` | 255–258 | Look up asset by clip.assetId |
| `getAdjacentPairs` | 261–290 | Find clip pairs within 2s gap for V1 transition indicators |
| Bulk caption delete | 426–434 | Inline handler on text track label trash icon |

#### TransitionIndicator (private, line 643)

V1 junction transitions. Only renders on video tracks. Shows `+` button when adjacent clip selected, or transition chip with type selector menu.

- `TRANSITION_LABELS`: `{ crossfade: 'XF', 'slide-left': 'SL', 'slide-right': 'SR', 'dip-to-black': 'DB', custom: 'CT' }`
- `TRANSITION_TYPES`: `['crossfade', 'slide-left', 'slide-right', 'dip-to-black']`
- `DURATION_PRESETS`: `[0.25, 0.5, 1.0, 1.5]`

#### TransitionEntity (private, line 767)

V2 timeline transitions. Draggable and resizable entity rendered as purple bar. Uses `getTransitionMeta` from registry for name display. Supports left/right resize handles.

Props: `transition`, `clips`, `tracks` (unused), `trackHeight`, `pixelsPerSecond`, `isSelected`, `onSelect`, `onUpdate`, `onRemove`

Import at line 765: `import { getTransitionMeta } from '@/remotion/transitions/registry'` — unconventional bottom-of-file import.

---

### TimelineClip.tsx (100+ lines)

#### TimelineClipProps (lines 5–18)

| Prop | Type |
|------|------|
| `clip` | `TimelineClipType` |
| `asset` | `Asset \| undefined` |
| `pixelsPerSecond` | `number` |
| `isSelected` | `boolean` |
| `trackHeight` | `number` |
| `onClick` | `(e?: React.MouseEvent) => void` |
| `onMove` | `(newStart: number) => void` |
| `onResize` | `(newInPoint, newOutPoint, newStart?) => void` |
| `onDragEnd` | `() => void` |
| `onDelete` | `() => void` |
| `captionPreview` | `string` (optional) |
| `isCaption` | `boolean` (optional) |

#### Key Functions

| Function | Line | Purpose |
|----------|------|---------|
| `getAssetIcon` | 20 | Returns icon by asset type |
| `getClipColor` | 30 | Returns gradient class by type |
| `handleMouseDown` | 71 | Determines drag vs left-resize vs right-resize based on click position (8px handle zones) |

State: `isDragging`, `isResizingLeft`, `isResizingRight`, `dragStartX`, `initialStart`, `initialInPoint`, `initialOutPoint`

Layout: `left = clip.start * pixelsPerSecond + 1`, `width = max(clip.duration * pixelsPerSecond - 2, 30)`

---

### TimelineTabs.tsx (85 lines)

#### TimelineTabsProps (lines 4–11)

| Prop | Type |
|------|------|
| `tabs` | `TimelineTab[]` |
| `activeTabId` | `string` |
| `onSwitchTab` | `(tabId: string) => void` |
| `onCloseTab` | `(tabId: string) => void` |
| `onAddTab` | `() => void` (optional) |
| `show` | `boolean` (optional) |

Visibility guard: only renders if `show === true` or `tabs.length > 1`. Main tab shows Layers icon, others show Film icon. Non-main tabs have close button.

---

### Toolbar.tsx (53 lines)

9 tool buttons, **all non-functional** (no onClick handlers):
Split, Duplicate, Delete, Undo, Redo, Audio, Color, Effects, Settings

Pure visual placeholder.

## Data Flow

1. Home.tsx passes timeline state from `useProject()` → Timeline
2. User interactions (click/drag/drop) call `onMoveClip`, `onResizeClip`, etc → back to useProject dispatchers
3. Playhead position controlled by `currentTime` prop; user scrubs via click/drag → `onTimeChange`
4. Assets dragged from AssetLibrary via HTML5 DnD, parsed from `application/x-hyperedit-asset` dataTransfer

## Connections

- [[react-app-core]] — receives all state from useProject hook
- [[video-preview]] — shares currentTime for playback sync
- [[remotion-transitions]] — TransitionEntity reads from transition registry
- [[assets-ui]] — receives drag events from AssetLibrary
- [[panels]] — ClipPropertiesPanel edits selected clip, TransitionPropertiesPanel edits selected transition

## Known Issues

- Toolbar entirely non-functional — no click handlers wired up
- Zoom not persisted between renders (local state only)
- `tracks` prop passed to TransitionEntity but unused (dead prop)
- Cross-track drag not implemented (clips stay on original track)
- Caption bulk-delete bypasses ripple logic (deletes without shifting subsequent clips)
- V1 TransitionIndicator only shown on video tracks, not audio/text
- Bottom-of-file import for `getTransitionMeta` (line 765) breaks convention
