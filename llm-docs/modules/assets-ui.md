---
title: Assets UI
type: module
source_files:
  - src/react-app/components/AssetLibrary.tsx
  - src/react-app/components/VideoUpload.tsx
  - src/react-app/components/ResizablePanel.tsx
  - src/react-app/components/ResizableVerticalPanel.tsx
tags: [assets, upload, ui, layout, resizable]
---

## Overview

Asset management UI (library grid with thumbnails, drag-to-timeline, upload) plus generic resizable panel components used throughout the layout.

## Key Components

### AssetLibrary.tsx

#### AssetLibraryProps (lines 5–14)

| Prop | Type |
|------|------|
| `assets` | `Asset[]` |
| `onUpload` | `(files: FileList) => void` |
| `onDelete` | `(assetId: string) => void` |
| `onDragStart` | `(asset: Asset) => void` |
| `onSelect` | `(assetId: string \| null) => void` (optional) |
| `selectedAssetId` | `string \| null` (optional) |
| `uploading` | `boolean` (optional, default false) |
| `onOpenGifSearch` | `() => void` (optional) |

#### Functions

| Function | Line | Purpose |
|----------|------|---------|
| `getAssetIcon` | 16 | Returns icon component by asset type |
| `getAssetColor` | 25 | Returns gradient class by asset type |
| `formatDuration` | 34 | Format seconds → `M:SS` |
| `formatSize` | 40 | Format bytes → KB/MB |
| `handleFileSelect` | 59 | Triggers hidden file input click |
| `handleFileChange` | 63 | Calls onUpload with selected files, resets input |
| `handleDrop` | 74 | DnD upload from OS file explorer |

#### Rendering

- Grid of asset cards with thumbnails (if available) or gradient placeholder
- Each card: draggable (`onDragStart`), clickable for selection, delete button
- Upload button + GIF search button in header
- Drop zone for external file drops
- Shows `uploading` spinner state

---

### VideoUpload.tsx (80 lines)

Legacy single-video upload component (used before multi-asset flow).

#### VideoUploadProps (line 4–6)

| Prop | Type |
|------|------|
| `onVideoSelect` | `(file: File) => void` |

#### Functions

| Function | Line | Purpose |
|----------|------|---------|
| `handleClick` | 11 | Trigger file input |
| `handleFileChange` | 15 | Validate video type, call onVideoSelect |
| `handleDrop` | 22 | DnD handler for video files |
| `handleDragOver` | 30 | Prevent default for drop zone |

Accepts: `video/*` only. Max 500MB (UI hint, not enforced in code).

---

### ResizablePanel.tsx (80 lines)

Horizontal resizable panel (left/right side panels).

#### ResizablePanelProps (lines 3–9)

| Prop | Type |
|------|------|
| `children` | `React.ReactNode` |
| `defaultWidth` | `number` |
| `minWidth` | `number` |
| `maxWidth` | `number` |
| `side` | `'left' \| 'right'` |
| `className` | `string` (optional) |

State: `width`, `isResizing`. Resize handle on appropriate edge. Mouse events on document for smooth drag.

---

### ResizableVerticalPanel.tsx (79 lines)

Vertical resizable panel (timeline height).

#### ResizableVerticalPanelProps (lines 3–9)

| Prop | Type |
|------|------|
| `children` | `React.ReactNode` |
| `defaultHeight` | `number` |
| `minHeight` | `number` |
| `maxHeight` | `number` |
| `position` | `'top' \| 'bottom'` |
| `className` | `string` (optional) |

Same pattern as ResizablePanel but vertical axis. Handle at top (for bottom panels) or bottom (for top panels).

## Data Flow

```text
OS Files ──drop/click──► AssetLibrary ──onUpload──► useProject.uploadAsset
                                       ──onDragStart──► Timeline handleDrop
                                       ──onSelect──► useProject.selectedAssetId
```

## Connections

- [[react-app-core]] — useProject provides assets[], upload/delete handlers
- [[timeline]] — assets dragged via HTML5 DnD (`application/x-hyperedit-asset`)
- [[panels]] — GifSearchPanel opened via `onOpenGifSearch`

## Known Issues

- VideoUpload.tsx largely superseded by AssetLibrary multi-asset upload but still mounted somewhere in legacy flow
- ResizablePanel width not persisted to localStorage (resets on page reload)
- File size limit (500MB) displayed in VideoUpload but not enforced programmatically
