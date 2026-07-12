# Custom Transition Spec for HyperEdit

This document defines how to create custom transition components for the HyperEdit video editor. It is fully self-contained — you can use it alongside any standalone Remotion 4.x project to build and test transitions before uploading them.

## Overview

A custom transition is a **React component** that renders as a full-screen overlay during the transition window between two clips. It has complete visual freedom: SVG, clip-paths, shapes, color wipes, particle effects — anything renderable in React.

```
Timeline:
  FROM clip          TO clip
  ██████████████    ██████████████
           ├──────┤
           overlap
           ┌──────┐
           │OVERLAY│  ← Your component renders here
           └──────┘
           frame 0  frame N
```

The component renders inside a `<Sequence>` where **frame 0 = transition start** and the last frame = transition end. The `<Sequence>` wrapper provides the correct frame context automatically.

## The CustomTransitionProps Interface

All props are **optional**. Your component can ignore them entirely and just use `useCurrentFrame()` / `useVideoConfig()` directly.

```typescript
interface CustomTransitionProps {
  /** Source URL of the outgoing (FROM) clip, if you want to composite it */
  fromSrc?: string;
  /** Source URL of the incoming (TO) clip, if you want to composite it */
  toSrc?: string;
  /** Asset type of the FROM clip ('video' or 'image') */
  fromAssetType?: 'video' | 'image';
  /** Asset type of the TO clip ('video' or 'image') */
  toAssetType?: 'video' | 'image';
}
```

## Allowed Imports

Your `.tsx` file may ONLY import from these packages (matching HyperEdit's installed versions):

| Package | Version | Key Exports |
|---------|---------|-------------|
| `remotion` | `^4.0.407` | `interpolate`, `spring`, `Easing`, `useCurrentFrame`, `useVideoConfig`, `AbsoluteFill`, `Img`, `OffthreadVideo`, `Sequence` |
| `@remotion/shapes` | `^4.0.409` | `Circle`, `Rect`, `Triangle`, `Star`, `Polygon`, `Ellipse`, `Pie` |
| `react` | `^19` | Standard React APIs |

**Nothing else.** No `@remotion/transitions`, no `@remotion/three`, no external packages. Imports outside this list will be rejected on upload.

## Export Format

Either `export default` or a named export. Both are supported:

```tsx
// Option A: default export
export default MyTransition;

// Option B: named export
export const MyTransition: React.FC = () => { ... };
```

## Constraints

- **Deterministic**: Same frame number must always produce the same visual output
- **No side effects**: No fetch, no network calls, no dynamic imports, no timers
- **No custom hooks**: Only `useCurrentFrame()` and `useVideoConfig()` from remotion
- **No HyperEdit imports**: The file must work in any Remotion 4.x project
- **No Tailwind**: CSS-in-JS inline styles only (Tailwind is not available in Remotion components)
- **Canvas independence**: never hardcode pixel dimensions — read `width`/`height` from `useVideoConfig()`. Projects render at landscape (1920×1080) or portrait (1080×1920); the transition must work on both. If the effect is inherently orientation-specific, declare `canvas: 'landscape' | 'portrait'` in the `meta` export (defaults to `'any'`). Spatial position/size parameters in a `params` schema must be canvas fractions 0–1 (multiply by `useVideoConfig()` dims in the component), never pixel values — pixel-scale param ranges trigger an upload warning.

## Starter Template

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";

const MyTransition: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();

  const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Your transition visuals here
  return (
    <AbsoluteFill>
      {/* Render SVG, shapes, colors, etc. */}
    </AbsoluteFill>
  );
};

export default MyTransition;
```

## Example 1: Radial Wipe

A circle expands from the center, revealing the next clip through a black overlay.

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";

export const RadialWipe: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const maxR = Math.sqrt(width ** 2 + height ** 2) / 2;
  const radius = interpolate(frame, [0, durationInFrames], [0, maxR], {
    easing: Easing.out(Easing.cubic),
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <svg style={{ position: "absolute", width: "100%", height: "100%" }}>
        <defs>
          <mask id="radial-mask">
            <rect width={width} height={height} fill="white" />
            <circle cx={width / 2} cy={height / 2} r={radius} fill="black" />
          </mask>
        </defs>
        <rect width={width} height={height} fill="black" mask="url(#radial-mask)" />
      </svg>
    </AbsoluteFill>
  );
};
```

## Example 2: Glitch

Horizontal slice displacement with RGB channel offset.

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

export const GlitchTransition: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const intensity = interpolate(frame, [0, durationInFrames * 0.5, durationInFrames], [0, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const sliceCount = 12;
  const sliceHeight = height / sliceCount;

  return (
    <AbsoluteFill>
      {Array.from({ length: sliceCount }, (_, i) => {
        const seed = Math.sin(i * 127.1 + frame * 0.1) * 43758.5453;
        const offset = (seed - Math.floor(seed)) * intensity * width * 0.3;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              top: i * sliceHeight,
              left: offset,
              width: width,
              height: sliceHeight,
              backgroundColor: `rgba(${i % 3 === 0 ? 255 : 0}, ${i % 3 === 1 ? 255 : 0}, ${i % 3 === 2 ? 255 : 0}, ${intensity * 0.3})`,
              mixBlendMode: "screen",
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
```

## Example 3: Zoom Through

Black overlay that zooms in from the center with blur effect.

```tsx
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";

export const ZoomThrough: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const half = durationInFrames / 2;

  const scale = frame <= half
    ? interpolate(frame, [0, half], [1, 3], { easing: Easing.in(Easing.cubic) })
    : interpolate(frame, [half, durationInFrames], [3, 1], { easing: Easing.out(Easing.cubic) });

  const opacity = frame <= half
    ? interpolate(frame, [0, half], [0, 1])
    : interpolate(frame, [half, durationInFrames], [1, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "black",
        opacity,
        transform: `scale(${scale})`,
      }}
    />
  );
};
```

## How to Test Before Uploading

1. Create a standalone Remotion project: `npx create-video@latest`
2. Install matching versions: `npm install remotion@^4.0.407 @remotion/shapes@^4.0.409`
3. Write your transition component in a `.tsx` file
4. Register it as a `<Composition>` in your `Root.tsx`:
   ```tsx
   <Composition
     id="MyTransition"
     component={MyTransition}
     durationInFrames={30}
     fps={30}
     width={1920}
     height={1080}
   />
   ```
5. Preview with `npx remotion preview`
6. Iterate until satisfied
7. Upload the `.tsx` file into HyperEdit via the Transitions panel or API

## API Reference

### Upload: `POST /session/{id}/upload-transition`

- **Multipart**: field `file` (the .tsx file), optional field `name`
- **JSON**: `{ "code": "...", "name": "my-transition" }`
- **Returns**: `{ "success": true, "transitionId": "...", "name": "..." }`

### List: `GET /session/{id}/transitions`

- **Returns**: `{ "builtIn": ["crossfade", ...], "custom": [{ "id": "...", "name": "..." }] }`

### Generate: `POST /session/{id}/generate-transition`

- **Body**: `{ "description": "radial wipe expanding from bottom-left corner" }`
- **Returns**: `{ "success": true, "transitionId": "...", "name": "...", "code": "..." }`
