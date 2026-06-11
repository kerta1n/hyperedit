# Remotion Library Quick Reference

Field-tested reference for Remotion 4.x components, Player API, and the three video-rendering pipelines. Use this when evaluating Remotion components for any project — preview frame-accuracy, render pipeline choice, canvas-source transitions, Player integration. Read BEFORE proposing a Remotion-based fix or starting a `@remotion/media` migration.

## Three video components, three preview pipelines

Remotion 4.x exposes three competing `<Video>`-like components. The differences are subtle but determine whether they help a given problem.

| Component | Package | Backend | Preview pipeline | Frame-perfect at preview? |
|---|---|---|---|---|
| `<OffthreadVideo>` | `remotion` | Rust + FFmpeg (at render) | HTML5 `<video>` element | ❌ |
| `<Html5Video>` | `remotion` | HTML5 `<video>` | HTML5 `<video>` element | ❌ |
| `<Video>` | `@remotion/media` | Mediabunny + WebCodecs | WebCodecs decode → canvas paint | ✅ |

The Rust frame extractor in `<OffthreadVideo>` is RENDER-ONLY. Its preview path uses the same HTMLVideoElement noise floor as raw `<video>`. **`<OffthreadVideo>` does not help frame-accurate preview.**

Only `<Video>` from `@remotion/media` bypasses HTMLVideoElement in preview. If your problem is preview frame accuracy, this is the only Remotion candidate.

## WebCodecs status

WebCodecs (W3C browser API) is NOT deprecated. The confusion source: Remotion's OWN packages `@remotion/webcodecs` and `@remotion/media-parser` were deprecated in favor of the third-party Mediabunny library. Quote from Remotion's "Sponsoring Mediabunny" blog (Sept 2025): *"We're going to phase out Remotion Media Parser and Remotion WebCodecs."* Mediabunny itself is WebCodecs-based. The W3C API is alive, on the Recommendation track.

## `<Video>` from `@remotion/media`

The frame-perfect preview option. Key facts:

- Marked **experimental** in docs. Will become default eventually but API may change.
- Renders to `<canvas>`, NOT to `<video>`. **No HTMLVideoElement accessible for canvas-draw transitions**.
- Requires `useCurrentFrame()` context — cannot be used standalone.
- Props include: `src`, `volume`, `playbackRate`, `startFrom`, `endAt`, `muted`, `loop`, `from`, `durationInFrames`, `trimBefore`, `trimAfter`, `onError`, `onVideoFrame`, `requestInit` (v4.0.465+), `headless`.
- `onVideoFrame: (frame: ImageBitmap | VideoFrame) => void` — called per-frame at preview time. Use for measurement (first-frame timestamp) or for tap-into-frame-stream patterns.
- `headless: true` — no canvas mount, `onVideoFrame` still fires. Useful for Three.js textures.
- `requestInit: { cache: 'no-store' }` — bypass browser cache for range requests. Useful for localhost servers with funny caching.

### CORS requirements

`@remotion/media` requires CORS-enabled assets. Specifically:
- `Access-Control-Allow-Origin: *` (or specific origin)
- `Accept-Ranges: bytes` on BOTH 200 and 206 responses
- `Content-Range` on 206 responses

If CORS fails OR codec unsupported, `<Video>` falls back to `<OffthreadVideo>` automatically (`fallbackOffthreadVideoProps` can configure the fallback).

### Buffer state

`@remotion/media` enables buffer state by default. Auto-pauses Player when Mediabunny is loading. Removes a common source of seek-induced artifacts.

## `<OffthreadVideo>` — useful for canvas transitions

Adds `onVideoFrame` callback since v4.0.190. **During preview, the callback receives a real `HTMLVideoElement`.** This makes it a drop-in for canvas-draw transitions that need `ctx.drawImage(videoElement, ...)`.

```tsx
<OffthreadVideo
  src={url}
  onVideoFrame={(htmlVideoElement) => {
    // canvas-draw works with this
    ctx.drawImage(htmlVideoElement, 0, 0);
  }}
/>
```

In v4.0.472+, the callback also receives `DOMHighResTimeStamp` and `VideoFrameCallbackMetadata` as 2nd/3rd args — equivalent to `requestVideoFrameCallback` semantics.

## `<Html5Video>` — same as raw `<video>` but with extras

Renamed from base `<Video>` in `remotion` package. NOT identical to raw HTML5 `<video>`:

- Adds Remotion's seek synchronization (sets `currentTime = frame / fps`).
- `acceptableTimeShiftInSeconds` drift correction (default 0.45 s).
- `delayRender()` blocking during seeks.
- `pauseWhenBuffering` buffer-state integration.

Still uses HTML5 video element in preview. Drift correction is a marginal improvement over raw `<video>` for editor-style seek precision.

## `<Player>` component (the clock owner)

The Player wraps a Composition and provides:
- `play()`, `pause()`, `seekTo(frame)`, `getCurrentFrame()`, `isPlaying()`, `toggle()` — imperative ref methods
- `frameupdate` event — fires every frame during playback with `{ frame: number }` payload
- `volumechange`, `play`, `pause`, `seeked`, `ratechange`, `ended` — standard media events
- `waiting`, `resume` — buffer state events

### Key constraint: external clock injection does NOT exist

`Player.seekTo(frame)` docs say: *"Move the position in the video to a specific frame. If the video is playing, it will pause for a brief moment, then start playing again after the seek is completed."*

Driving Player at 60 fps from an external RAF clock (e.g., a custom timeline RAF loop in your app) causes constant stutter. **There is no documented way to drive Player from an external clock without this pause-resume cycle.**

The reverse works: subscribe to `frameupdate` event to read Player's clock from outside.

```ts
playerRef.current.addEventListener('frameupdate', (e) => {
  const frame = e.detail.frame;
  // sync external state to player's clock
});
```

If your app has a custom clock (RAF-driven, externally-modeled), integrating with `<Player>` means **surrendering the clock to Player**. This is the architectural blocker for any editor that already owns its playback clock.

### Composition not required

Common misconception: `<Player>` needs a `<Composition>` wrapper. It does NOT.

```tsx
// Correct — no <Composition> wrapping
<Player component={MyVideoComponent} durationInFrames={120} fps={30} compositionWidth={1920} compositionHeight={1080} />
```

The component receives normal React props via `inputProps` on `<Player>`.

### Mandatory props

`<Player>` requires:
- `component` (the rendered React component)
- `durationInFrames` (integer > 0)
- `fps` (number)
- `compositionWidth` (number)
- `compositionHeight` (number)

Display sizing is independent — pass `style={{width: N}}`. Player auto-scales internally via CSS transform.

## `useCurrentFrame()` requirement

`<Video>` (any variant) and most Remotion components internally call `useCurrentFrame()`. This hook is only available inside a Remotion rendering context — i.e., inside `<Player>` or `<Composition>` rendering pass. Components calling it standalone throw at runtime.

Cannot be faked. There is no `<RemotionRoot>` context provider that works without Player/Composition.

## `useRemotionEnvironment()` — split rendering paths

Returns `{isRendering, isPlayer, ...}`. Use to render different components in preview vs render:

```tsx
import { useRemotionEnvironment, OffthreadVideo } from 'remotion';
import { Video } from '@remotion/media';

const VideoChooser: React.FC<{src: string}> = ({src}) => {
  const env = useRemotionEnvironment();
  if (!env.isRendering) {
    return <OffthreadVideo src={src} />; // preview path
  }
  return <Video src={src} />; // render path
};
```

This is the officially documented "use OffthreadVideo for preview, @remotion/media for render" pattern.

## frame ↔ seconds conversion

Remotion APIs use INTEGER FRAMES, not seconds. Always convert:

```ts
const frames = Math.round(timeInSeconds * fps);
const seconds = frame / fps;
```

If your timeline/project state stores times in seconds, multiply by fps and round to pass them to Remotion components.

## Mediabunny supported codecs (via `@remotion/media`)

Containers: `.mp4`, `.webm`, `.mov`, `.mkv`, plus audio-only `.mp3`, `.aac`, `.flac`, `.m4a`, `.ogg`, `.wav`, `.m3u8`.

Video codecs: AAC, FLAC, H.264, MP3, Opus, VP8, VP9, Vorbis. (Subset of `<OffthreadVideo>` Rust-FFmpeg list which adds AC3, AV1, H.265, ProRes, PCM.)

If codec unsupported, falls back to `<OffthreadVideo>` automatically.

### Matroska / WebM seek perf gotcha

For audio in `.webm`: "for the audio to be extracted, the entire audio up to the point of extraction must be extracted as well." Means seeking into mid-file in webm container is O(position). Large webm clips with frequent backward seeks → slow.

mp4 + H.264 + AAC is the safest container/codec combination for editor use.

## Migrating an existing editor preview to `<Player>` + `<Video>` from `@remotion/media`

If considering this migration (the WebCodecs-based preview path):

- Typical scope: ~250 LOC across ~4 files (a new composition component, a new Player wrapper, modifications to the editor page, and possibly server CORS headers).
- Time estimate: 1.5–2 days including Vite WASM setup quirks (Mediabunny ships WASM that must be bundled).
- Pass criteria for measurement: preview first-frame-after-play time should drop into single-digit-ms range across multiple cold-start cycles.
- Known POC risks: Vite WASM bundling, Player `inputProps` causing re-mounts, `onVideoFrame` callback stability across frames, CORS preflight on byte-range requests.

### Canvas-drawn transitions that read frames from `HTMLVideoElement` — compatibility note

If your project has a transition system that does `ctx.drawImage(HTMLVideoElement, ...)` to blend two video sources on a canvas, the migration interacts:

| Component | Provides HTMLVideoElement? | canvas-source transition compat |
|---|---|---|
| `<Video>` from `@remotion/media` (WebCodecs path) | NO — renders directly to canvas; no HTMLVideoElement | ❌ Direct break; needs adaptation |
| `<OffthreadVideo>` `onVideoFrame` callback (v4.0.190+) | YES — real HTMLVideoElement in preview | ✅ Drop-in |
| `<Html5Video>` | YES (raw HTMLVideoElement with drift correction) | ✅ Compatible |

Three sub-options if you need both Path 4 benefits AND canvas-source transitions:
1. **Hybrid component selection** — Use `<OffthreadVideo>` during transition windows, `<Video>` during normal playback. Switch via time-based ternary or `useRemotionEnvironment()`. Transition canvas-draw code unchanged. Tradeoff: loses Path 4's WebCodecs benefit specifically during transition windows.
2. **Adapt the canvas-draw signature** — Modify your `CanvasDrawFn` type to accept `ImageBitmap | VideoFrame | HTMLImageElement` instead of `HTMLVideoElement`. `<Video>` exposes `ImageBitmap | VideoFrame` via its `onVideoFrame: (frame) => void` callback. `ctx.drawImage` accepts both, so the actual draw call doesn't change. Typically a ~30 line edit. Full WebCodecs path retained.
3. **Replace with `@remotion/transitions`** — Remotion has a first-party transition package. May obsolete your existing canvas-draw entirely. Requires audit of `@remotion/transitions` capabilities vs your project's transition needs.

## Decision tree

Problem: editor preview not frame-accurate.
1. Need to keep custom external clock (RAF, project-time-as-state)? → CANNOT use `<Player>`. No Remotion preview path is frame-accurate without Player. Options: accept HTML5 floor, OR direct WebCodecs integration.
2. Can surrender clock to `<Player>`? → Use `<Video>` from `@remotion/media`. POC scoped above.
3. Need canvas transitions reading video frames? → `<OffthreadVideo>` `onVideoFrame` returns `HTMLVideoElement` — low-effort integration.
4. Need to ship today, can't migrate? → `<Html5Video>` adds drift correction over raw `<video>` for free.
5. Need server-rendered output to be frame-perfect but preview can be lossy? → `<OffthreadVideo>` at render, anything in preview.

## Doc URLs

Authoritative Remotion docs (verified-current at time of writing):

- https://www.remotion.dev/docs/media — `@remotion/media` overview
- https://www.remotion.dev/docs/media/video — `<Video>` API
- https://www.remotion.dev/docs/media/audio — `<Audio>` API
- https://www.remotion.dev/docs/media/support — CORS + supported containers
- https://www.remotion.dev/docs/media/fallback — fallback behavior
- https://www.remotion.dev/docs/mediabunny — Mediabunny details
- https://www.remotion.dev/docs/offthreadvideo — `<OffthreadVideo>` full API
- https://www.remotion.dev/docs/html5-video — `<Html5Video>` full API
- https://www.remotion.dev/docs/video-tags — comparison table (the definitive source for "which to use when")
- https://www.remotion.dev/docs/player — `<Player>` overview
- https://www.remotion.dev/docs/player/player — `<Player>` full API
- https://www.remotion.dev/docs/player/current-time — frameupdate event usage
- https://www.remotion.dev/docs/player/buffer-state — buffer state semantics
- https://www.remotion.dev/docs/composition — `<Composition>` requirements
- https://www.remotion.dev/docs/use-current-frame — frame hook
- https://www.remotion.dev/docs/use-remotion-environment — environment split
- https://www.remotion.dev/docs/sequence — `<Sequence>` API

WebCodecs status:
- https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API
- https://www.w3.org/TR/webcodecs/
- https://chromestatus.com/features?q=webcodecs
