# Transition Authoring Spec for HyperEdit v2

This document defines how to create custom transition components for HyperEdit's v2 transition system. It is fully self-contained — use it alongside any standalone Remotion 4.x project to build and test transitions before uploading.

## Overview

A transition is a **React component** that renders as a full-screen overlay during the transition window between two clips. Transitions are independent timeline entities — they work across any tracks (V1, V2, V3) and handle overlapping, adjacent, and gap scenarios.

```
Timeline:
  FROM clip (V1)      TO clip (V2)
  ██████████████    ██████████████
           ├──────┤
           transition window
           ┌──────┐
           │OVERLAY│  ← Your component renders here (zIndex 3500)
           └──────┘
           progress 0.0 → 1.0
```

The component renders inside a `<Sequence>` where **frame 0 = transition start** and the last frame = transition end. Progress is always normalized 0→1.

## Required Exports

Every `.tsx` transition file **must** export three things:

### 1. Default Component (required)

```tsx
export default MyTransition;
// OR
const MyTransition: React.FC<CustomTransitionProps> = (props) => { ... };
export default MyTransition;
```

### 2. `params` — Parameter Schema (required)

Defines configurable parameters that auto-render as UI controls in HyperEdit's properties panel.

```tsx
import type { TransitionParamSchema } from '../types';

export const params: TransitionParamSchema = {
  intensity: {
    type: 'number',
    default: 0.5,
    label: 'Intensity',
    min: 0,
    max: 1,
    step: 0.01,
  },
  direction: {
    type: 'string',
    default: 'left',
    label: 'Direction',
    options: ['left', 'right', 'up', 'down'],
  },
  useBlur: {
    type: 'boolean',
    default: false,
    label: 'Enable Blur',
  },
  overlayColor: {
    type: 'color',
    default: '#000000',
    label: 'Overlay Color',
  },
};
```

If your transition has no configurable parameters, export an empty object:

```tsx
export const params: TransitionParamSchema = {};
```

**Parameter types and their UI controls:**

| Type | UI Control | Extra Fields |
|------|-----------|--------------|
| `number` | Slider | `min`, `max`, `step` |
| `string` | Dropdown (if `options` provided) or text input | `options?: string[]` |
| `boolean` | Toggle switch | — |
| `color` | Color picker | — |

### 3. `meta` — Display Metadata (required)

```tsx
import type { TransitionMeta } from '../types';

export const meta: TransitionMeta = {
  name: 'My Transition',
  description: 'A cool wipe effect with configurable direction',
};
```

If the effect is inherently orientation-specific (e.g. a corner box tuned for a landscape frame), declare it — HyperEdit surfaces this when the project canvas doesn't match:

```tsx
export const meta: TransitionMeta = {
  name: 'Facecam Corner Box',
  description: 'Shrinks the from-clip into a corner box',
  canvas: 'landscape', // 'any' (default) | 'landscape' | 'portrait'
};
```

## The CustomTransitionProps Interface

```typescript
interface CustomTransitionProps {
  /** Source URL of the outgoing (FROM) clip. undefined = black. */
  fromSrc?: string;
  /** Source URL of the incoming (TO) clip. undefined = black. */
  toSrc?: string;
  /** Asset type of the FROM clip */
  fromAssetType?: 'video' | 'image';
  /** Asset type of the TO clip */
  toAssetType?: 'video' | 'image';
  /** Frame offset into the FROM clip's source media. Pass to <OffthreadVideo startFrom={fromStartFrom}> so the video starts at the correct position instead of frame 0. */
  fromStartFrom?: number;
  /** Frame offset into the TO clip's source media. Pass to <OffthreadVideo startFrom={toStartFrom}>. */
  toStartFrom?: number;
  /** User-configurable parameters defined by the params export */
  params: Record<string, number | string | boolean>;
}
```

**Important:** When `fromSrc` or `toSrc` is `undefined`, render black (or nothing) for that side. This happens when the user explicitly sets a clip to "Black" in the from/to selector.

**Important:** Always pass `startFrom={fromStartFrom}` and `startFrom={toStartFrom}` to your `<OffthreadVideo>` elements. Without this, video clips will always play from the beginning of the source file instead of the correct position on the timeline.

## Timing Rules

- Use `useCurrentFrame()` and `useVideoConfig().durationInFrames` to compute progress
- **Normalize to 0→1**: `const progress = frame / Math.max(1, durationInFrames - 1)`
- Never hardcode frame numbers or durations — they change based on the user's duration setting
- Use `interpolate()` from remotion for easing and clamping

```tsx
const frame = useCurrentFrame();
const { durationInFrames } = useVideoConfig();
const progress = interpolate(frame, [0, durationInFrames - 1], [0, 1], {
  extrapolateRight: 'clamp',
});
```

## Layout Rules

- Use `useVideoConfig()` for `width` and `height` — never hardcode pixel values
- Wrap everything in `<AbsoluteFill>` for full-viewport coverage
- Use relative positioning (percentages, viewport fractions) not absolute pixels
- **Projects render at landscape (1920×1080) or portrait (1080×1920)** — the transition must work on both unless `meta.canvas` declares otherwise
- **Spatial params are canvas fractions**: any `params` entry describing position or size must be a 0–1 fraction of canvas width/height (`min: 0, max: 1`), multiplied by `useVideoConfig()` dims inside the component. Pixel-valued params (e.g. `max: 1920`) break on other orientations and trigger an upload warning

## Rendering Media

Use `<OffthreadVideo>` for video sources and `<Img>` for images. Always check the asset type, and **always pass `startFrom`** so video clips start at the correct position:

```tsx
function MediaLayer({ src, assetType, startFrom, style }: {
  src?: string;
  assetType?: 'video' | 'image';
  startFrom?: number;
  style?: React.CSSProperties;
}) {
  if (!src) return null;
  const mediaStyle = { width: '100%', height: '100%', objectFit: 'cover' as const, ...style };
  return assetType === 'video'
    ? <OffthreadVideo src={src} startFrom={startFrom} style={mediaStyle} />
    : <Img src={src} style={mediaStyle} />;
}
```

Usage inside your transition component:

```tsx
<MediaLayer src={fromSrc} assetType={fromAssetType} startFrom={fromStartFrom} />
<MediaLayer src={toSrc} assetType={toAssetType} startFrom={toStartFrom} />
```

## Allowed Imports

Your `.tsx` file may ONLY import from these packages:

| Package | Key Exports |
|---------|-------------|
| `remotion` | `interpolate`, `spring`, `Easing`, `useCurrentFrame`, `useVideoConfig`, `AbsoluteFill`, `Img`, `OffthreadVideo`, `Sequence` |
| `@remotion/shapes` | `Circle`, `Rect`, `Triangle`, `Star`, `Polygon`, `Ellipse`, `Pie` |
| `react` | Standard React APIs |

**Nothing else.** Imports outside this list are rejected on upload.

## Constraints

- **Deterministic**: Same frame number must always produce the same visual output
- **No side effects**: No fetch, no network calls, no dynamic imports, no timers
- **No custom hooks**: Only `useCurrentFrame()` and `useVideoConfig()` from remotion
- **No HyperEdit imports**: The file must work in any Remotion 4.x project
- **No Tailwind**: CSS-in-JS inline styles only (Tailwind is not available in Remotion)
- **No hardcoded frames**: All timing must be relative to `durationInFrames`

## Placeholder Conventions for Authoring

When developing transitions in a standalone Remotion project, use red and blue placeholders for the from/to clips:

```tsx
// In your test Root.tsx composition, pass these as inputProps:
<Composition
  id="MyTransition"
  component={MyTransition}
  inputProps={{
    fromSrc: undefined,  // Will show black or your placeholder
    toSrc: undefined,
    params: { intensity: 0.5 },
  }}
  durationInFrames={30}
  fps={30}
  width={1920}
  height={1080}
/>
```

For visual testing without real video sources, render colored rectangles:

```tsx
// Inside your transition component, when fromSrc/toSrc are undefined:
{!fromSrc && (
  <AbsoluteFill style={{ backgroundColor: '#e74c3c' }}>
    <div style={{ color: 'white', fontSize: 48, textAlign: 'center', marginTop: '45%' }}>FROM</div>
  </AbsoluteFill>
)}
{!toSrc && (
  <AbsoluteFill style={{ backgroundColor: '#3498db' }}>
    <div style={{ color: 'white', fontSize: 48, textAlign: 'center', marginTop: '45%' }}>TO</div>
  </AbsoluteFill>
)}
```

## Complete Working Example: Directional Wipe with Params

```tsx
import React from 'react';
import { AbsoluteFill, Img, OffthreadVideo, useCurrentFrame, useVideoConfig, interpolate, Easing } from 'remotion';

interface TransitionParamSchema {
  [key: string]: { type: string; default: any; label: string; options?: string[]; min?: number; max?: number; step?: number };
}
interface TransitionMeta { name: string; description?: string; canvas?: 'any' | 'landscape' | 'portrait'; }
interface CustomTransitionProps {
  fromSrc?: string; toSrc?: string;
  fromAssetType?: 'video' | 'image'; toAssetType?: 'video' | 'image';
  fromStartFrom?: number; toStartFrom?: number;
  params: Record<string, number | string | boolean>;
}

const DirectionalWipe: React.FC<CustomTransitionProps> = ({
  fromSrc, toSrc, fromAssetType, toAssetType, fromStartFrom, toStartFrom, params,
}) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const direction = (params.direction as string) || 'left';
  const softEdge = (params.softEdge as number) ?? 0.1;

  const progress = interpolate(frame, [0, durationInFrames - 1], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateRight: 'clamp',
  });

  // Build clip-path based on direction
  let clipPath: string;
  const edge = softEdge * 100;
  switch (direction) {
    case 'right':
      clipPath = `inset(0 ${(1 - progress) * 100}% 0 0)`;
      break;
    case 'up':
      clipPath = `inset(0 0 ${progress * 100}% 0)`;
      break;
    case 'down':
      clipPath = `inset(${(1 - progress) * 100}% 0 0 0)`;
      break;
    case 'left':
    default:
      clipPath = `inset(0 0 0 ${progress * 100}%)`;
      break;
  }

  const renderMedia = (src?: string, assetType?: string, startFrom?: number, style?: React.CSSProperties) => {
    if (!src) return <AbsoluteFill style={{ backgroundColor: '#000' }} />;
    const mediaStyle = { width: '100%', height: '100%', objectFit: 'cover' as const, ...style };
    return assetType === 'video'
      ? <OffthreadVideo src={src} startFrom={startFrom} style={mediaStyle} />
      : <Img src={src} style={mediaStyle} />;
  };

  return (
    <AbsoluteFill>
      {/* FROM clip (underneath) */}
      <AbsoluteFill>{renderMedia(fromSrc, fromAssetType, fromStartFrom)}</AbsoluteFill>
      {/* TO clip (wiping in) */}
      <AbsoluteFill style={{ clipPath }}>
        {renderMedia(toSrc, toAssetType, toStartFrom)}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const params: TransitionParamSchema = {
  direction: {
    type: 'string',
    default: 'left',
    label: 'Direction',
    options: ['left', 'right', 'up', 'down'],
  },
  softEdge: {
    type: 'number',
    default: 0.1,
    label: 'Soft Edge',
    min: 0,
    max: 0.5,
    step: 0.01,
  },
};

export const meta: TransitionMeta = {
  name: 'Directional Wipe',
  description: 'Wipe transition with configurable direction and edge softness',
};

export default DirectionalWipe;
```

## How to Test Before Uploading

1. Create a standalone Remotion project: `npx create-video@latest`
2. Install matching versions: `npm install remotion@^4.0.407 @remotion/shapes@^4.0.409`
3. Write your transition component in a `.tsx` file with all three exports
4. Register it as a `<Composition>` in your `Root.tsx`:
   ```tsx
   import MyTransition, { params, meta } from './MyTransition';

   <Composition
     id="MyTransition"
     component={MyTransition}
     inputProps={{
       fromSrc: undefined,
       toSrc: undefined,
       fromAssetType: undefined,
       toAssetType: undefined,
       params: Object.fromEntries(
         Object.entries(params).map(([k, v]) => [k, v.default])
       ),
     }}
     durationInFrames={30}
     fps={30}
     width={1920}
     height={1080}
   />
   ```
5. Preview with `npx remotion preview`
6. Test with different param values via Remotion Studio's props editor
7. Upload the `.tsx` file into HyperEdit via the Transitions panel or API

## Testing Checklist

Before uploading, verify:

- [ ] Component renders correctly at progress 0 (start), 0.5 (middle), and 1.0 (end)
- [ ] Works with both `fromSrc` and `toSrc` as `undefined` (shows black)
- [ ] Works with only one source (fade from/to black)
- [ ] No hardcoded frame numbers — duration changes produce correct results
- [ ] No layout overflow — stays within viewport bounds
- [ ] All params have sensible defaults
- [ ] `params` export matches what the component reads from `props.params`
- [ ] `meta.name` is a clear, human-readable display name
- [ ] Only allowed imports are used
- [ ] Renders deterministically (no Math.random without seed, no Date.now)

## API Reference

### Upload: `POST /session/{id}/upload-transition`

- **Multipart**: field `file` (the .tsx file), optional field `name`
- **JSON**: `{ "code": "...", "name": "my-transition" }`
- **Returns**: `{ "success": true, "transitionId": "...", "name": "...", "warnings": [...] }`

Warnings are returned when `params` or `meta` exports are missing (the upload still succeeds).

### List: `GET /session/{id}/transitions`

Returns a flat list of all transitions (built-in + custom) with param schemas:

```json
{
  "transitions": [
    {
      "id": "builtin-crossfade",
      "name": "Crossfade",
      "description": "Simple opacity crossfade between two clips",
      "source": "builtin",
      "params": {}
    },
    {
      "id": "my-custom-wipe",
      "name": "Directional Wipe",
      "description": "Wipe with configurable direction",
      "source": "custom",
      "params": {
        "direction": { "type": "string", "label": "Direction", "default": "left" }
      }
    }
  ],
  "builtIn": ["crossfade", "slide-left", "slide-right", "dip-to-black"],
  "custom": [{ "id": "my-custom-wipe", "name": "Directional Wipe" }]
}
```

### Generate: `POST /session/{id}/generate-transition`

- **Body**: `{ "description": "radial wipe expanding from bottom-left corner" }`
- **Returns**: `{ "success": true, "transitionId": "...", "name": "...", "code": "..." }`

## Built-in Transitions

HyperEdit ships with four built-in transitions (all with `params: {}`):

| ID | Name | Description |
|----|------|-------------|
| `builtin-crossfade` | Crossfade | Simple opacity blend |
| `builtin-slide-left` | Slide Left | From slides left, to slides in from right |
| `builtin-slide-right` | Slide Right | From slides right, to slides in from left |
| `builtin-dip-to-black` | Dip to Black | Dip through black at midpoint |
