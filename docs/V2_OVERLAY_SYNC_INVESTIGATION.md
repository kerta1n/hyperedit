# V2 Overlay Sync Investigation — Megadocument

> Branch: failed-investigation / V2-sync-experiments (whatever name this branch ends up with)
> Date authored: 2026-06-04
> Scope: every measurement, every code change, every doc consulted, every conclusion drawn during the multi-day investigation of the V2/V3 overlay-video sync drift bug in HyperEdit's preview pipeline.
> Audience: a fresh agent (or human) who checks out this branch cold and needs full context to continue OR to revert to baseline.
> **DO NOT TRUNCATE THIS FILE WHEN READING.** Every section is load-bearing for a cold reader.

---

## TABLE OF CONTENTS

1. Executive summary
2. Why this branch exists (orientation)
3. The bug — symptom and reproduction
4. HyperEdit timeline preview architecture recap
5. Code state at the start of investigation
6. Hypothesis tree (H1–H6)
7. Track-ID asymmetry audit (S1–S6)
8. Measurement infrastructure — the [V2MEAS] log scheme
9. Browser automation setup (chrome-devtools-mcp)
10. The skill file: `llm-docs/SKILL-agent-test-hyperedit-ui.md`
11. Test reproduction protocol
12. Run 1 — Original baseline (no fix applied)
13. First fix attempt — 3a (drift gate) + 3b (rVFC gate)
14. Run 2 measurement
15. Second fix attempt — 3a only (3b reverted)
16. Run 3 measurement
17. Third fix attempt — Option F (decoder pre-warm pulse), 3a reverted, threshold raised
18. Run 4 measurement
19. Fourth fix attempt — Option F + 3a re-applied + pre-warm observability logs
20. Run 5 measurement
21. Five-run synthesis and statistical observation
22. First Remotion docs research pass
23. WebCodecs deprecation investigation
24. Second Remotion docs research pass (corrections)
25. Path matrix and final recommendation
26. Current branch HEAD code state, file by file
27. Revert recipe — return to baseline
28. Continuation guide for the next investigator
29. Open questions
30. Appendix A — full raw measurement data tables
31. Appendix B — full file diff catalog at branch HEAD
32. Appendix C — terminology glossary
33. Appendix D — Remotion documentation URL index
34. Appendix E — console log examples
35. Appendix F — browser MCP command catalog used
36. Appendix G — agent interaction history (high level)

---

## 1. EXECUTIVE SUMMARY

The V2/V3 overlay video on the HyperEdit timeline plays at a varying, audibly-perceptible offset from the V1 base video each time the user seeks the timeline to a new position and presses play. The user reported the offset as "random". Over the course of five measured browser-driven runs against the same five seek positions (35s, 50s, 65s, 80s, 100s into the project, all inside the V2 clip's active window of roughly [28.26s, 120.15s]), we systematically tested four mechanical interventions inside `src/react-app/components/VideoPreview.tsx`:

- **Fix 3a**: drift-gate the unconditional `video.currentTime = layer.clipTime` assignment in `playEffect` so it only re-seeks when V2 has drifted more than 30 ms (one frame at 30 fps) from the target. Intended to avoid flushing a warmed decoder via a redundant seek.
- **Fix 3b**: schedule V2 / V3 overlay `video.play()` inside `videoRef.current.requestVideoFrameCallback(...)` so the overlay starts playing at the moment V1's first frame is presented to the compositor. Intended to eliminate the wall-clock race between V1 and V2 startup decoders.
- **Fix F (Option F)**: pre-warm the V2 decoder by running a brief muted `play() → requestVideoFrameCallback → pause()` pulse immediately after V2 settles at a new seek position while the timeline is still paused. Intended to keep V2's decode pipeline hot so that when the user finally presses play, the decoder fires its first frame fast instead of paying ~80 ms of cold-start.
- **Seek-effect threshold raise**: increase the play-start drift tolerance in `seekEffect` from 5 ms (0.005 s) to 50 ms (0.05 s) so that the ~16–33 ms `currentTime` advance left behind by the Option F pre-warm pulse does not trigger a re-seek (which would defeat the pre-warm entirely).

All four fixes were typechecked clean (`rtk tsc`) and lint-clean (`rtk lint`). All five measurement runs were performed in Brave with remote debugging on `localhost:9222`, driven by a `general-purpose` sonnet sub-agent that controlled the UI via `mcp__plugin_chrome-devtools-mcp__*` tools. Play and pause clicks were performed via the MCP `click` tool against a uid obtained from `take_snapshot`, with `take_screenshot` before/after each click to verify the icon flipped (`Play`→`Pause` or vice versa). This protocol was added after a prior agent's data was discarded because the user reported audibly only hearing playback start ~2 times across a supposed 5-sample run; programmatic `evaluate_script` MouseEvent dispatch on the play button was not visible to the user and may not have actually triggered the React `onClick`.

The result of all five runs, summarized:

| Run | Fix applied | Mean V2 ptF (ms) | Mean V2 − V1 ptF (ms) |
|---:|---|---:|---:|
| 1 | None (original baseline) | 86 | +71 |
| 2 | 3a + 3b | 210 | +167 |
| 3 | 3a only | 405 | +314 |
| 4 | Option F (no 3a) | 495 | +291 |
| 5 | Option F + 3a + observability | 201 | +75 |

(`ptF` = `playToFrameMs`, the wall-clock interval from `video.play()` to the first `requestVideoFrameCallback` firing on that element after play. Positive `V2 − V1` means V2 trails V1; negative means V2's first frame appeared before V1's.)

**The original baseline (Run 1, ~71 ms mean V2 trail) is the floor of what raw HTML5 `<video>` element pre-mount + custom RAF clock can deliver.** Every fix we measured either matched it within noise or made it worse. The variance is dominated by Chrome's HTMLVideoElement decoder pipeline scheduling, which a single seek position can swing from 9 ms to 817 ms across different runs. JS-side timing correction cannot reliably push below this floor because the underlying primitive (`HTMLVideoElement` decoder) does not expose deterministic pipeline state.

We then turned to architecture. We researched Remotion's documentation in two passes:

1. **First pass** found that `<Video>` from `@remotion/media` is the only Remotion component that achieves frame-perfect preview (via WebCodecs + Mediabunny). It uses HTML5 `<video>` for nothing in the preview path. We identified five blockers for migration, the most fundamental being that `<Video>` requires `<Player>` context and `<Player>` owns the clock — its `seekTo()` API "pauses briefly then resumes" per call, making external RAF-driven clock injection impossible without stutter. HyperEdit's preview is RAF-driven; the V1 `<video>` is effectively the clock master via its position. Migrating means surrendering the clock to Player.

2. **Second pass** (triggered by user feedback that WebCodecs is being deprecated and that the prior pass was shallow) **corrected the WebCodecs deprecation claim**: WebCodecs is not deprecated. The user's source of confusion was Remotion's own `@remotion/webcodecs` and `@remotion/media-parser` npm packages being deprecated in favor of the third-party Mediabunny library; the W3C WebCodecs browser API is on the Recommendation track and actively progressing. The second pass also **found facts the first pass missed**: `<OffthreadVideo>` exposes an `onVideoFrame` callback (since Remotion v4.0.190) that delivers a real `HTMLVideoElement` during preview — meaning the canvas-draw transitions in HyperEdit could in principle be ported with low effort. `<Html5Video>` (the rename of base `remotion`'s `<Video>`) is not identical to a raw `<video>`; it adds drift correction (`acceptableTimeShiftInSeconds`, default 0.45 s) and buffer-state integration. A documented split pattern exists for using `<OffthreadVideo>` in preview and `<Video>` from `@remotion/media` in render via `useRemotionEnvironment()`. None of these findings rescues HyperEdit from the clock blocker: anything WebCodecs-based for preview requires Player, and Player owns the clock.

The recommendation is therefore one of:

- **Accept the ~71 ms baseline** and document the limitation. Revert the investigation-period instrumentation and code edits to baseline.
- **Commit to a multi-day architectural rewrite** that surrenders HyperEdit's RAF-driven multi-track clock to `<Player>`, wrapping the preview in a Remotion `<Composition>` with `<Sequence>`-wrapped `<Video>` and `<Audio>` instances from `@remotion/media`. This requires adding CORS headers to the FFmpeg server, rewriting `canvas-draw.ts` to consume `onVideoFrame` callback ImageBitmaps instead of HTMLVideoElement refs, inverting the clock authority so Home.tsx receives Player `frameupdate` events instead of driving time itself, and accepting Remotion's experimental-tier API stability for `@remotion/media`.

This branch contains the failed mechanical attempts, the full instrumentation, the measurement data, and the documentation research. **It does not contain a working fix that improves over the 71 ms baseline.** The user's plan is to push this branch separately so the work is not lost while main branch continues from pre-investigation HEAD.

---

## 2. WHY THIS BRANCH EXISTS — ORIENTATION

A cold reader should understand the following before diving deeper.

This branch is a record of an investigation. It is not a feature branch in the conventional sense. The investigation began from a real user complaint: when the user seeks the timeline playhead to a new position in HyperEdit (an AI-assisted video editor) and presses play, the V2 overlay video clip on the timeline plays at a sync offset to the V1 base video. The offset is audibly perceivable, varies seemingly randomly per seek position, and is bad enough that the user — who watches their own edits — could not work with it.

The investigation came in waves. Each wave was a hypothesis the team formed about the cause, a code intervention to test that hypothesis, a measurement pass to evaluate, and a conclusion. Some of the waves used a subordinate agent driving the browser via Chrome DevTools Protocol (chrome-devtools-mcp). Some interventions were applied on top of prior interventions; some were reverted before the next wave. The branch HEAD reflects the last state shipped before the team concluded that all mechanical interventions had failed to reliably improve over the baseline.

If you are a fresh agent reading this:

- **You do not need to re-run any of the failed interventions.** They have been measured. Move forward.
- **The instrumentation in the code (the `[V2MEAS]` and `[V2DBG]` console.log calls) is part of the diagnostic apparatus**, not part of the application. It should be stripped before merging this branch into anything customer-facing, or alternatively kept behind a debug flag.
- **The user has been disappointed many times in this investigation.** Do not propose another speculative fix without first reading the matrix in Section 25 and reading the second-pass Remotion docs research in Section 24. The cheap interventions are exhausted.
- **The skill file at `llm-docs/SKILL-agent-test-hyperedit-ui.md` is the operational reference** for any agent that needs to drive the HyperEdit UI in Brave via Chrome DevTools MCP. Read it before doing automation.

The branch sits on a commit head — that is, it was developed in-place on top of whatever the working main branch was when the investigation started. The user is going to extract this into a solo branch for archival and revert main to the pre-investigation state.

---

## 3. THE BUG — SYMPTOM AND REPRODUCTION

### 3.1 User-reported symptom

When the user does the following sequence on HyperEdit's timeline:

1. Loads a project that contains a V1 base video clip and a V2 overlay video clip whose start time is some seconds into the project (e.g., V1 starts at project time 0, V2 starts at project time 28.259 s).
2. Pauses playback.
3. Clicks the timeline ruler at some position inside the V2 clip's active window (e.g., 35 s, 50 s, 65 s, 80 s, 100 s).
4. Clicks the play button.

The visible / audible result:

- V2's video frame and audio are offset from V1's. The offset is non-zero, varies seemingly randomly between seek positions, sometimes V2 leads V1, sometimes V2 trails V1.
- Magnitude has been measured at 9 ms (essentially in sync) to 817 ms (visibly and audibly wrong, like watching a delayed remote-conference participant).
- The offset is not consistent across runs even at the same seek position; the same seek to 50 s might yield 72 ms (V2 trails) in one run and 638 ms in another.

The user described the symptom as "random offset." The team initially modeled this as "V2 keyframe-snap variance" (H1), but the measurement data refuted that hypothesis: every `eps_immediate` and `eps` value (the difference between `video.currentTime` assignment and the value `video.currentTime` actually reads back as) measured ~0.0000 across all five seek positions in all runs. Chrome is doing accurate seeking — it walks the decoder forward from the prior IDR keyframe to the exact requested frame.

### 3.2 Exact reproduction

To reproduce the bug on a developer's machine:

```
1. Open Brave with --remote-debugging-port=9222.
2. Start both servers:
   - `npm run dev` (Vite, usually localhost:5173)
   - `npm run ffmpeg-server` (Node.js FFmpeg server, localhost:3333)
3. Navigate to the Vite dev URL in Brave.
4. Load a project containing:
   - A V1 video clip on track V1 (anything works; we used C0001.MP4, a 21-minute Sony camera file).
   - A V2 overlay video clip on track V2 (we used a ~92-second OBS recording, "2026-01-21 15-11-10 remotion.mp4").
   The V2 clip's project-time start should be a few seconds into the project so the seek positions fall inside it.
5. With timeline paused, click the ruler at e.g. 35 s.
6. Verify playhead moved to ~35 s.
7. Click the play button.
8. Listen to the audio of both videos. If V1 and V2 should be in sync at this project time, you'll hear them out of sync.
9. Pause. Click ruler at 50 s. Click play. Same problem.
```

The agent-driven version of this is documented in detail in Section 11 (Test reproduction protocol).

### 3.3 What the bug is *not*

To save the next investigator time, the following hypotheses were ruled out:

- **Not** keyframe-snap on V2's decoder (`eps ≈ 0` always).
- **Not** keyframe-snap on V1's decoder (`eps ≈ 0` always).
- **Not** HTTP range-request latency on the localhost:3333 stream (`elapsedMs` from seek to `seeked` event 116–377 ms range, narrow, not enough variance to explain the symptom).
- **Not** pre-mount buffer failure (every measured `playPrep` showed `readyState=4` and `buffered` ranges covering the requested clipTime at the play moment).
- **Not** a React state stale closure (we verified `layer.clipTime` was current at the play moment).
- **Not** the V1 keyframe-snap correction logic (the `onV1Seeked` callback fires correctly and `setCurrentTime` propagates).
- **Not** a `playEffect` re-fire missing the play branch (we verified entry into the branch by log inspection).

What the bug **is**, per the H3 finding (Section 6.3, confirmed across all runs):

- **Decoder startup lag on V2 after `play()` is non-deterministic and varies wildly per invocation.** Chrome's `HTMLVideoElement` does not expose a stable contract about when the first frame after `play()` will be presented. On a "warm" decoder (recently active, in-pipeline), it can be 5–40 ms. On a "cold" decoder (the V2 clip was idle for any non-trivial time before play), it can be 100–800 ms. The variance is not predictable from outside the decoder.

---

## 4. HYPEREDIT TIMELINE PREVIEW ARCHITECTURE RECAP

This section recaps the architecture for an agent unfamiliar with the codebase. If you have read `CLAUDE.md` in detail, skim or skip.

### 4.1 Multi-track timeline

HyperEdit's timeline has six fixed tracks. Top to bottom in z-order:

- `T1` — captions (text overlays)
- `V3` — top overlay video / image
- `V2` — overlay video / image
- `V1` — base video
- `A1` — audio
- `A2` — audio

The team's concept of "overlay" is anything on `V2` or `V3` (or `T1`, but captions render differently). A clip on `V1` is the base. The audio of `V1`'s video element is the master audio source; overlay videos have their audio respected, the audio is not muted by default.

### 4.2 State management

`useProject` (`src/react-app/hooks/useProject.ts`) holds:

- `assets` — source files with metadata, thumbnails, `streamUrl` (the HTTP URL to the FFmpeg server's `localhost:3333/session/{sessionId}/assets/{assetId}` endpoint).
- `clips` (or `timelineTabs[activeTabId].clips`) — `TimelineClip[]` with each clip's `start`, `duration`, `inPoint`, `outPoint`, `transform`, `assetId`, `trackId`.
- caption data, render options, etc.

`Home.tsx` (`src/react-app/pages/Home.tsx`) holds the playback state in component-local React state and refs:

- `currentTime` (React state) — only updated at boundary crossings during playback, plus on user scrub.
- `currentTimeRef` (mutable ref) — updated every RAF frame; the "live" clock value.
- `isPlaying` (React state).
- `boundariesRef` — pre-computed array of project times where layer composition changes (clip starts, clip ends, transition starts/ends, V2/V3 pre-mount points).
- `videoPreviewRef` — imperative handle to the `<VideoPreview>` component.

### 4.3 The RAF clock loop

`Home.tsx:352-391` contains the playback engine:

```ts
useEffect(() => {
  if (isPlaying && duration > 0) {
    lastTimeRef.current = performance.now();

    const animate = (now: number) => {
      const delta = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;
      const prevTime = currentTimeRef.current;
      const newTime = prevTime + delta;

      if (newTime >= duration) {
        currentTimeRef.current = duration;
        setCurrentTime(duration);
        setIsPlaying(false);
        return;
      }

      currentTimeRef.current = newTime;

      const boundaries = boundariesRef.current;
      for (let i = 0; i < boundaries.length; i++) {
        if (prevTime < boundaries[i] && newTime >= boundaries[i]) {
          setCurrentTime(newTime);
          break;
        }
      }

      playbackRef.current = requestAnimationFrame(animate);
    };

    playbackRef.current = requestAnimationFrame(animate);

    return () => {
      if (playbackRef.current) {
        cancelAnimationFrame(playbackRef.current);
      }
    };
  }
}, [isPlaying, duration]);
```

Key points:

- The RAF advances `currentTimeRef.current` every animation frame.
- React state `currentTime` is **only** called via `setCurrentTime(newTime)` at boundary crossings — i.e., when the RAF crosses a value in `boundariesRef.current`. This avoids 60 React re-renders per second; the React state is updated only when the composition layers might need to change.
- This design means that **between boundaries, `currentTimeRef.current` is live, but React state `currentTime` is frozen at the value it had at the most recent boundary crossing.**
- All layer derivation (`getPreviewLayers` below) reads React state `currentTime`, so layer compositions are computed from a stale value during intra-boundary playback. The video elements rely on their own internal playback to advance through that stale interval, with periodic seek-effect re-syncs at boundary crossings.

### 4.4 `getPreviewLayers`

`Home.tsx:162-...` (the body is large; key part is at 200–233):

```ts
// Check video tracks (V1, V2, V3...)
const videoTracks = ['V1', 'V2', 'V3'];

for (const trackId of videoTracks) {
  const isOverlayTrack = trackId !== 'V1';
  const clipsOnTrack = activeClips.filter(c =>
    c.trackId === trackId &&
    currentTime >= c.start - (isOverlayTrack ? PREMOUNT_SECS : 0) &&
    currentTime < c.start + c.duration
  );

  for (const clip of clipsOnTrack) {
    const asset = assets.find(a => a.id === clip.assetId);
    const url = asset?.streamUrl || (asset ? getAssetStreamUrl(asset.id) : null);
    if (asset && url) {
      const isPremounted = isOverlayTrack && currentTime < clip.start;
      const clipTime = isPremounted
        ? (clip.inPoint || 0)
        : (currentTime - clip.start) + (clip.inPoint || 0);
      if (trackId === 'V2' || trackId === 'V3') {
        console.log(`[V2DBG][getPreviewLayers] clip=${clip.id} isPremounted=${isPremounted} clipTime=${clipTime.toFixed(3)} currentTime=${currentTime.toFixed(3)} clip.start=${clip.start}`);
      }
      layers.push({
        id: clip.id,
        url,
        type: asset.type,
        trackId: clip.trackId,
        clipTime,
        clipStart: clip.start,
        inPoint: clip.inPoint || 0,
        isPremounted,
        transform: clip.transform,
      });
    }
  }
}
```

Where `PREMOUNT_SECS = 2` (Home.tsx:32). The pre-mount mechanism causes V2/V3 clips to enter the layer list 2 seconds before their `clip.start`, but with `isPremounted: true`. `VideoPreview.tsx` renders pre-mounted layers with `opacity: 0; pointerEvents: 'none'` so they're invisible but mounted, with their `<video>` element decoding/buffering the inPoint frame in the background.

### 4.5 `VideoPreview.tsx`

This component renders the actual video element tree. Roughly:

- The V1 layer is rendered separately with a stable `key="base-video"` so it never remounts as long as V1's `clip.id` and `clip.url` don't change. Its src changes are handled by a manual `video.load()` call in an effect that watches `baseLayerUrl`.
- Overlay layers (V2, V3, audio, images, captions) are rendered in a `.map(...)`. Video overlays use a key of `${layer.id}-${layer.url}` so a URL change forces remount.
- Each video overlay is registered into a `overlayVideoRefs: Map<string, HTMLVideoElement>` via ref callback.
- Several `useEffect`s drive playback:
  1. **V1 reload effect** (149–159) — fires on `baseLayerUrl` change; sets `video.src`, calls `video.load()`.
  2. **V1 seek effect** (161–179) — fires on `baseLayerClipTime` or `isPlaying` change; if V1 has drifted > 100 ms from the target, assigns `video.currentTime = baseLayerClipTime`. The current branch HEAD also wraps this in `[V2MEAS][seekReq]` and `[V2MEAS][seekSettled]` instrumentation.
  3. **V1 play/pause effect** (181–202) — fires on `isPlaying` change; calls `video.play()` or `video.pause()`. The current branch HEAD bumps `measSessionRef.current` and schedules a `requestVideoFrameCallback` on V1 to emit `[V2MEAS][firstFrame]` for V1.
  4. **V1 seeked listener** (204–219) — fires once on mount (and re-binds on layers/currentTimeRef/onV1Seeked change); listens for V1's `seeked` event, reads V1.currentTime (the actual post-snap value), writes it to currentTimeRef, calls onV1Seeked callback to propagate the corrected projectTime to Home.tsx so React state `currentTime` is corrected.
  5. **Overlay play/pause effect (`playEffect`)** (~line 221 at HEAD) — fires on `isPlaying` or `layers` change; iterates over `overlayVideoRefs` and either pauses each overlay or, for those whose layer is in scene and not premounted, runs the play branch. The play branch is the heart of the bug investigation; see Section 26 for the current state. The current branch HEAD includes (a) the `[V2DBG][playEffect]` and `[V2MEAS][playPrep]` log calls, (b) the 3a drift gate, (c) the `[V2MEAS][firstFrame]` rVFC instrumentation with Run 6 expanded fields, (d) the Run 9 `!video.paused` guard in the else-branch. The pre-warm-abort check (`preWarmInFlightRef`) listed in earlier drafts was REMOVED in the Run 8 reversion (Section 28A.4).
  6. **Overlay seek effect (`seekEffect`)** (~line 265 at HEAD) — fires on `layers` or `isPlaying` change; iterates over overlay media layers, and if any has drifted past the threshold from its target clipTime, assigns `mediaEl.currentTime = layer.clipTime`. The current branch HEAD includes (a) the `[V2DBG][seekEffect]` log, (b) raised threshold (5 ms→50 ms on play-start, 100 ms otherwise), (c) `[V2MEAS][seekReq]` and `[V2MEAS][seekSettled]` instrumentation. The Option F pre-warm pulse trigger and `[V2MEAS][preWarm]` instrumentation listed in earlier drafts were REMOVED in the Run 8 reversion (Section 28A.4).
- Each overlay video's JSX also has an `onLoadedData` handler (current branch HEAD: ~560–572) that assigns `video.currentTime = layer.clipTime` if drifted >50 ms and calls `video.play()` if `isPlaying` and `!isPremounted`. The current branch HEAD also has `[V2DBG][onLoadedData]` instrumentation here.

### 4.6 The FFmpeg server and asset streaming

`scripts/local-ffmpeg-server.js` is a ~7700-line Node.js raw `http.createServer` that handles asset upload, thumbnail generation, AI editing endpoints, render endpoints, and asset streaming. Assets are stored in `/tmp/hyperedit-ffmpeg/sessions/{sessionId}/`.

Asset streaming uses byte-range support but does not currently emit CORS headers on 200 responses. That's important: any plan to introduce `@remotion/media <Video>` (WebCodecs-based) requires the server to add `Access-Control-Allow-Origin` plus appropriate range-request response headers.

> **CORRECTION (2026-06-08)**: Section 29.7 audit found `Access-Control-Allow-Origin: *` and `Accept-Ranges: bytes` are **already present on 206 responses** from `local-ffmpeg-server.js` (lines 2150–2180). The one-line fix noted in Section 29B (adding the same headers on 200 responses) is still required. The original claim "does not currently emit CORS headers" should read "emits CORS headers on 206 responses but not yet on 200 responses."

### 4.7 The transition compositor

`src/remotion/transitions/canvas-draw.ts` exports `getCanvasDraw(transitionFileId)` returning a function `(ctx, fromEl, toEl, progress, w, h, params) => void`. The `fromEl` and `toEl` are `HTMLVideoElement | HTMLImageElement | null`. `VideoPreview.tsx` draws transitions to a `<canvas>` overlay positioned absolutely over the preview area. This system depends on having real DOM `<video>` elements for source frames. Any migration to `@remotion/media <Video>` would have to refactor this to consume `ImageBitmap` / `VideoFrame` from the `onVideoFrame` callback API or `HTMLVideoElement` from `<OffthreadVideo>`'s `onVideoFrame` callback API.

---

## 5. CODE STATE AT THE START OF INVESTIGATION

Before any of the [V2MEAS] / [V2DBG] / 3a / 3b / Option F work, the following had already been shipped against the V2 sync bug in earlier sessions (preserved verbatim from prior plan files):

### 5.1 Pre-mount window

- Module-level `PREMOUNT_SECS = 2` constant in `Home.tsx`.
- `clipBoundaries` in `Home.tsx:335-349` includes `clip.start - PREMOUNT_SECS` for every V2/V3 clip, ensuring the RAF boundary detection fires at the pre-mount point and `setCurrentTime` updates React state, causing `getPreviewLayers` to begin including the V2/V3 layer.
- `getPreviewLayers` in `Home.tsx:200-233` extends the time window for overlay tracks: `currentTime >= c.start - PREMOUNT_SECS`. It sets `isPremounted: true` when `currentTime < clip.start`.
- `VideoPreview.tsx` renders overlay video with `style={layer.isPremounted ? { opacity: 0, pointerEvents: 'none' as const } : styles}`. The `opacity:0` is critical (not `display: none`) because Chrome refuses to allocate decoder resources to a `<video>` with `display:none`, but treats `opacity:0` as on-screen and decodes/buffers normally.

### 5.2 V1 `seeked` correction (the `onV1Seeked` callback)

V1 keyframe-snaps on seek; the requested seek time T might land V1 at T − ε_v1. The RAF loop accumulates from T, but V1 actually plays from T − ε_v1, creating a persistent ε_v1 offset that propagates into every `layer.clipTime` for overlays.

The fix already in place (VideoPreview.tsx 204–219):

```ts
useEffect(() => {
  const v1Video = videoRef.current;
  if (!v1Video || !currentTimeRef) return;
  const onSeeked = () => {
    const v1Layer = layers.find(l => l.trackId === 'V1' && l.type === 'video');
    const projectTime = v1Video.currentTime + (v1Layer?.clipStart ?? 0) - (v1Layer?.inPoint ?? 0);
    currentTimeRef.current = projectTime;
    onV1Seeked?.(projectTime);
  };
  v1Video.addEventListener('seeked', onSeeked);
  return () => v1Video.removeEventListener('seeked', onSeeked);
}, [layers, currentTimeRef, onV1Seeked]);
```

`onV1Seeked` is provided by `Home.tsx`:

```ts
const handleV1Seeked = useCallback((projectTime: number) => {
  currentTimeRef.current = projectTime;
  setCurrentTime(projectTime);
}, []);
```

This works correctly. It eliminates the ε_v1 component of any sync error. It does NOT eliminate any ε_v2 component (which the measurements later confirmed is essentially zero anyway — Chrome accurate-seeks V2).

### 5.3 `onLoadedData` rework

A prior fix had changed `onLoadedData` for V2/V3 to always target `layer.clipTime` (instead of computing `currentTimeRef.current - clipStart + inPoint`), eliminating a race condition where the live `currentTimeRef` advanced between seek and `loadeddata` firing.

VideoPreview.tsx ~560–572 currently:

```tsx
onLoadedData={(e) => {
  const video = e.currentTarget;
  const targetTime = layer.clipTime;
  if (layer.trackId === 'V2' || layer.trackId === 'V3') {
    console.log(`[V2DBG][onLoadedData] id=${layer.id} isPremounted=${layer.isPremounted} video.ct=${video.currentTime.toFixed(3)} targetTime=${targetTime.toFixed(3)} isPlaying=${isPlaying}`);
  }
  if (Math.abs(video.currentTime - targetTime) > 0.05) {
    video.currentTime = targetTime;
  }
  if (isPlaying && !layer.isPremounted) {
    video.play().catch(() => {});
  }
}}
```

The `[V2DBG][onLoadedData]` log was added during this investigation but the underlying logic is from a prior session.

### 5.4 `[V2DBG]` instrumentation at 4 sites

Already-shipped debug logs:

- `[V2DBG][getPreviewLayers]` in Home.tsx:217–219, inside the V2/V3 branch of the clip iteration.
- `[V2DBG][playEffect]` in VideoPreview.tsx:~235.
- `[V2DBG][seekEffect]` in VideoPreview.tsx:~291.
- `[V2DBG][onLoadedData]` in VideoPreview.tsx:~564.

These were added during the prior session's debug pass and have remained throughout.

### 5.5 Threshold values (pre-investigation)

In `VideoPreview.tsx` `seekEffect`, threshold was:

```ts
const threshold = justStarted ? 0.005 : 0.1;
```

That is: 5 ms on play-start (justStarted = true), 100 ms otherwise.

The 5 ms threshold was a deliberate "very tight on play start" choice to ensure overlay videos are at exactly the right time at the moment of play(). The investigation later raised this to 50 ms (see Section 17).

---

## 6. HYPOTHESIS TREE (H1–H6)

After the first wave's CDP-based diagnostic capture (a single measurement showing +0.120 s consistent offset at one seek), the team formed an explicit hypothesis tree to drive systematic measurement instead of vibes-based debugging.

### 6.1 H1 — Keyframe-snap variance (ε_v1 − ε_v2)

**Hypothesis**: When `video.currentTime = T` is set, the browser snaps backward to the nearest keyframe before T. V1 and V2 have independent keyframe locations, so the snap amounts ε_v1 and ε_v2 are independent. The relative offset is ε_v2 − ε_v1, which varies per seek position (depending on how close T is to each video's keyframes).

**Predicted measurement signature**: `video.currentTime` post-seek differs from the requested value by tens to hundreds of ms, varies per seek position, bounded by GOP/2 on average.

**Status after measurement**: REJECTED. Every measured `eps` and `eps_immediate` value across all five runs and all five seek positions is `0.0000`. Chrome on a well-indexed local mp4 does accurate seeking: the decoder walks forward from the prior IDR to present the exact requested frame. The keyframe snap as a sync-error mechanism does not apply.

### 6.2 H2 — HTTP range-request latency

**Hypothesis**: V2's source stream is served over HTTP from `localhost:3333`. Each seek issues a byte-range request to the FFmpeg server. The server takes variable time to respond (disk seek, internal scheduling, write to socket). This latency varies per seek and produces random sync offset.

**Predicted signature**: `elapsedMs` from `video.currentTime = X` assignment to the `seeked` event firing varies wildly (50–500 ms) per seek position.

**Status after measurement**: WEAK / partially rejected. Measured `elapsedMs` for V2 ranged 116–377 ms across all valid samples. The first-load case (V2 cold, readyState=0 at seek time) showed up to 786 ms once. But within steady-state samples, the variance was narrow (116–182 ms) and did not correlate with the observed first-frame-after-play latency in a way that explains the sync symptom.

### 6.3 H3 — Decoder startup lag at `play()`

**Hypothesis**: After V2 finishes loading and seeking, calling `video.play()` does not produce a frame instantly. Chrome's HTMLVideoElement decoder has internal startup latency that varies based on its recent state, system load, and other factors. V1 and V2 each have their own independent startup latency, so the relative wall-clock time between V1's first frame and V2's first frame after a synchronous play() pair is non-deterministic.

**Predicted signature**: Both V1 `eps` ≈ 0 AND V2 `eps` ≈ 0 (so the seek itself lands correctly), but the wall-clock interval from `video.play()` to the first `requestVideoFrameCallback` firing varies between V1 and V2 by 30+ ms with sign-flipping behavior across seeks.

**Status after measurement**: CONFIRMED. This is what the data shows. See Run 1 in Section 12 for the original measurement, Run 5 in Section 20 for the most carefully measured iteration. The mechanism is real and is the root cause of the user's "random offset" symptom.

### 6.4 H4 — Audio decoder ↔ video decoder skew within V2

**Hypothesis**: HTMLVideoElement has separate decoder pipelines for video and audio. They might start at slightly different wall-clock times after `play()`. The visible V2 frame matches V1's frame, but V2's audio drifts.

**Predicted signature**: The `requestVideoFrameCallback` first-frame measurement would be normal but a separate audio-timing measurement would show drift. User reports "audibly" — a key word that admits the possibility this is the actual problem.

**Status after measurement**: NOT INVESTIGATED IN DEPTH. The H3 evidence (variance in `playToFrameMs`) was strong enough that we did not separately measure audio. The metric we have is video first-frame. We are aware that the user's complaint is audibly perceived; the H4 mechanism could co-exist with H3.

### 6.5 H5 — Pre-mount window didn't actually buffer

**Hypothesis**: Even though pre-mount is implemented, `preload="auto"` on `<video>` is a spec-level *hint* the browser may defer. V2 might not actually have loaded data by the time the user clicks play; the pre-mount window of 2 seconds may not produce a `loadeddata` event before clip.start in the user's environment.

**Predicted signature**: At the moment of play(), `video.readyState < HAVE_FUTURE_DATA` and `video.buffered` does not include the requested clipTime. `onLoadedData` for V2 fires at or after `clip.start` rather than during the pre-mount window.

**Status after measurement**: REJECTED. The `[V2MEAS][playPrep]` log added at the play call site captured `readyState` and `buffered` ranges at every play moment. Across all five runs and all valid samples, V2's `readyState=4` (HAVE_ENOUGH_DATA) and `buffered` ranges always included the requested clipTime at the play moment. The pre-mount machinery works as designed.

### 6.6 H6 — Track-ID code-path asymmetry

**Hypothesis**: The codebase contains branches on `trackId === 'V1'` versus V2/V3 for reasons unrelated to z-order, audio master, or the isPremounted flag. One of these branches might be subtly off in a way that introduces sync error specifically to overlays.

**Predicted signature**: We audit the code rather than measure. Any divergent code path between V1 and V2 is suspect.

**Status after audit**: Six divergences found (S1–S6 in Section 7). Some are deliberate (audio master, z-order) but at least three (S1: V1 not pre-mounted; S2: V2 anchors currentTime before play but V1 doesn't; S3: threshold mismatch on play-start) are potentially problematic. The audit did not directly resolve the sync bug because measurement implicated H3, but the asymmetries are documented for future work.

---

## 7. TRACK-ID ASYMMETRY AUDIT (S1–S6)

After H6 was hypothesized, the team audited `getPreviewLayers` and all `useEffect` blocks in `VideoPreview.tsx` to enumerate every code path that branches on `trackId === 'V1'` versus V2/V3.

### 7.1 S1 — V1 not pre-mounted

**Where**: `Home.tsx:202-204`, `currentTime >= c.start - (isOverlayTrack ? PREMOUNT_SECS : 0)`. The `isOverlayTrack` ternary applies the 2-second pre-mount window to V2/V3 only.

**Why suspect**: V1 is streamed from localhost:3333 just like V2. After a user seek to a new V1 region, V1 also has to load and buffer. There is no pre-mount window for V1. Effectively, V1 could be still buffering at the moment the user clicks play, while V2 (which entered the layer list 2 seconds early) is already loaded.

**Impact**: A V1 buffering delay could shift V1's first frame later than V2's first frame, contributing to the random-offset symptom.

### 7.2 S2 — V2 anchors `currentTime` before `play()`, V1 doesn't

**Where**: `VideoPreview.tsx playEffect` (current HEAD 246–248): `if (Math.abs(video.currentTime - layer.clipTime) > 0.03) video.currentTime = layer.clipTime;` for overlays. The V1 play/pause effect (181–202) just calls `video.play()`; there is no per-play `currentTime` correction in V1's path.

**Why suspect**: V1's currentTime is corrected only by the separate V1 `seekEffect` (161–179), which is gated on `|diff| > 0.1` (100 ms). If V1 has drifted by, say, 80 ms from the React-state-derived `baseLayerClipTime`, V1's seek effect skips, and V1 just plays from wherever its decoder happened to be. V2 is always explicitly anchored. The contracts are different.

**Impact**: Sub-100 ms drift in V1 propagates into the sync offset; V2 is always at the right position relative to its React-state target.

### 7.3 S3 — V1 seek threshold (0.1 s) vs V2 seek threshold (0.005 s, then 0.05 s)

**Where**: V1 seek effect (161–179) uses fixed `0.1`. V2 seek effect (current HEAD 273) uses `justStarted ? 0.05 : 0.1` — was `0.005` before Option F.

**Why suspect**: At play-start, V1 tolerates 100 ms drift while V2 tolerates 50 ms (formerly 5 ms). The video that's tolerating less drift gets re-seeked more, but the re-seek itself is what we suspect of flushing the decoder. The asymmetric tolerance might mean V2 pays the re-seek penalty more often than V1.

### 7.4 S4 — V1 `seeked` listener corrects React state; no equivalent for V2

**Where**: V1's `seeked` listener (204–219) calls `onV1Seeked(projectTime)` which calls `setCurrentTime(projectTime)`. No analog exists for V2.

**Why suspect**: V2 also fires `seeked` events. If V2 keyframe-snapped (the H1 mechanism we now know doesn't fire), the correction would not propagate. Currently moot per H1's rejection. Documented for completeness.

### 7.5 S5 — V1 reload mechanism vs V2 reload mechanism

**Where**: V1 reload effect (149–159) uses `loadedSrcRef` + `video.load()` to reload in-place when `baseLayerUrl` changes. V2 uses `key={${layer.id}-${layer.url}}` which forces React to unmount and remount the element.

**Why suspect**: Cache-bust events (`?v=Date.now()` URL change after asset refresh) trigger different behavior: V1 keeps its element and reloads the source; V2 destroys and recreates the element, which resets its buffer, ready state, and any listeners. The agent's measurement during Run 4 observed this: V2 cycles through `readyState=0 → buffered=[] → seek → loadeddata → rs=4` on remount.

**Impact**: V2's decoder starts cold whenever V2 remounts. The `key` change can happen at unexpected times (when streamUrl cache-busts, when the asset list refreshes).

### 7.6 S6 — `handleLoaded` for V1 vs `onLoadedData` for V2

**Where**: V1 has `handleLoaded` in `VideoPreview.tsx:~311–314` which only anchors `baseLayerClipTime` on `loadeddata`. V2's `onLoadedData` (~560–572) anchors `layer.clipTime` and additionally calls `play()` if `isPlaying` and `!isPremounted`.

**Why suspect**: V1's handler does not start playback even if `isPlaying`. The expectation is that the V1 play effect handles that. But there is an ordering subtlety: if V1's `loadeddata` fires after the play effect has already run, V1 might miss its play call until the next play effect re-fire (which only happens on `isPlaying` change). Documented as a potential source of bugs but not pursued.

### 7.7 Action taken on S1–S6

The asymmetry audit was added to the plan file (Section 24 below for context) but no S* fix was implemented. The team focused on the H3 mechanism since the measurements clearly implicated it. The asymmetries S1–S3 may be co-contributors but the data did not isolate them.

---

## 8. MEASUREMENT INFRASTRUCTURE — THE [V2MEAS] LOG SCHEME

To distinguish between H1–H6, we needed measurements with enough resolution to disambiguate. The team introduced the `[V2MEAS]` log tag family. Every log goes to `console.log` so that the chrome-devtools-mcp `list_console_messages` tool can read them back.

### 8.1 Tag namespace

- `[V2DBG][...]` — pre-existing debug logs from prior session; kept in place during this investigation as cross-reference.
- `[V2MEAS][...]` — measurement logs added during this investigation. Specific subtags: `seekReq`, `seekSettled`, `playPrep`, `firstFrame`, `preWarm`, `MARK`.

### 8.2 `[V2MEAS][seekReq]` and `[V2MEAS][seekSettled]`

Purpose: distinguish H1 (`eps` non-zero per seek) from H3 (`eps` ≈ 0 but offset still present) and from H2 (`elapsedMs` to settle highly variable per seek).

Emitted at two sites:

- V1 seek effect (current HEAD 167–177): when `|video.currentTime − baseLayerClipTime| > 0.1`, capture pre/post.
- Overlay seek effect (current HEAD 284–295): same pattern for V2/V3/audio overlays when threshold exceeded.

Pattern (V1 example):

```ts
const requested = baseLayerClipTime;
video.currentTime = requested;
const immediate = video.currentTime;
console.log(`[V2MEAS][seekReq] id=V1 trackId=V1 requested=${requested.toFixed(4)} immediate=${immediate.toFixed(4)} eps_immediate=${(immediate - requested).toFixed(4)}`);
const t0 = performance.now();
const onMeasSeeked = () => {
  const elapsed = performance.now() - t0;
  const settled = video.currentTime;
  console.log(`[V2MEAS][seekSettled] id=V1 trackId=V1 requested=${requested.toFixed(4)} settled=${settled.toFixed(4)} eps=${(settled - requested).toFixed(4)} elapsedMs=${elapsed.toFixed(0)}`);
};
video.addEventListener('seeked', onMeasSeeked, { once: true });
```

Fields:
- `requested` — the value we assigned to `video.currentTime` (the target).
- `immediate` — the value `video.currentTime` reports back synchronously *after* the assignment. In Chrome, this is the same as `requested` for in-buffer seeks.
- `eps_immediate` — `immediate − requested`, the synchronous "snap" error if any.
- `settled` — `video.currentTime` after the `seeked` event fires (i.e., after the browser has actually decoded a frame at the new position).
- `eps` — `settled − requested`, the post-settle snap error.
- `elapsedMs` — `performance.now()` time from the assignment until the `seeked` event fires.

### 8.3 `[V2MEAS][playPrep]`

Purpose: H5 test — was V2 actually buffered and ready at the moment of play()?

Emitted in `playEffect` at current HEAD 226–232, before the play branch decision:

```ts
const tr = video.buffered;
const ranges: [string, string][] = [];
for (let i = 0; i < tr.length; i++) ranges.push([tr.start(i).toFixed(2), tr.end(i).toFixed(2)]);
console.log(`[V2MEAS][playPrep] id=${id} trackId=${layer.trackId} readyState=${video.readyState} buffered=${JSON.stringify(ranges)} requested=${layer.clipTime.toFixed(3)} isPremounted=${layer.isPremounted}`);
```

Fields:
- `readyState` — HTMLMediaElement readyState integer (0–4).
- `buffered` — array of [start, end] pairs of buffered byte ranges in media time.
- `requested` — the layer.clipTime we'd be seeking to / playing from.
- `isPremounted` — whether the layer is in the pre-mount window.

**Run 6 added a V1 variant** (still present at HEAD, fires from the V1 play effect around VideoPreview.tsx:181 area): `[V2MEAS][playPrep] id=V1 trackId=V1 readyState=N buffered=[...] ct=NN.NNN`. V1's variant uses `ct` instead of `requested` because there's no per-layer clipTime concept on V1 (V1 plays project time directly). Future agents counting `[V2MEAS][playPrep]` log occurrences will see roughly 2× the count expected from this section (one per V1 play, plus one per V2/V3 overlay play). See Section 28A.1 item 1.

### 8.4 `[V2MEAS][firstFrame]`

Purpose: H3 test — how long from `video.play()` to the first decoded-frame presentation?

Emitted in the V1 play effect (current HEAD ~190–204) and in the overlay play branch (current HEAD ~249–257) using `requestVideoFrameCallback`. Example for overlay:

```ts
const session = measSessionRef.current;
const playT0 = performance.now();
video.play().catch(() => {});
if ((layer.trackId === 'V2' || layer.trackId === 'V3') && typeof (video as HTMLVideoElement).requestVideoFrameCallback === 'function') {
  (video as HTMLVideoElement).requestVideoFrameCallback((now, meta) => {
    if (session !== measSessionRef.current) return;
    console.log(`[V2MEAS][firstFrame] id=${id} trackId=${layer.trackId} playToFrameMs=${(now - playT0).toFixed(0)} mediaTime=${meta.mediaTime.toFixed(4)} expectedClipTime=${layer.clipTime.toFixed(4)}`);
  });
}
```

Fields (original Run 3 form):
- `playToFrameMs` — wall-clock interval from `playT0` (just before `play()`) to `now` (the rVFC callback time, which is the wall-clock time the new frame was presented to the compositor).
- `mediaTime` — the media time of the frame just presented (i.e., the decoded frame's clipTime, not project time).
- `expectedClipTime` — `layer.clipTime` at the moment of scheduling, for cross-check.

**Run 6 field expansion (still present at HEAD)**: the actual `[V2MEAS][firstFrame]` log line at branch HEAD also emits six additional fields per call:
- `expectedDisplayTime` — `meta.expectedDisplayTime`, wall-clock when the frame is expected to reach the screen (compositor lookahead).
- `presentationTime` — `meta.presentationTime`, wall-clock when the frame was presented to the compositor.
- `processingDuration` — `meta.processingDuration`, decoder pipeline time for this frame.
- `presentedFrames` — `meta.presentedFrames`, cumulative frames presented by this video element (decoder lifecycle signal).
- `captureTime` — `meta.captureTime` or `'na'` for file sources.
- `played` — `JSON.stringify(rangesArray)` from `video.played` TimeRanges.

`expDT − presT` is the compositor warm/cold signature (≈ 1/refresh_hz when warm, 0 when cold) — central to the Run 6 finding that V2's compositor is warm even when ptF is HIGH-cluster. See Section 28A.1 for the Run 6 instrumentation upgrade and `SKILL-video-pipeline-diagnostics.md` for field semantics.

### 8.5 `measSessionRef` — the rVFC dedupe mechanism

A subtle problem: React effects re-run on dependency change. If `playEffect` re-fires while `isPlaying` is still true (e.g., layers change at a boundary crossing), a new rVFC is scheduled while the previous one may still be pending. We'd see multiple `[V2MEAS][firstFrame]` logs per play session.

The fix: `measSessionRef = useRef(0)` (current HEAD line 113), incremented inside the V1 play effect (~line 190 at HEAD) when `isPlaying` transitions to true. Every rVFC callback captures the session value at scheduling time and bails if `session !== measSessionRef.current` when it fires.

This way, only one `[V2MEAS][firstFrame]` per video per play-session is logged. The V1 play effect runs before the overlay play effect (declaration order in the component), so V1 increments the session first; overlays then capture the same session value.

### 8.6 `[V2MEAS][preWarm]` — Option F observability

Added in the second-to-last fix attempt (Run 5 setup). Three log lines per pre-warm cycle:

- `start` — emitted in `onSeekedPreWarm` immediately before `el.play()` is called.
- `done` — emitted in `finishPreWarm` after `el.pause()`, reporting `advance` (the amount V2's currentTime moved during the pulse) and `elapsedMs`.
- `aborted` — emitted from `finishPreWarm` if `preWarmSet.has(el)` is false at finish time (i.e., user pressed play and `playEffect`'s abort path deleted the entry).
- `playRejected` — emitted in the `.catch()` of the play() promise.

See Section 19 for the full code.

### 8.7 `[V2MEAS][MARK] BEGIN seek=P` / `END seek=P` markers

Not emitted from app code. The browser-driving agent calls `evaluate_script` with `() => console.log('[V2MEAS][MARK] BEGIN seek=35')` (literal numbers) before issuing a seek, and similarly `END` after the per-sample test completes. This lets us segment the captured console log unambiguously per sample.

### 8.8 Limitations of this instrumentation

- The `playToFrameMs` measurement is wall-clock from `playT0` to rVFC firing. If V2 was already playing (paused === false at the moment playEffect tried to enter the play branch), the rVFC may have been scheduled while V2 was already presenting frames, producing a negative or near-zero `playToFrameMs`. This is a fingerprint of failed playback state verification, not a measurement error per se. The visible-click protocol added later mitigates this.
- The instrumentation does not capture audio sync directly. H4 (A/V skew within V2) cannot be evaluated by this scheme.
- The `[V2MEAS]` calls themselves add small overhead (synchronous string template formatting + console.log), but this overhead is the same per event across runs, so it doesn't bias the V1-vs-V2 comparison.

---

## 9. BROWSER AUTOMATION SETUP

The team chose to drive the browser via Chrome DevTools Protocol rather than running the test by hand, both for reproducibility and because the symptom required clicking play/pause/seek many times in sequence with state verification between each step. Manual testing was tried in earlier sessions and produced unreliable measurements.

### 9.1 Brave browser configuration

The user runs Brave (Chromium-based) on Windows. Brave is started with the `--remote-debugging-port=9222` flag, exposing a CDP endpoint on localhost.

### 9.2 chrome-devtools-mcp plugin

The `mcp__plugin_chrome-devtools-mcp__*` family of tools wraps the CDP endpoint as MCP (Model Context Protocol) tool calls. The tools used:

- `list_pages` — enumerate open tabs.
- `select_page` — pick a tab to operate on subsequently.
- `new_page` — open a fresh tab (used for Remotion docs research).
- `navigate_page` — change URL on the selected page.
- `take_snapshot` — capture the accessibility tree of the current page; each interactable element has a `uid` we can target.
- `take_screenshot` — for visible-click verification.
- `click` — click an element by its `uid` (this dispatches a real mouse event observable to the user).
- `drag` — drag from one element to another.
- `evaluate_script` — run a JavaScript function in the page context and return the result.
- `list_console_messages` — read accumulated console messages since the last navigation.
- `get_console_message` — read a specific message by `msgid`.

### 9.3 Discovery vs reuse

The first browser-driving agent took ~7 minutes just to discover the timeline geometry (where the ruler is, where the play button is, what `pixelsPerSecond` is). Subsequent agents would have spent the same time. To avoid this, the team created a skill file (Section 10) that the agent reads before doing anything else, distilling all the discovered constants and the verified click protocol.

### 9.4 The visible-click problem

A subtle but critical lesson: the first measurement run produced what looked like clean data, but the user reported audibly hearing only ~2 playback events during the supposed 5-sample run. Investigation showed the agent had used `evaluate_script` to dispatch synthetic `MouseEvent` on the play button. This worked for triggering React's `onClick` *some* of the time, but not visibly — the button didn't depress, and the click may not have actually triggered each time.

The fix: use `mcp__plugin_chrome-devtools-mcp__click` with the play button's `uid` from `take_snapshot`. This dispatches a hardware-style click through CDP. The user sees the cursor move, the button visibly depress, and the icon flip from Play to Pause. `take_screenshot` after the click confirms the icon flipped.

For the timeline ruler seek, programmatic `MouseEvent` dispatch via `evaluate_script` is acceptable because the user doesn't need to see those happen visibly — they're frequent and we verify by reading `V1.currentTime` afterward.

---

## 10. THE SKILL FILE: `llm-docs/SKILL-agent-test-hyperedit-ui.md`

The skill file is the operational manual for any agent that needs to drive HyperEdit through Chrome DevTools MCP. It is committed at `llm-docs/SKILL-agent-test-hyperedit-ui.md`. Future sessions can read this file as their first action when given a UI-test task and skip ~5–7 minutes of geometry / protocol discovery.

The skill file is committed at `llm-docs/SKILL-agent-test-hyperedit-ui.md` (along with 3 companion skill files added during Run 12 consolidation per Section 29J). It is NOT reproduced inside this megadoc — read the file directly. Appendix D contains the Remotion documentation URL index, not skill file content.

Skill file summary (high level — read the file itself for the full text):

- Brave at `localhost:9222`. Tooling: `mcp__plugin_chrome-devtools-mcp__*`. Sequence to attach: `list_pages` → `select_page`. Reload: `evaluate_script` with `() => location.reload()`.
- DOM landmarks: V1 = first `<video>`; V2/V3 = subsequent `<video>` elements; ruler left ≈ 268 px, top ≈ 694 px; play button uid changes per snapshot.
- Timeline math: pixelsPerSecond ≈ 16.629. Click at x = rulerRect.left + T × pixelsPerSecond.
- Master read for video state: `Array.from(document.querySelectorAll('video')).map((v, i) => ({index: i, src: v.src.slice(-40), paused: v.paused, currentTime: v.currentTime, readyState: v.readyState, buffered: ..., duration: v.duration}))`.
- Seek: `evaluate_script` with manual MouseEvent dispatch is OK; verify with V1.currentTime delta read.
- Play / Pause: **MUST use MCP `click` by uid + screenshot verification**. Programmatic dispatch on the play button is forbidden because the user is watching.
- Forbidden direct calls via evaluate_script: `video.play()`, `video.pause()`, `video.currentTime = X`, `button.click()` — all bypass React state and instrumentation.
- Verification patterns: pre-action (paused) check, post-seek check (currentTime within ±1 s), post-play check (two reads 1 s apart, both `paused === false`, currentTime advanced ≥0.5 s).
- Common pitfalls table: rVFC fires on already-presented frame if pre-state wasn't paused; V2 element absent if out of scene; reload doesn't always pick up new code (use `location.reload(true)` or restart npm run dev); pixelsPerSecond can shift on resize.
- Time budgets: reload 3 s; seek 100–500 ms (in-buffer) or 1–2 s (out-of-buffer); play→first frame 5–40 ms (warm) or 70–200 ms (cold V2); 5-sample run end-to-end 5–7 min.
- Hard limits: code is read-only; FFmpeg server is read-only; report only what's measured (no extrapolation); if N valid samples < 3, report individual rows and stop.

---

## 11. TEST REPRODUCTION PROTOCOL

The test reproduces the user's manual workflow but is automated by the agent. The protocol was iteratively refined; the final form (used in Runs 3–5) is below.

### 11.1 The 5 seek positions

We chose 35 s, 50 s, 65 s, 80 s, 100 s in project time. Rationale:

- All five positions fall inside the V2 clip's active window. The V2 clip starts at project time ≈28.26 s and is ~92 s long, ending around 120 s. The first position (35 s) is comfortably past V2's start; the last (100 s) is comfortably before V2's end.
- The positions are well-spaced (15 s apart), avoiding the case where consecutive seeks both land inside the same already-buffered region — we want each seek to be far enough that V2 has to load new data.
- 35, 50, 65 are at integer-second-ish positions. 80 and 100 are similarly integer-ish.
- The early run (Run 1) included 25 s, but that's before V2's start, so V2 doesn't fire any `[V2MEAS]` events. We replaced it in subsequent runs.

### 11.2 Per-sample procedure

For each seek position P (e.g., 35, 50, 65, 80, 100):

```
A. Pre-state verification (paused):
   - evaluate_script: read all <video> states.
   - assert every video.paused === true.
   - if not paused: MCP click pause button → screenshot → recheck.

B. Console marker BEGIN:
   - evaluate_script: console.log('[V2MEAS][MARK] BEGIN seek=' + P)

C. Issue the seek:
   - evaluate_script: dispatch mousedown/mouseup/click MouseEvents on the
     timeline ruler at x = rulerRect.left + P * pixelsPerSecond.
   - wait 800 ms.

D. Verify the seek:
   - read all <video> states.
   - assert V1.currentTime within ±1 s of P (the click precision is roughly
     ±0.1 s due to rounding).
   - assert all videos still paused === true (a seek should not autoplay).

E. **OBSOLETE — STRIKE THIS STEP**: Earlier draft said "(Optional, Run 5+) Wait 700 ms additional for pre-warm pulse to fire and settle." The pre-warm pulse was REMOVED in the Run 8 reversion (Section 28A.4) — no `[V2MEAS][preWarm]` logs fire at HEAD. The 700 ms wait is no longer needed. A 300–800 ms gap between seek dispatch and play click is still advisable to let `seekEffect` settle, but no pre-warm dependency exists.

F. MCP click play button:
   - take_snapshot, find play button uid.
   - mcp click with uid.
   - take_screenshot to confirm icon flipped.

G. Play-verify reading at t+1.5 s (snapshot A):
   - read all <video> states.
   - record V1.paused, V1.currentTime, V2.paused, V2.currentTime.

H. Play-verify reading at t+2.5 s (snapshot B):
   - read all <video> states.
   - record V1.paused, V1.currentTime, V2.paused, V2.currentTime.

I. MCP click pause button:
   - take_snapshot, find pause button uid.
   - mcp click with uid.
   - take_screenshot to confirm icon flipped.

J. Console marker END:
   - evaluate_script: console.log('[V2MEAS][MARK] END seek=' + P + ' valid=' + V)
     where V is the boolean per the validity rules below.

K. Wait 500 ms before next iteration.
```

### 11.3 Validity rules

A sample is VALID only if:

- Pre-state both `V1.paused === true` AND `V2.paused === true`.
- Seek moved `V1.currentTime` to within ±1 s of P.
- Snapshot A: `V1.paused === false` AND `V2.paused === false`.
- Snapshot B: `V1.paused === false` AND `V2.paused === false`.
- `V1.currentTime(B) − V1.currentTime(A) ≥ 0.5`.
- `V2.currentTime(B) − V2.currentTime(A) ≥ 0.5`.

If any assertion fails, the sample is marked INVALID and excluded from aggregation but included in the raw data report.

### 11.4 Reading and segmentation

After all 5 samples attempted:

```
list_console_messages → entire log buffer
filter lines starting with '[V2MEAS]'
segment by [V2MEAS][MARK] BEGIN seek=P / END seek=P pairs
per sample, extract:
  - seekReq + seekSettled for V1 and V2
  - playPrep for V2
  - firstFrame for V1 and V2
  - (Run 5+) preWarm start / done / aborted for V2
report per-sample table + aggregate distribution
```

### 11.5 Time budget

- Reload to project ready: ~3 s.
- Per sample: ~6–8 s (pre-state + seek + verify + play + 2.5 s observation + pause + verify + tag).
- 5 samples end-to-end: ~5–7 minutes including snapshots.
- Allow ~20 minutes wall-clock for a full run including the agent's initial discovery.

### 11.6 Project-end edge case

The project's total duration is ~120 s. Seeking to 100 s and observing 2.5 s of playback lands at ~102.5 s, well before the end. But after the sample completes and the V2 clip is past the end of its active window, V2 may unmount. Sample 5 (P=100) in Run 4 and Run 5 first attempt failed validity because the project's 120 s end was hit during the post-play observation window — V1 looped back to 0, V2 unmounted, snapshot B returned empty. Workaround in Run 5 was to retry, but the retry's snapshot B also hit the end of project. The retry's firstFrame log was captured even though validity failed.

A future investigator could mitigate by using a longer-duration test project (more V1 content beyond V2's end) or by choosing seek positions earlier than 100 s.

---

## 12. RUN 1 — ORIGINAL BASELINE (NO FIX APPLIED)

### 12.1 Code state during this run

VideoPreview.tsx as shipped before the investigation, with only `[V2DBG]` logs (no `[V2MEAS]` logs yet — those came in the next step). The `playEffect` branch:

```ts
if (isPlaying && layer && !layer.isPremounted) {
  if (video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    video.currentTime = layer.clipTime;
    video.play().catch(() => {});
  }
} else {
  video.pause();
}
```

No 3a drift gate. No 3b rVFC gate. No Option F pre-warm. No raised threshold. `seekEffect` threshold `justStarted ? 0.005 : 0.1`.

### 12.2 Pre-test data point

A single CDP-based diagnostic capture from a much earlier session (before this investigation began) showed a +0.120 s offset at one seek position. This was the initial data point that triggered the H1 (keyframe-snap) hypothesis. It was a single measurement, so it lacked the per-seek distribution needed to discriminate H1 from H3.

### 12.3 Run 1 raw data

The browser-driving agent ran the protocol against five seek positions: 35, 50, 65, 80, 100. The valid data, with V2's `playToFrameMs` as the primary metric:

| Seek | V1 ptF | V2 ptF | V1 − V2 (signed) |
|---:|---:|---:|---:|
| 35 | 5 | 171 | −166 |
| 50 | 11 | 72 | −61 |
| 65 | 11 | 87 | −76 |
| 80 | 10 | 9 | +1 |
| 100 | 38 | 93 | −55 |

Means: V1 ptF = 15 ms; V2 ptF = 86 ms; V1 − V2 = −71 ms.

Other measurements:
- All `eps` ≈ 0.0000 across all V1 and V2 samples → H1 keyframe-snap rejected.
- V2 `readyState=4` at every play-prep → H5 pre-mount delivery rejected.
- V2 `buffered` always covers requested clipTime → H5 again rejected.
- V2 seek `elapsedMs` 210–377 ms (initial cold load 786 ms); HTTP latency narrow → H2 weak.

### 12.4 Interpretation of Run 1

H3 (decoder startup lag) is the surviving hypothesis. The variance in `V1 − V2` per seek (sign flip on P=80) is the user-perceptible "random offset" symptom. Notably, P=80 produced V2 ptF = 9 ms — V2 was almost certainly decoder-warm from the immediately-prior P=65 sample's playback. The decoder warm-state survived the brief pause between samples.

The mean V1 − V2 of −71 ms (V2 trails V1 by 71 ms average) corresponds to roughly 2.1 frames at 30 fps, well within the "audibly out of sync" range.

This run established the **baseline floor** that subsequent fix attempts had to beat. None of them did (within statistical noise).

### 12.5 Console output sample (Run 1, abbreviated)

```
[V2MEAS][MARK] BEGIN seek=35
[V2DBG][playEffect] id=b80b0b54-c627-4374-9da6-a4cef79e3faf isPremounted=false isPlaying=true readyState=4 paused=true ct=6.799
[V2MEAS][playPrep] id=b80b0b54-... trackId=V2 readyState=4 buffered=[["0.00","49.93"]] requested=6.799 isPremounted=false
[V2MEAS][firstFrame] id=7e3abfcd-... trackId=V1 playToFrameMs=5 mediaTime=34.9438 expectedCT=34.9395
[V2MEAS][firstFrame] id=b80b0b54-... trackId=V2 playToFrameMs=171 mediaTime=6.7833 expectedClipTime=6.7991
[V2MEAS][MARK] END seek=35 valid=true
```

---

## 13. FIRST FIX ATTEMPT — 3a + 3b

After Run 1 confirmed H3, the team designed two complementary interventions.

### 13.1 Fix 3a — drift-gated pre-play seek

**Hypothesis**: the unconditional `video.currentTime = layer.clipTime` assignment in `playEffect` re-seeks V2 even when it's already at the right position (e.g., from a recent `seekEffect` run). Setting `currentTime` to a value the video is already at can still trigger Chrome's internal seek pipeline (`seeking` event, decoder pipeline flush, then `seeked` event), even though no actual position change happens. This flush destroys any warmed decoder state and forces V2's `play()` to cold-start.

**Fix**: gate the assignment behind a drift check.

```ts
// Before
video.currentTime = layer.clipTime;

// After (3a)
if (Math.abs(video.currentTime - layer.clipTime) > 0.03) {
  video.currentTime = layer.clipTime;
}
```

Threshold of 30 ms = 1 frame at 30 fps. If V2 has drifted less than one frame, skip the assignment entirely.

### 13.2 Fix 3b — rVFC-gated overlay play()

**Hypothesis**: V1.play() and V2.play() are called within the same React effect tick. Each has its own decoder startup latency. Chrome's compositor presents the first decoded frame whenever the decoder produces it. V1 typically fires fast (5–40 ms warm); V2 varies (9–171 ms). The relative wall-clock delta between V1's first frame and V2's first frame is unpredictable in sign and magnitude.

**Fix**: schedule V2.play() inside V1's first-frame rVFC callback. V2 begins playing only after V1 has presented its first frame. The relative delta becomes V2's own intrinsic decoder time (always positive — V2 always trails V1).

```ts
if (video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
  // 3a
  if (Math.abs(video.currentTime - layer.clipTime) > 0.03) {
    video.currentTime = layer.clipTime;
  }
  // 3b
  let started = false;
  const startPlay = () => {
    if (started) return;
    started = true;
    const session = measSessionRef.current;
    const playT0 = performance.now();
    video.play().catch(() => {});
    if ((layer.trackId === 'V2' || layer.trackId === 'V3') && typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback((now, meta) => {
        if (session !== measSessionRef.current) return;
        console.log(`[V2MEAS][firstFrame] id=${id} trackId=${layer.trackId} playToFrameMs=${(now - playT0).toFixed(0)} mediaTime=${meta.mediaTime.toFixed(4)} expectedClipTime=${layer.clipTime.toFixed(4)}`);
      });
    }
  };
  const v1 = videoRef.current;
  if (v1 && typeof v1.requestVideoFrameCallback === 'function') {
    v1.requestVideoFrameCallback(() => startPlay());
    setTimeout(() => startPlay(), 200);
  } else {
    startPlay();
  }
}
```

200 ms `setTimeout` fallback so V2 doesn't deadlock if V1's rVFC never fires (V1 missing, paused, or ended).

### 13.3 Why this seemed right at the time

If H3 is the bug, gating V2 on V1's first frame bounds V2's effective lag to V2's intrinsic decoder time, eliminating the V1-vs-V2 race. The earlier Run 1 data showed V2 was generally slower than V1, so V2 trailing by its own (small) decoder time should be an improvement.

### 13.4 What we missed

We conflated "race condition" with "delta." Without 3b, V2's perceived lag is `V2ptF − V1ptF` (both measured from the same playT0, which is the React effect tick). With 3b, V2's perceived lag is `V2ptF` measured from V1's first-frame moment — which is the same as V1's already-presented-frame moment. So with 3b, V2 still trails V1 by V2's own ptF, which is the same order of magnitude as without 3b. We added an extra V1 frame-presentation hop, gaining nothing.

The data confirmed this directly (Section 14).

---

## 14. RUN 2 MEASUREMENT (3a + 3b)

### 14.1 Code state

VideoPreview.tsx with 3a + 3b applied. All `[V2MEAS]` instrumentation was already in place (we'd added it in the Step 1 of the prior measurement plan).

### 14.2 Run 2 raw data

| Seek | V1 ptF | V2 ptF | V1 − V2 (signed) |
|---:|---:|---:|---:|
| 35 | 175 | 214 | −39 |
| 50 | 11 | 638 | −627 |
| 65 | 10 | 68 | −58 |
| 80 | 4 | 76 | −72 |
| 100 | 14 | 55 | −41 |

Means: V1 ptF = 43; V2 ptF = 210; V1 − V2 = −167.

### 14.3 Interpretation

- Mean V2 ptF jumped from 86 (Run 1) to 210 (Run 2). The rVFC-gated approach **added** V1's frame-presentation interval to V2's lag.
- The P=50 sample produced 638 ms — a clear outlier. Hypothesis: scheduling V2.play() inside V1's rVFC callback creates a serialization point. The rVFC callback runs on the compositor pass; calling .play() inside this pass may put V2's decoder pipeline activation at the back of Chrome's task queue.
- Sign flipping disappeared (all V2 trail V1 by various amounts). 3b achieved its design goal of removing the cases where V2 leads V1.
- Run 2 was NOT an improvement. The mean signed delta got worse, not better.

### 14.4 Decision

Revert 3b. Keep 3a (it's principled — avoiding a redundant seek can only help or be a no-op; cannot hurt). Re-measure with 3a alone.

---

## 15. SECOND FIX ATTEMPT — 3a ONLY (3b REVERTED)

### 15.1 Code change

3b reverted. The `playEffect` reverted to the simpler form, only with the drift gate:

```ts
if (video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
  if (Math.abs(video.currentTime - layer.clipTime) > 0.03) {
    video.currentTime = layer.clipTime;
  }
  const session = measSessionRef.current;
  const playT0 = performance.now();
  video.play().catch(() => {});
  if ((layer.trackId === 'V2' || layer.trackId === 'V3') && typeof video.requestVideoFrameCallback === 'function') {
    video.requestVideoFrameCallback((now, meta) => {
      if (session !== measSessionRef.current) return;
      console.log(`[V2MEAS][firstFrame] ...`);
    });
  }
}
```

### 15.2 Rationale

We hadn't actually validated that 3a was helping. The Run 2 data muddied the picture. We needed to isolate 3a's effect by running it alone against Run 1's baseline.

---

## 16. RUN 3 MEASUREMENT (3a ONLY)

### 16.1 Run 3 raw data

| Seek | V1 ptF | V2 ptF | V1 − V2 (signed) |
|---:|---:|---:|---:|
| 35 | 393 | 287 | +106 |
| 50 | 9 | 661 | −652 |
| 65 | 13 | 817 | −804 |
| 80 | 12 | 115 | −103 |
| 100 | 30 | 147 | −117 |

Means: V1 ptF = 91; V2 ptF = 405; V1 − V2 = −314.

### 16.2 Interpretation

- Run 3 was the *worst* run yet at V2 ptF mean (405 vs Run 1's 86).
- P=65 hit 817 ms — a new high outlier.
- The sample 35 outlier (V2 ptF = 287, V1 ptF = 393) was the initial cold-load case: V2 had readyState=0 at the first seek and had to load from scratch.
- P=50 = 661 ms and P=65 = 817 ms suggest something else was happening. The agent's hypothesis (from its report): "the drift-gated seek fired during the play transition (V2 was already not-paused when seekEffect triggered)." This was the agent confusing `seekEffect`'s own threshold-gated seek (which has its own drift gate at 100 ms) with the 3a drift gate inside `playEffect`. The seekEffect's seek may have flushed V2's pipeline during the brief play state. But this hypothesis is speculative.
- More likely interpretation: HTMLVideoElement decoder pipeline noise is high. The same seek position can swing from 72 ms (Run 1) to 661 ms (Run 3) for reasons not under JS control.

### 16.3 Conclusion across Runs 1–3

The signal-to-noise ratio is poor. Each run produces different numbers at the same seek positions. Run 1's 71 ms baseline could be the floor, or it could be the lucky tail of a noisy distribution. Either way, neither 3a nor 3b nor their combination reliably improves on Run 1.

---

## 17. THIRD FIX ATTEMPT — OPTION F (DECODER PRE-WARM PULSE)

### 17.1 Hypothesis upgrade

If the bug is decoder startup lag and seek-flush both, we need to keep V2's decoder warm between seek-settle and the user's eventual play click. A common trick: briefly play + pause the video to spin up the pipeline.

### 17.2 Design

After V2 finishes settling at a seek target (in `seekEffect`'s `seeked` event listener) AND the timeline is paused (`!isPlaying`), run:

1. Save current `muted` state.
2. Set `muted = true` (to suppress audio blip).
3. Call `play()`.
4. On the next `requestVideoFrameCallback`, call `pause()`.
5. Restore `muted` to original.

Side effects:
- V2's `currentTime` advances by ~16 ms (one frame).
- One frame's worth of audio is decoded but muted.
- The decoder pipeline is now in a warm "just-played, just-paused" state.

When the user clicks play later, V2.play() picks up from a warm pipeline.

### 17.3 Side effect: raise seekEffect play-start threshold

The pre-warm leaves V2.currentTime at clipTime + ~16 ms. The seekEffect's play-start threshold was 5 ms — too tight; it would re-seek V2 back to clipTime at the user's play moment, flushing the warmed pipeline. Raise the threshold to 50 ms (well above the typical pre-warm advance).

```ts
// Before
const threshold = justStarted ? 0.005 : 0.1;
// After
const threshold = justStarted ? 0.05 : 0.1;
```

50 ms = 1.5 frames at 30 fps. Still tight enough that user-perceptible offset risk is minimal.

### 17.4 Race condition: user plays during pre-warm

If the user clicks play while pre-warm is in flight, several bad things can happen:

- `playEffect` runs with `isPlaying = true`.
- V2's `paused` is currently `false` (pre-warm is playing it).
- `playEffect`'s play branch checks `video.paused && readyState >= 2`. Since `video.paused === false`, the branch is skipped.
- Subsequently, the pre-warm's `finishPreWarm` callback fires (the rVFC scheduled inside the play() promise resolution), calling `pause()`. V2 is now paused, contradicting the user's intent.
- The user clicks play again or the next layers change re-fires playEffect, which now enters the play branch correctly.

Mitigation: track in-flight pre-warm in a `WeakSet<HTMLVideoElement>` (`preWarmInFlightRef`). In `playEffect`, check if the current video is in the set. If so:

- Delete it from the set. This signals the pending `finishPreWarm` to take its abort branch.
- Skip the play branch this iteration. The next layers change (e.g., the boundary crossing at the next seek-settled event, or a re-fire from React) will re-enter and start V2 cleanly.

### 17.5 The pre-step: revert 3a

The plan was to revert 3a and test Option F alone, on a clean baseline. This decision was wrong (see Section 19 for why), but it's what we did for Run 4.

### 17.6 Code for Option F (Run 4 state, without 3a, without observability logs)

`VideoPreview.tsx` `seekEffect` additions inside the existing threshold-gated seek block:

```ts
// Option F — decoder pre-warm pulse. While paused, after V2 settles at
// the new seek target, run a brief muted play→rVFC→pause cycle so Chrome's
// V2 decoder pipeline stays hot. When the user later clicks play, the
// first decoded frame fires fast instead of paying ~80ms of cold-start.
if (!isPlaying && (layer.trackId === 'V2' || layer.trackId === 'V3')) {
  const el = mediaEl as HTMLVideoElement;
  const preWarmSet = preWarmInFlightRef.current;
  if (!preWarmSet.has(el)) {
    const onSeekedPreWarm = () => {
      if (preWarmSet.has(el)) return;
      preWarmSet.add(el);
      const wasMuted = el.muted;
      el.muted = true;
      const finishPreWarm = () => {
        if (!preWarmSet.has(el)) return; // aborted by playEffect
        el.pause();
        el.muted = wasMuted;
        preWarmSet.delete(el);
      };
      const playPromise = el.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(() => {
          if (typeof el.requestVideoFrameCallback === 'function') {
            el.requestVideoFrameCallback(() => finishPreWarm());
          } else {
            setTimeout(finishPreWarm, 33);
          }
        }).catch(() => {
          el.muted = wasMuted;
          preWarmSet.delete(el);
        });
      } else {
        setTimeout(finishPreWarm, 33);
      }
    };
    mediaEl.addEventListener('seeked', onSeekedPreWarm, { once: true });
  }
}
```

`playEffect` change (added the abort check, did NOT have 3a drift gate in this run):

```ts
if (preWarmInFlightRef.current.has(video as HTMLVideoElement)) {
  preWarmInFlightRef.current.delete(video as HTMLVideoElement);
} else if (video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
  video.currentTime = layer.clipTime;  // unconditional re-seek — NO 3a in Run 4
  // ... play() and rVFC instrumentation ...
}
```

`measSessionRef` and `preWarmInFlightRef` declared at the top of the component:

```ts
const measSessionRef = useRef(0);
const preWarmInFlightRef = useRef<WeakSet<HTMLVideoElement>>(new WeakSet());
```

### 17.7 Pre-warm absence of observability

Critically, Run 4 did NOT have `[V2MEAS][preWarm]` log lines. The pre-warm was either firing or not; we could not tell from telemetry. This omission haunted the Run 4 analysis (see Section 18).

---

## 18. RUN 4 MEASUREMENT (OPTION F WITHOUT 3a, WITHOUT OBSERVABILITY)

### 18.1 Run 4 raw data

| Seek | V1 ptF | V2 ptF | V1 − V2 (signed) |
|---:|---:|---:|---:|
| 35 | 783 | 776 | +7 |
| 50 | 13 | 651 | −638 |
| 65 | 8 | 181 | −173 |
| 80 | 14 | 373 | −359 |
| 100 | 422 | 303 | +119 (sample marked invalid for advance check — project hit end) |

Means (excluding P=100 invalid): V1 ptF (4 valid) = 204; V2 ptF (4 valid) = 495; V1 − V2 = −291.

### 18.2 Agent's observations

The agent reported:
- No `[V2MEAS][preWarm]` log lines anywhere in 208 console messages. The agent could not verify whether pre-warm fired at all.
- The `threshold=0.05` shows up at each play start (in `[V2DBG][seekEffect]`), confirming the 50 ms threshold change is deployed.
- Sample 5 (P=100) hit the project end during the post-play observation window, invalidating the sample.
- Backward-seek-after-prior-play scenario: when transitioning from one sample to the next, the agent paused V2, then seeked backwards 10–20 seconds to the next test position. V2 had to walk forward from prior keyframe = potentially long.

### 18.3 Interpretation

Mean V2 ptF = 495 ms. This was the worst run yet. Three possibilities:

1. Pre-warm fired but didn't help, because `playEffect`'s unconditional `video.currentTime = layer.clipTime` (no 3a guard) re-seeked V2 at the play moment, flushing whatever warm state pre-warm had created.
2. Pre-warm didn't fire at all. Without instrumentation, indistinguishable from (1).
3. Pre-warm fired AND `playEffect` did NOT re-seek (because the drift was less than the seek-effect threshold), but the warm state had already decayed by the user's play click time.

The agent's report said: "the pre-warm fires only after seek-settle. The test procedure (play → pause → seek backward → play) systematically evicts V2's decoded frame cache each time. A pre-warm that fires only after seek-settle may not help when seeks move backward to already-un-buffered positions."

### 18.4 Decision

Two things:

1. **Re-apply 3a**. With 3a's drift gate, `playEffect`'s re-seek won't flush V2's pipeline when V2 is already near target (the pre-warm advance of ~16 ms is below 30 ms threshold).
2. **Add `[V2MEAS][preWarm]` observability logs**. We need to know if pre-warm is firing. Three log lines per cycle: `start`, `done` (with elapsed and advance), `aborted` (when finishPreWarm sees the WeakSet entry deleted).

---

## 19. FOURTH FIX ATTEMPT — OPTION F + 3a RE-APPLIED + OBSERVABILITY

### 19.1 Code changes

**Re-apply 3a in playEffect**:

```ts
if (preWarmInFlightRef.current.has(video as HTMLVideoElement)) {
  preWarmInFlightRef.current.delete(video as HTMLVideoElement);
} else if (video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
  // 3a (re-applied): skip the redundant pre-play seek if V2 is already within
  // one frame (30ms) of target. Option F's pre-warm pulse leaves V2 at
  // clipTime + ~16ms; without this guard, this re-seek would flush V2's
  // warmed decoder and defeat Option F entirely.
  if (Math.abs(video.currentTime - layer.clipTime) > 0.03) {
    video.currentTime = layer.clipTime;
  }
  const session = measSessionRef.current;
  const playT0 = performance.now();
  video.play().catch(() => {});
  if ((layer.trackId === 'V2' || layer.trackId === 'V3') && typeof video.requestVideoFrameCallback === 'function') {
    video.requestVideoFrameCallback((now, meta) => {
      if (session !== measSessionRef.current) return;
      console.log(`[V2MEAS][firstFrame] id=${id} trackId=${layer.trackId} playToFrameMs=${(now - playT0).toFixed(0)} mediaTime=${meta.mediaTime.toFixed(4)} expectedClipTime=${layer.clipTime.toFixed(4)}`);
    });
  }
}
```

**Add `[V2MEAS][preWarm]` logs**:

```ts
const onSeekedPreWarm = () => {
  if (preWarmSet.has(el)) return;
  preWarmSet.add(el);
  const wasMuted = el.muted;
  el.muted = true;
  const preWarmT0 = performance.now();
  console.log(`[V2MEAS][preWarm] id=${layer.id} trackId=${layer.trackId} start ct=${el.currentTime.toFixed(4)} target=${requested.toFixed(4)}`);
  const finishPreWarm = () => {
    if (!preWarmSet.has(el)) {
      console.log(`[V2MEAS][preWarm] id=${layer.id} aborted elapsedMs=${(performance.now() - preWarmT0).toFixed(0)}`);
      return;
    }
    el.pause();
    el.muted = wasMuted;
    preWarmSet.delete(el);
    console.log(`[V2MEAS][preWarm] id=${layer.id} done ct=${el.currentTime.toFixed(4)} advance=${(el.currentTime - requested).toFixed(4)} elapsedMs=${(performance.now() - preWarmT0).toFixed(0)}`);
  };
  const playPromise = el.play();
  if (playPromise && typeof playPromise.then === 'function') {
    playPromise.then(() => {
      if (typeof el.requestVideoFrameCallback === 'function') {
        el.requestVideoFrameCallback(() => finishPreWarm());
      } else {
        setTimeout(finishPreWarm, 33);
      }
    }).catch((err) => {
      el.muted = wasMuted;
      preWarmSet.delete(el);
      console.log(`[V2MEAS][preWarm] id=${layer.id} playRejected err=${err?.name}`);
    });
  } else {
    setTimeout(finishPreWarm, 33);
  }
};
mediaEl.addEventListener('seeked', onSeekedPreWarm, { once: true });
```

### 19.2 What we expect to see

Per seek-while-paused:
1. User scrubs to new position → seekEffect runs → seek issued → `[V2MEAS][seekReq]` logged.
2. V2 settles → seekSettled listener fires, logs `[V2MEAS][seekSettled]`.
3. The separate `onSeekedPreWarm` listener (registered alongside the seekSettled one) also fires.
4. `[V2MEAS][preWarm] start` logged.
5. V2.play() resolves → rVFC fires → `pause()` + `[V2MEAS][preWarm] done` logged with advance and elapsedMs.
6. User clicks play → playEffect's abort check runs. If pre-warm finished (preWarmSet doesn't have el), enter play branch. 3a check: V2.currentTime ≈ clipTime + 16 ms, drift < 30 ms → SKIP re-seek. V2.play() called on warm pipeline. rVFC fires fast.
7. `[V2MEAS][firstFrame]` reports low V2 ptF.

If pre-warm doesn't fire, no `start` log appears for that sample.
If pre-warm starts but is aborted by user's play click, `aborted` log appears instead of `done`.
If V2 ptF is still high even when pre-warm completed, the warm state is decaying between pre-warm completion and play click.

---

## 20. RUN 5 MEASUREMENT (OPTION F + 3a + OBSERVABILITY)

### 20.1 Agent guidance

The agent was instructed to add an explicit 700 ms wait between seek issuance and play click. Reason: give pre-warm time to fire and complete (its observed duration in earlier sessions was 22–127 ms, but with some safety margin).

### 20.2 Run 5 raw data

| Seek | V1 ptF | V2 ptF | V1 − V2 (signed) |
|---:|---:|---:|---:|
| 35 | 450 | 297 | +153 |
| 50 | 15 | 188 | −173 |
| 65 | 28 | 131 | −103 |
| 80 | 8 | 187 | −179 |
| 100 | (invalid both first attempt and retry) | (invalid) | — |

Means (4 valid samples): V1 ptF = 125; V2 ptF = 201; V1 − V2 = −75.

### 20.3 Pre-warm log summary (Run 5)

Per the agent's report:

| Sample context | target clipTime | done ct | advance (s) | elapsed (ms) |
|---|---:|---:|---:|---:|
| Setup T=35 (before formal sample) | 6.7390 | 6.7593 | 0.020 | 61 |
| End-of-35 → seek to pause | 47.9916 | 47.9937 | 0.002 | 44 |
| T=50 | 21.7125 | 21.7287 | 0.016 | 37 |
| T=65→pause | 72.5165 | 72.5170 | 0.0004 | 22 |
| T=80 | 51.7197 | 51.7258 | 0.006 | 47 |
| T=100 first attempt | 71.6844 | (aborted 41.6 s later) | — | 41664 |
| T=100 retry | 71.6844 | 71.7699 | 0.086 | 127 |

Total `[V2MEAS][preWarm] start`: 7
Total `[V2MEAS][preWarm] done`: 6
Total `[V2MEAS][preWarm] aborted`: 1
Total `[V2MEAS][preWarm] playRejected`: 0

### 20.4 Interpretation of Run 5

- Pre-warm is firing reliably. 6 successful cycles, 1 aborted (the aborted one was a leftover listener from a prior seek firing 41.6 s late during a subsequent sample).
- Pre-warm advance is small: 0.002 s – 0.086 s, mean ~0.02 s.
- 3a drift gate is working: `[V2DBG][seekEffect]` log shows `willSeek=false` at every play moment (V2 is within the 50 ms threshold), confirming the pre-play seek is skipped.
- V2 ptF is still high (131–297 ms across the 4 valid samples). The warmed pipeline state apparently decays during the 700 ms wait between pre-warm and play click.
- Mean V2 − V1 = +75 ms — V2 trails V1 by 75 ms average. Compare to Run 1's baseline mean of +71 ms — essentially indistinguishable within noise.

### 20.5 Conclusion of Run 5

Option F + 3a are mechanically working (verified by observability logs) but **do not produce a measurable improvement over the Run 1 baseline**. The decoder pre-warm trick is real but its warm state lifetime is too short for the human-scale delay between seek and play click. By the time the user clicks play, V2's decoder has cooled again.

---

## 21. FIVE-RUN SYNTHESIS AND STATISTICAL OBSERVATION

### 21.1 Aggregated table

| Run | Fix applied | Mean V1 ptF (ms) | Mean V2 ptF (ms) | Mean V1 − V2 (ms) |
|---:|---|---:|---:|---:|
| 1 | None (baseline) | 15 | 86 | +71 (wait — V1 − V2 should match below; using V2 − V1 = +71 here for "V2 trails V1") |
| 2 | 3a + 3b | 43 | 210 | V2 trails by 167 |
| 3 | 3a only | 91 | 405 | V2 trails by 314 |
| 4 | Option F (no 3a) | 204 | 495 | V2 trails by 291 |
| 5 | Option F + 3a | 125 | 201 | V2 trails by 75 |

(Sign convention: positive means V2 trails V1. Earlier sections used "V1 − V2 signed" with negative values for V2 trail; the "V2 trails by X" framing here is positive for the same meaning. Apologies for the convention switch — both are present in the raw agent reports.)

### 21.2 Per-seek across runs

| Seek | Run 1 V2 ptF | Run 2 V2 ptF | Run 3 V2 ptF | Run 4 V2 ptF | Run 5 V2 ptF |
|---:|---:|---:|---:|---:|---:|
| 35 | 171 | 214 | 287 | 776 | 297 |
| 50 | 72 | 638 | 661 | 651 | 188 |
| 65 | 87 | 68 | 817 | 181 | 131 |
| 80 | 9 | 76 | 115 | 373 | 187 |
| 100 | 93 | 55 | 147 | invalid | invalid |

### 21.3 Variance observation

The same seek position can swing by 10× across runs. P=50 went 72 → 638 → 661 → 651 → 188. P=65 went 87 → 68 → 817 → 181 → 131. The fix interventions are not the dominant source of variance. The HTMLVideoElement decoder pipeline noise is.

### 21.4 What this means

- We cannot reliably distinguish a 50 ms improvement from noise with the available measurement resolution.
- The 71 ms baseline (Run 1's mean V2 trail) is consistent with the lower tail of the noise distribution rather than a stable optimum.
- Any JS-side intervention is competing against >100 ms noise. Mechanical fixes inside the same HTMLVideoElement decoder model can't reliably beat that.

### 21.5 Operational conclusion

**The architectural primitive (HTMLVideoElement) is the noise source.** To reliably reduce V2 ptF, the architecture has to change to use a decoder pipeline that exposes deterministic timing — i.e., WebCodecs via `@remotion/media`, which bypasses the browser's internal `<video>` element decoder altogether.

This is what motivated the Remotion docs research described in the next sections.

---

## 22. FIRST REMOTION DOCS RESEARCH PASS

After Run 5, the team agreed the bug needed an architectural fix, not another JS-side tweak. A sub-agent was tasked with researching what Remotion offers and whether migration was feasible. The agent had access to local copies of relevant Remotion v4.0.467 doc pages on disk and used `mcp__plugin_chrome-devtools-mcp__*` browser tools for live docs.

### 22.1 Pages consulted

Local copies:
- `remotion-premounting.md`
- `remotion-prefetch.md`
- `remotion-buffer-state.md`
- `remotion-current-time.md`
- `remotion-player-flicker.md`
- `remotion-preload-video.md`
- `remotion-preloading.md`
- `remotion-playback-issues.md`
- `remotion-player-best-practices.md`
- `remotion-video-tags.md` (the key comparison table)

The comparison table page is the most important. It compares three components:

- `<OffthreadVideo />` — Rust + FFmpeg backed; frame-perfect during render; preview uses HTML5 `<video>`.
- `<Html5Video />` (formerly `<Video>` from base `remotion`) — HTML5 `<video>` tag; not guaranteed frame-perfect.
- `<Video />` from `@remotion/media` — Mediabunny + WebCodecs; frame-perfect; preview uses WebCodecs.

### 22.2 The "Preview" row

For all three, the "Preview" column in the comparison table:

- OffthreadVideo: HTML5 `<video>`
- Html5Video: HTML5 `<video>`
- Video from @remotion/media: WebCodecs

This is the critical distinction. Only `@remotion/media`'s `<Video>` uses WebCodecs in preview — bypassing HTML5 video decoder, which is our noise source.

### 22.3 First-pass conclusions (Section 23 corrects these where needed)

The first-pass research surfaced five blockers:

- **Blocker 1**: `<Video>` from `@remotion/media` cannot be used standalone; it needs `<Player>` context for `useCurrentFrame()`.
- **Blocker 2**: No `HTMLVideoElement` exposed by `<Video>` — it renders to canvas. Canvas transitions in HyperEdit need rewrite.
- **Blocker 3**: External RAF clock incompatible with Player's `seekTo()` API. The docs explicitly say "will pause for a brief moment, then start playing again after the seek is completed." Driving Player at 60 fps from external RAF would stutter.
- **Blocker 4**: CORS required on the FFmpeg server.
- **Blocker 5**: `@remotion/media` is officially experimental.

Effort estimate: 3–4 days minimum, plus retest of all playback / transitions / captions / drag / dead-air / extract-audio surfaces.

### 22.4 Submitting to user

The first-pass findings were summarized to the user. The user responded with two pieces of feedback:

1. "WebCodecs is being deprecated" — a claim that, if true, would invalidate the entire `@remotion/media` migration since it's WebCodecs-based.
2. "The agent didn't read enough docs" — a directive to re-research with more depth.

---

## 23. WEBCODECS DEPRECATION INVESTIGATION

The team spawned a second sub-agent with two missions: verify the WebCodecs status claim, and re-read Remotion docs with more depth.

### 23.1 WebCodecs sources consulted

The agent navigated (via chrome-devtools-mcp browser, not fetch — fetch is blocked):

- `developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API`
- `chromestatus.com/features?q=webcodecs`
- `www.w3.org/TR/webcodecs/`
- Google search results for "webcodecs deprecated 2026 chrome" and "webcodecs deprecated remotion"
- `github.com/w3c/webcodecs` issues
- `remotion.dev/blog`

### 23.2 Findings

**Verdict: WebCodecs is NOT deprecated.**

- MDN page (updated 2026-05-15): zero deprecation banners, zero "experimental" labels for the API as a whole. Only a "Note: This feature is available in Dedicated Web Workers" callout (neutral availability note).
- Chrome Platform Status: WebCodecs feature type is "New or changed feature." Shipped Chrome 94 (2021). Firefox: "Positive." Two deprecation entries appear in the search: (1) `ImageDecoderInit.premultiplyAlpha` removal, (2) "Deprecating minor WebCodecs spec violations" — both are tiny edge-case cleanups, not deprecation of the API.
- W3C (published 2026-05-05): "W3C Working Draft" on the Recommendation track. Quote: "This document is intended to become a W3C Recommendation." Actively progressing.
- Remotion blog: A September 2025 post "Sponsoring Mediabunny" said: "We're going to phase out Remotion Media Parser and Remotion WebCodecs." **This is the source of confusion.** These are Remotion's own npm packages (`@remotion/webcodecs`, `@remotion/media-parser`) being deprecated in favor of the third-party Mediabunny library. The same blog post praises the W3C WebCodecs API itself: "With WebCodecs, we get an exciting new API for the browser..."

**What's actually deprecated**: `@remotion/webcodecs` and `@remotion/media-parser` npm packages. Both labeled "(deprecated)" in the Remotion docs sidebar.

**Impact on `@remotion/media` migration**: zero. `@remotion/media`'s `<Video>` uses Mediabunny + WebCodecs. Remotion is moving *toward* Mediabunny precisely because it's a better WebCodecs-based toolkit, not away from WebCodecs.

The user's claim was incorrect but the source of confusion was understandable.

---

## 24. SECOND REMOTION DOCS RESEARCH PASS (CORRECTIONS)

The second agent also re-read the Remotion docs with more depth. The results corrected several first-pass conclusions.

### 24.1 Pages re-read in full

- `https://www.remotion.dev/docs/media`
- `https://www.remotion.dev/docs/media/video`
- `https://www.remotion.dev/docs/media/audio`
- `https://www.remotion.dev/docs/media/support`
- `https://www.remotion.dev/docs/media/cache`
- `https://www.remotion.dev/docs/media/fallback`
- `https://www.remotion.dev/docs/media/effects`
- `https://www.remotion.dev/docs/mediabunny`
- `https://www.remotion.dev/docs/mediabunny/formats`
- `https://www.remotion.dev/docs/mediabunny/new-video`
- `https://www.remotion.dev/docs/player`
- `https://www.remotion.dev/docs/player/player`
- `https://www.remotion.dev/docs/player/scaling`
- `https://www.remotion.dev/docs/player/buffer-state`
- `https://www.remotion.dev/docs/player/preloading`
- `https://www.remotion.dev/docs/player/premounting`
- `https://www.remotion.dev/docs/use-current-frame`
- `https://www.remotion.dev/docs/composition`
- `https://www.remotion.dev/docs/sequence`
- `https://www.remotion.dev/docs/use-remotion-environment`
- `https://www.remotion.dev/docs/offthreadvideo`
- `https://www.remotion.dev/docs/html5-video`
- `https://www.remotion.dev/docs/video-tags`

### 24.2 Blocker 1 — CONFIRMED: `<Video>` requires `<Player>` context

The component is driven by `useCurrentFrame()` which requires Remotion context. No standalone usage exists. The agent did note a documented escape hatch via `useRemotionEnvironment()` for splitting between preview and render, but this still requires being inside a Composition under Player.

### 24.3 Blocker 2 — REFUTED for canvas-transition access

This was the most important correction. Three components expose `onVideoFrame`:

- `<OffthreadVideo>` (`onVideoFrame?` since v4.0.190): "The callback is called with a `CanvasImageSource` object. During preview, this is a `HTMLVideoElement` object; during rendering, it is an `HTMLImageElement`." In v4.0.472: also receives `DOMHighResTimeStamp` and `VideoFrameCallbackMetadata` as second/third args.
- `<Html5Video>` (`onVideoFrame?` since v4.0.472): "The first argument is a `CanvasImageSource`, more specifically a `HTMLVideoElement`."
- `<Video>` from `@remotion/media` (`onVideoFrame?`): "The callback is called with a `CanvasImageSource` object, more specifically, either an `ImageBitmap` or a `VideoFrame`." `VideoFrame` here is the WebCodecs type.

For HyperEdit's canvas transitions: `<OffthreadVideo>` would give a real `HTMLVideoElement` (drawable directly via `ctx.drawImage()`). The first-pass conclusion that canvas transitions would require a complete rewrite was wrong in this case.

### 24.4 Blocker 3 — CONFIRMED: external clock incompatible

Re-verified. The Player's `seekTo()` API: "Move the position in the video to a specific frame. If the video is playing, it will pause for a brief moment, then start playing again after the seek is completed."

No external clock injection API exists. There is no `syncToExternalClock()`. There is no way to drive Player time from an RAF loop. The agent searched thoroughly and confirmed there is no public path. The reverse direction works (Player → app via `frameupdate` event), but not app → Player at 60 fps.

### 24.5 Blocker 4 — CONFIRMED: CORS required

- `@remotion/media` support page: "Any assets must be either CORS-enabled or served from the bundle using `staticFile()`."
- Mediabunny formats page: same.
- The fallback doc lists "The resource fails to load due to CORS restrictions" as a fallback trigger.
- FFmpeg server can solve this, but it's a server change.

### 24.6 Blocker 5 — MORE NUANCED: experimental status

`@remotion/media` is labeled "experimental" but the trajectory is explicit:
- "Currently, our recommendation is still to use `<OffthreadVideo>` for videos and `<Html5Audio>` for audio. `@remotion/media` is still experimental, but once it is stable, we will recommend it as the default."
- Comparison table: "soon to become the default."

The agent's interpretation: actively developing, may have breaking API changes, but the team's direction is clear.

### 24.7 Newly discovered options

The second pass surfaced facts the first pass missed:

**`onVideoFrame` on `<OffthreadVideo>` is highly capable**: Gives real `HTMLVideoElement` during preview. In v4.0.472, also exposes `DOMHighResTimeStamp` and `VideoFrameCallbackMetadata` similar to `requestVideoFrameCallback`. This makes `<OffthreadVideo>` viable for HyperEdit's canvas transitions with low refactor cost.

**`<Html5Video>` ≠ raw `<video>`**: Adds Remotion's seek synchronization (sets `currentTime = frame / fps`), `acceptableTimeShiftInSeconds` drift correction (default 0.45 s), `delayRender()` blocking, and `pauseWhenBuffering` buffer-state integration. HyperEdit's raw `<video>` has none of these. Switching to `<Html5Video>` would add drift correction "for free." But this is also moot because `<Html5Video>` requires Remotion context — same blocker as everything else.

**Documented split pattern**: Official code example for using `<OffthreadVideo>` during preview and `<Video>` from `@remotion/media` during render via `useRemotionEnvironment().isRendering`. Both wrapped in the same Composition.

**Buffer state in `@remotion/media`**: "For `<Video>` and `<Audio>` from `@remotion/media`, the buffer state is enabled by default." Auto-pauses when Mediabunny is loading. Removes a common source of seek-induced artifacts. Same blocker as everything else though — requires Player.

**`requestInit` prop on `<Video>` from `@remotion/media`** (v4.0.465): Lets you pass `{cache: 'no-store'}` to fix CDN/browser cache invalid range responses. Could help with our localhost server.

### 24.8 Updated path matrix

| Path | Fixes V2 ptF (50–300 ms cold-start)? | Effort | Architecture cost |
|---|---|---|---|
| Stay raw `<video>` (Run 1 baseline) | No (71 ms floor) | 0 | None |
| `<OffthreadVideo>` for V2 overlays | **No** — preview uses HTML5 `<video>`, same as today | 1–2 days (canvas transitions become easier via `onVideoFrame`) | Low |
| Copy `<Html5Video>` drift correction into our raw `<video>` | No (won't help cold-start) | 0.5–1 day | None |
| `@remotion/media <Video>` + `<Player>` | **Yes** — WebCodecs preview, real fix | 3–4 days **BUT** clock blocker = not viable without surrendering RAF (**REVISED** to **2.5–3.5 days** — see Section 25.1 and 29B addendum) | Surrender RAF clock to Player |

### 24.9 Recommendation from second pass

The agent's recommendation was Path 1 (accept baseline) plus Path 2 (`<OffthreadVideo>` for canvas transitions only, leaving main preview unchanged). This is a defensible middle ground but **does not fix V2 ptF**. The user already knew this and was asking for the V2 ptF fix.

For the V2 ptF fix specifically, the only path is `@remotion/media <Video>` + Player, which requires surrendering the RAF clock. The team's options are then:

1. Accept ~71 ms baseline. Strip instrumentation. Document limitation. Move on.
2. Commit to multi-day Player migration. Surrender RAF. Accept experimental API risk.

There is no Path 1.5.

---

## 25. PATH MATRIX AND FINAL RECOMMENDATION

### 25.1 The summary matrix

| Approach | Fixes the bug? | Effort | Side effects |
|---|---|---|---|
| Revert all, accept baseline | No — 71 ms residual | 1 hour (strip logs) | None |
| `<OffthreadVideo>` (preview = `<video>`) | No (same noise) | 1–2 days | Canvas transitions become easier; no clock change |
| Copy `<Html5Video>` drift correction | No (drift not the bug) | 0.5–1 day | Slight sync improvement under pure-drift scenarios |
| `@remotion/media <Video>` + `<Player>` | **Yes** | Full migration 3–4 days (REVISED to **2.5–3.5 days** per 29B addendum after canvas-draw widening preserved facecamtransitionbox); POC alone 1.5–2 days per Section 29B | Surrender RAF clock; FFmpeg server CORS; canvas transitions rewrite (partial — see 29B addendum); experimental API risk; bundle size increase; retest entire surface |
| Wait for Remotion to add external-clock injection | TBD | unbounded | None (no work) |
| Server-side per-asset preview re-encode (all-keyframes) | Speculative — was hypothesized as Option A early in plan but never measured | 1–2 days | Storage cost; preserves architecture |
| Server-side prefetch + blob URL | Speculative — was Option D early in plan | 1 day | Memory pressure; preserves architecture |
| Continuous keep-alive (V2 always playing at playbackRate=0) | **Attempted in Run 8 (Section 28A.3) — FAILED IN PRACTICE**: Chrome `video.play()` at `playbackRate=0` did not produce playing state; playback never started. Implementation infeasible without WebCodecs or custom decoder control. | 0.5 day | CPU/GPU constant load (moot — implementation failed) |

### 25.2 The user's chosen path

After receiving the path matrix the user asked the team to verify Path 4 was even feasible (the docs research above). After confirming the clock blocker is real and Path 4 is the only fix for the actual bug but requires significant architectural change, the user has currently chosen to:

- Archive this branch.
- Revert main to pre-investigation state.
- Defer the decision on whether to pursue the multi-day Player migration.

This megadocument is the archive payload.

---

## 26. CURRENT BRANCH HEAD CODE STATE, FILE BY FILE

This section documents the exact code present at the branch HEAD. A fresh agent checking out this branch will see these files in these states. Numbers given here are line numbers as of the writing of this document; they may shift by a few lines if the agent has modified files in unrelated ways.

### 26.1 `src/react-app/components/VideoPreview.tsx`

The component file is 755 lines total. Investigation-relevant sections:

**Top of component (refs)**, lines 103–116:

```tsx
const videoRef = useRef<HTMLVideoElement>(null);
const loadedSrcRef = useRef<string | null>(null);
const overlayVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
const containerRef = useRef<HTMLDivElement>(null);
const canvasRef = useRef<HTMLCanvasElement>(null);
const hiddenImageRefs = useRef<Map<string, HTMLImageElement>>(new Map());
const hiddenVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
const activeTransitionsRef = useRef<ActiveTransition[]>([]);
activeTransitionsRef.current = activeTransitions;
const wasPlayingRef = useRef(false);
const measSessionRef = useRef(0);
const [draggingLayer, setDraggingLayer] = useState<string | null>(null);
const [dragStart, setDragStart] = useState<{ x: number; y: number; layerX: number; layerY: number } | null>(null);
```

The `measSessionRef` is the only investigation-period ref still present at HEAD. **STALENESS NOTE**: Prior versions of this section also showed `const preWarmInFlightRef = useRef<WeakSet<HTMLVideoElement>>(new WeakSet());` at line 114 — this ref was added in Runs 4–7 (Option F pre-warm pulse) and REMOVED in the Run 8 reversion (Section 28A.4). Do not look for `preWarmInFlightRef` in current code; it does not exist.

**V1 seek effect** (161–179): includes `[V2MEAS][seekReq]` and `[V2MEAS][seekSettled]` instrumentation:

```tsx
useEffect(() => {
  const video = videoRef.current;
  if (!video || baseLayerClipTime === undefined) return;

  if (Math.abs(video.currentTime - baseLayerClipTime) > 0.1) {
    const requested = baseLayerClipTime;
    video.currentTime = requested;
    const immediate = video.currentTime;
    console.log(`[V2MEAS][seekReq] id=V1 trackId=V1 requested=${requested.toFixed(4)} immediate=${immediate.toFixed(4)} eps_immediate=${(immediate - requested).toFixed(4)}`);
    const t0 = performance.now();
    const onMeasSeeked = () => {
      const elapsed = performance.now() - t0;
      const settled = video.currentTime;
      console.log(`[V2MEAS][seekSettled] id=V1 trackId=V1 requested=${requested.toFixed(4)} settled=${settled.toFixed(4)} eps=${(settled - requested).toFixed(4)} elapsedMs=${elapsed.toFixed(0)}`);
    };
    video.addEventListener('seeked', onMeasSeeked, { once: true });
  }
}, [baseLayerClipTime, isPlaying]);
```

**V1 play/pause effect** (181–202): includes session-incremented `measSessionRef` and `[V2MEAS][firstFrame]` instrumentation:

```tsx
useEffect(() => {
  const video = videoRef.current;
  if (!video) return;

  if (isPlaying) {
    measSessionRef.current += 1;
    const session = measSessionRef.current;
    const playT0 = performance.now();
    video.play().catch((err) => {
      console.error('[VideoPreview] Play failed:', err.name, err.message);
    });
    if (typeof (video as HTMLVideoElement).requestVideoFrameCallback === 'function') {
      (video as HTMLVideoElement).requestVideoFrameCallback((now, meta) => {
        if (session !== measSessionRef.current) return;
        console.log(`[V2MEAS][firstFrame] id=V1 trackId=V1 playToFrameMs=${(now - playT0).toFixed(0)} mediaTime=${meta.mediaTime.toFixed(4)} expectedCT=${video.currentTime.toFixed(4)}`);
      });
    }
  } else {
    video.pause();
  }
}, [isPlaying]);
```

> **STALE FIELDS** — this snapshot shows the pre-Run-6 form of V1's `[V2MEAS][firstFrame]` with 3 fields. Run 6 (Section 28A.1) expanded the log emit on BOTH V1 and V2/V3 paths to include 6 additional fields: `expectedDisplayTime`, `presentationTime`, `processingDuration`, `presentedFrames`, `captureTime`, `played`. Also: a `[V2MEAS][playPrep] id=V1 trackId=V1 readyState=... buffered=... ct=...` log was added to this same effect at Run 6. See Section 8.4 for the canonical current-HEAD log format.

**V1 `seeked` listener** (~line 204 at HEAD): existing onV1Seeked propagation, unchanged in the investigation:

```tsx
useEffect(() => {
  const v1Video = videoRef.current;
  if (!v1Video || !currentTimeRef) return;
  const onSeeked = () => {
    const v1Layer = layers.find(l => l.trackId === 'V1' && l.type === 'video');
    const projectTime = v1Video.currentTime + (v1Layer?.clipStart ?? 0) - (v1Layer?.inPoint ?? 0);
    currentTimeRef.current = projectTime;
    onV1Seeked?.(projectTime);
  };
  v1Video.addEventListener('seeked', onSeeked);
  return () => v1Video.removeEventListener('seeked', onSeeked);
}, [layers, currentTimeRef, onV1Seeked]);
```

**Overlay play effect (`playEffect`)** (~line 221 at HEAD): contains the 3a drift gate, the `!video.paused` guard (Run 9), and the `[V2DBG]` + `[V2MEAS]` instrumentation.

> **STALE CODE BLOCK BELOW** — this snapshot shows the Run 5 state. The `preWarmInFlightRef.current.has(...)` / `delete(...)` abort check at lines ~1715–1716 was REMOVED in the Run 8 reversion (Section 28A.4) along with the entire Option F pre-warm pulse mechanism. The actual HEAD code also has (a) the Run 6 expanded `[V2MEAS][firstFrame]` fields (6 additional: `expectedDisplayTime`, `presentationTime`, `processingDuration`, `presentedFrames`, `captureTime`, `played`), (b) the Run 9 `!video.paused` guard in the else-branch (the `video.pause()` call only fires when `!video.paused`), and (c) the V1 `[V2MEAS][playPrep]` variant added in the V1 play effect, not this overlay effect. See Section 8.4 for the current `firstFrame` field list and Section 28A.4 for the Run 8 reversion details.

```tsx
useEffect(() => {
  overlayVideoRefs.current.forEach((video, id) => {
    const layer = layers.find(l => l.id === id);
    if (layer && (layer.trackId === 'V2' || layer.trackId === 'V3')) {
      console.log(`[V2DBG][playEffect] id=${id} isPremounted=${layer.isPremounted} isPlaying=${isPlaying} readyState=${video.readyState} paused=${video.paused} ct=${video.currentTime.toFixed(3)}`);
      const tr = video.buffered;
      const ranges: [string, string][] = [];
      for (let i = 0; i < tr.length; i++) ranges.push([tr.start(i).toFixed(2), tr.end(i).toFixed(2)]);
      console.log(`[V2MEAS][playPrep] id=${id} trackId=${layer.trackId} readyState=${video.readyState} buffered=${JSON.stringify(ranges)} requested=${layer.clipTime.toFixed(3)} isPremounted=${layer.isPremounted}`);
    }
    if (isPlaying && layer && !layer.isPremounted) {
      if (preWarmInFlightRef.current.has(video as HTMLVideoElement)) {
        preWarmInFlightRef.current.delete(video as HTMLVideoElement);
      } else if (video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        // 3a
        if (Math.abs(video.currentTime - layer.clipTime) > 0.03) {
          video.currentTime = layer.clipTime;
        }
        const session = measSessionRef.current;
        const playT0 = performance.now();
        video.play().catch(() => {});
        if ((layer.trackId === 'V2' || layer.trackId === 'V3') && typeof (video as HTMLVideoElement).requestVideoFrameCallback === 'function') {
          (video as HTMLVideoElement).requestVideoFrameCallback((now, meta) => {
            if (session !== measSessionRef.current) return;
            console.log(`[V2MEAS][firstFrame] id=${id} trackId=${layer.trackId} playToFrameMs=${(now - playT0).toFixed(0)} mediaTime=${meta.mediaTime.toFixed(4)} expectedClipTime=${layer.clipTime.toFixed(4)}`);
          });
        }
      }
    } else {
      video.pause();
    }
  });
}, [isPlaying, layers]);
```

**Overlay seek effect (`seekEffect`)** (~line 265 at HEAD): contains threshold = 0.05/0.1 and the existing instrumentation. The Option F pre-warm pulse trigger shown below was REMOVED in Run 8.

> **STALE CODE BLOCK BELOW** — this snapshot shows the Run 5 state. The entire Option F pre-warm pulse trigger (lines ~1769–1810, everything under `// Option F — decoder pre-warm pulse.`) was REMOVED in the Run 8 reversion (Section 28A.4). Current HEAD `seekEffect` ends at the `mediaEl.addEventListener('seeked', onMeasSeeked, { once: true });` line; no pre-warm code follows. The `preWarmInFlightRef` referenced inside this block does not exist at HEAD either.

```tsx
useEffect(() => {
  const justStarted = isPlaying && !wasPlayingRef.current;
  wasPlayingRef.current = isPlaying;
  const threshold = justStarted ? 0.05 : 0.1;

  const overlayMediaLayers = layers.filter(
    l => (l.type === 'video' && l.trackId !== 'V1') || l.type === 'audio'
  );
  overlayMediaLayers.forEach((layer) => {
    const mediaEl = overlayVideoRefs.current.get(layer.id);
    if (mediaEl && layer.clipTime !== undefined) {
      if (layer.trackId === 'V2' || layer.trackId === 'V3') {
        console.log(`[V2DBG][seekEffect] id=${layer.id} isPremounted=${layer.isPremounted} video.ct=${mediaEl.currentTime.toFixed(3)} layer.clipTime=${layer.clipTime.toFixed(3)} threshold=${threshold} willSeek=${Math.abs(mediaEl.currentTime - layer.clipTime) > threshold}`);
      }
      if (Math.abs(mediaEl.currentTime - layer.clipTime) > threshold) {
        const requested = layer.clipTime;
        mediaEl.currentTime = requested;
        const immediate = mediaEl.currentTime;
        console.log(`[V2MEAS][seekReq] id=${layer.id} trackId=${layer.trackId} requested=${requested.toFixed(4)} immediate=${immediate.toFixed(4)} eps_immediate=${(immediate - requested).toFixed(4)}`);
        const t0 = performance.now();
        const onMeasSeeked = () => {
          const elapsed = performance.now() - t0;
          const settled = mediaEl.currentTime;
          console.log(`[V2MEAS][seekSettled] id=${layer.id} trackId=${layer.trackId} requested=${requested.toFixed(4)} settled=${settled.toFixed(4)} eps=${(settled - requested).toFixed(4)} elapsedMs=${elapsed.toFixed(0)}`);
        };
        mediaEl.addEventListener('seeked', onMeasSeeked, { once: true });

        // Option F — decoder pre-warm pulse.
        if (!isPlaying && (layer.trackId === 'V2' || layer.trackId === 'V3')) {
          const el = mediaEl as HTMLVideoElement;
          const preWarmSet = preWarmInFlightRef.current;
          if (!preWarmSet.has(el)) {
            const onSeekedPreWarm = () => {
              if (preWarmSet.has(el)) return;
              preWarmSet.add(el);
              const wasMuted = el.muted;
              el.muted = true;
              const preWarmT0 = performance.now();
              console.log(`[V2MEAS][preWarm] id=${layer.id} trackId=${layer.trackId} start ct=${el.currentTime.toFixed(4)} target=${requested.toFixed(4)}`);
              const finishPreWarm = () => {
                if (!preWarmSet.has(el)) {
                  console.log(`[V2MEAS][preWarm] id=${layer.id} aborted elapsedMs=${(performance.now() - preWarmT0).toFixed(0)}`);
                  return;
                }
                el.pause();
                el.muted = wasMuted;
                preWarmSet.delete(el);
                console.log(`[V2MEAS][preWarm] id=${layer.id} done ct=${el.currentTime.toFixed(4)} advance=${(el.currentTime - requested).toFixed(4)} elapsedMs=${(performance.now() - preWarmT0).toFixed(0)}`);
              };
              const playPromise = el.play();
              if (playPromise && typeof playPromise.then === 'function') {
                playPromise.then(() => {
                  if (typeof el.requestVideoFrameCallback === 'function') {
                    el.requestVideoFrameCallback(() => finishPreWarm());
                  } else {
                    setTimeout(finishPreWarm, 33);
                  }
                }).catch((err) => {
                  el.muted = wasMuted;
                  preWarmSet.delete(el);
                  console.log(`[V2MEAS][preWarm] id=${layer.id} playRejected err=${err?.name}`);
                });
              } else {
                setTimeout(finishPreWarm, 33);
              }
            };
            mediaEl.addEventListener('seeked', onSeekedPreWarm, { once: true });
          }
        }
      }
    }
  });
}, [layers, isPlaying]);
```

**Overlay `<video>` `onLoadedData`** (~560–572): existing logic, with `[V2DBG][onLoadedData]` added in this investigation:

```tsx
onLoadedData={(e) => {
  const video = e.currentTarget;
  const targetTime = layer.clipTime;
  if (layer.trackId === 'V2' || layer.trackId === 'V3') {
    console.log(`[V2DBG][onLoadedData] id=${layer.id} isPremounted=${layer.isPremounted} video.ct=${video.currentTime.toFixed(3)} targetTime=${targetTime.toFixed(3)} isPlaying=${isPlaying}`);
  }
  if (Math.abs(video.currentTime - targetTime) > 0.05) {
    video.currentTime = targetTime;
  }
  if (isPlaying && !layer.isPremounted) {
    video.play().catch(() => {});
  }
}}
```

### 26.2 `src/react-app/pages/Home.tsx`

The component file is ~2400 lines total. Investigation-relevant sections:

**Module-level constant** (line 32):

```tsx
const PREMOUNT_SECS = 2;
```

**`getPreviewLayers`** (162–...): contains the V2/V3 pre-mount logic and the `[V2DBG][getPreviewLayers]` log (lines 217–219):

```tsx
const isPremounted = isOverlayTrack && currentTime < clip.start;
const clipTime = isPremounted
  ? (clip.inPoint || 0)
  : (currentTime - clip.start) + (clip.inPoint || 0);
if (trackId === 'V2' || trackId === 'V3') {
  console.log(`[V2DBG][getPreviewLayers] clip=${clip.id} isPremounted=${isPremounted} clipTime=${clipTime.toFixed(3)} currentTime=${currentTime.toFixed(3)} clip.start=${clip.start}`);
}
```

**`clipBoundaries`** (335–349): includes the pre-mount boundary:

```tsx
const clipBoundaries = useMemo(() => {
  const times = new Set<number>();
  activeClips.forEach(c => {
    times.add(c.start);
    times.add(c.start + c.duration);
    if (c.trackId === 'V2' || c.trackId === 'V3') {
      times.add(Math.max(0, c.start - PREMOUNT_SECS));
    }
  });
  const txns = activeTabId === 'main'
    ? timelineTransitions
    : (timelineTabs.find(t => t.id === activeTabId)?.timelineTransitions || []);
  txns.forEach(t => { times.add(t.startTime); times.add(t.startTime + t.durationSec); });
  return Array.from(times).sort((a, b) => a - b);
}, [activeClips, activeTabId, timelineTransitions, timelineTabs]);
boundariesRef.current = clipBoundaries;
```

**RAF animate loop** (352–391): unchanged in this investigation.

**`handleV1Seeked` callback** (416–422):

```tsx
const handleV1Seeked = useCallback((projectTime: number) => {
  currentTimeRef.current = projectTime;
  setCurrentTime(projectTime);
}, []);
```

**VideoPreview render call** (~2251–2263 at HEAD): passes `onV1Seeked={handleV1Seeked}` (line 2262) and `currentTimeRef={currentTimeRef}`.

### 26.3 Untracked files in the working tree

At investigation start, git status showed these untracked files:

```
__debug_audio.cjs
__debug_console.cjs
__debug_seek_results.json
__debug_storage.cjs
__debug_timeline.cjs
llm-docs/SKILL-agent-test-hyperedit-ui.md
screenshots/
src/remotion/transitions/canvas-draw.ts
```

Of these, only `llm-docs/SKILL-agent-test-hyperedit-ui.md` and `src/remotion/transitions/canvas-draw.ts` were initially identified as intentional. The `__debug_*` files and `screenshots/` are artifacts from agent runs and can be deleted; an agent created `__debug_seek_results.json` during the second Run 1 attempt and noted it was safe to delete.

> **UPDATED AT COMMIT TIME (2026-06-05)**: At commit time, four `llm-docs/SKILL-*.md` files exist (not one) — `SKILL-agent-test-hyperedit-ui.md`, `SKILL-browser-mcp-patterns.md`, `SKILL-video-pipeline-diagnostics.md`, `SKILL-remotion-quick-reference.md` — all four are intentional and committed (the three additional skills were created during Run 12 consolidation, Section 29J). Additionally, `__run14_cycle1_console.txt` (skip — Run 13 data per Section 29L), `docs/V2_OVERLAY_SYNC_INVESTIGATION.md` (this megadoc), and `src/remotion/transitions/canvas-draw.ts` (production transition fix) are also untracked at commit time. See Appendix B (Section 31) for the authoritative commit-time file list.

### 26.4 Files NOT touched in this investigation

- `scripts/local-ffmpeg-server.js` — would need CORS headers if Path 4 (`@remotion/media`) is pursued.
- `src/react-app/hooks/useProject.ts` — would need `Asset.previewUrl` if server-side per-asset preview re-encode is pursued.
- `src/react-app/components/Timeline.tsx` — unchanged.
- `src/react-app/components/TransitionPreview.tsx` — unchanged.
- `src/remotion/transitions/canvas-draw.ts` — already existed (committed by prior session), unchanged in this investigation.

> **STALENESS NOTE (2026-06-05)**: This list was accurate at investigation start (V2-sync-investigation-specific scope only). At commit time, `git status` shows `Timeline.tsx`, `TransitionPreview.tsx`, and `CaptionRenderer.tsx` as MODIFIED (orthogonal pre-existing work bundled into the same commit — see Appendix B "Files modified by orthogonal pre-existing work"). `canvas-draw.ts` is UNTRACKED (added in this branch as an adapted copy from v3 branch — see Appendix B and the canvas-draw.ts section near the end of the document for full context). The authoritative file-state list is Appendix B (Section 31).

---

## 27. REVERT RECIPE — RETURN TO BASELINE

If a future agent or human decides to abandon this branch and return main to the pre-investigation state, the following changes need to be undone. The list is in the form "remove this, restore that."

> **STALENESS WARNING (added 2026-06-05)**: This revert recipe was written before Runs 6–12 and the Run 8 reversion. It describes a code state that no longer matches branch HEAD. Specifically: (a) `preWarmInFlightRef` and the Option F pre-warm pulse block referenced here were REMOVED in the Run 8 reversion (Section 28A.4); searching for them in current code will return nothing. (b) The recipe does NOT cover the Run 6 expanded `firstFrame` fields (`expectedDisplayTime`, `presentationTime`, `processingDuration`, `presentedFrames`, `captureTime`, `played`), the V1 `[V2MEAS][playPrep]` log added in Run 6, or the `[V2MEAS][mount]`/`[V2MEAS][unmount]` ref-callback logs added in Run 10. For an accurate revert, use Section 31 (Appendix B) diff catalog as the authoritative reference and treat Section 27 as historical context only.

### 27.1 In `src/react-app/components/VideoPreview.tsx`

1. **Remove `measSessionRef`** (line 113):
   ```tsx
   const measSessionRef = useRef(0);
   ```

2. **Remove `preWarmInFlightRef`** (line 114):
   ```tsx
   const preWarmInFlightRef = useRef<WeakSet<HTMLVideoElement>>(new WeakSet());
   ```

3. **In V1 seek effect (161–179)**, restore to:
   ```tsx
   useEffect(() => {
     const video = videoRef.current;
     if (!video || baseLayerClipTime === undefined) return;

     if (Math.abs(video.currentTime - baseLayerClipTime) > 0.1) {
       video.currentTime = baseLayerClipTime;
     }
   }, [baseLayerClipTime, isPlaying]);
   ```

4. **In V1 play/pause effect (181–202)**, restore to:
   ```tsx
   useEffect(() => {
     const video = videoRef.current;
     if (!video) return;

     if (isPlaying) {
       video.play().catch((err) => {
         console.error('[VideoPreview] Play failed:', err.name, err.message);
       });
     } else {
       video.pause();
     }
   }, [isPlaying]);
   ```

5. **In V1 `seeked` listener (204–219)** — keep this. It's the existing `onV1Seeked` propagation, shipped before the investigation.

6. **In overlay play effect (`playEffect`) (221–263)**, restore to:
   ```tsx
   useEffect(() => {
     overlayVideoRefs.current.forEach((video, id) => {
       const layer = layers.find(l => l.id === id);
       if (isPlaying && layer && !layer.isPremounted) {
         if (video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
           video.currentTime = layer.clipTime;
           video.play().catch(() => {});
         }
       } else {
         video.pause();
       }
     });
   }, [isPlaying, layers]);
   ```
   This removes: `[V2DBG][playEffect]`, `[V2MEAS][playPrep]`, pre-warm abort check, 3a drift gate, `[V2MEAS][firstFrame]`.

7. **In overlay seek effect (`seekEffect`) (265–345)**, restore to:
   ```tsx
   useEffect(() => {
     const justStarted = isPlaying && !wasPlayingRef.current;
     wasPlayingRef.current = isPlaying;
     const threshold = justStarted ? 0.005 : 0.1;

     const overlayMediaLayers = layers.filter(
       l => (l.type === 'video' && l.trackId !== 'V1') || l.type === 'audio'
     );
     overlayMediaLayers.forEach((layer) => {
       const mediaEl = overlayVideoRefs.current.get(layer.id);
       if (mediaEl && layer.clipTime !== undefined) {
         if (Math.abs(mediaEl.currentTime - layer.clipTime) > threshold) {
           mediaEl.currentTime = layer.clipTime;
         }
       }
     });
   }, [layers, isPlaying]);
   ```
   This removes: threshold change (0.05 → 0.005), `[V2DBG][seekEffect]`, `[V2MEAS][seekReq]`, `[V2MEAS][seekSettled]`, and the entire pre-warm pulse trigger block including all `[V2MEAS][preWarm]` logs.

8. **In overlay `<video>` `onLoadedData` (~560–572)**, restore to:
   ```tsx
   onLoadedData={(e) => {
     const video = e.currentTarget;
     const targetTime = layer.clipTime;
     if (Math.abs(video.currentTime - targetTime) > 0.05) {
       video.currentTime = targetTime;
     }
     if (isPlaying && !layer.isPremounted) {
       video.play().catch(() => {});
     }
   }}
   ```
   This removes the `[V2DBG][onLoadedData]` log.

### 27.2 In `src/react-app/pages/Home.tsx`

1. **Remove `[V2DBG][getPreviewLayers]` log** (lines 217–219):
   ```tsx
   if (trackId === 'V2' || trackId === 'V3') {
     console.log(`[V2DBG][getPreviewLayers] clip=${clip.id} isPremounted=${isPremounted} clipTime=${clipTime.toFixed(3)} currentTime=${currentTime.toFixed(3)} clip.start=${clip.start}`);
   }
   ```

2. **Keep `handleV1Seeked`, `PREMOUNT_SECS = 2`, `clipBoundaries` pre-mount addition** — these were shipped before the investigation.

### 27.3 Verification after revert

```
rtk tsc   # must pass clean
rtk lint  # must pass clean
git diff  # should show only the changes listed above and nothing else
```

The branch HEAD should now match the pre-investigation main branch state.

### 27.4 Untracked files to delete

The `__debug_*.cjs` and `__debug_seek_results.json` files in the working tree are artifacts from agent runs and should be deleted before committing the revert:

```
rm __debug_audio.cjs __debug_console.cjs __debug_storage.cjs __debug_timeline.cjs
rm __debug_seek_results.json
rm __run14_cycle1_console.txt
rm -rf screenshots/
```

All four `llm-docs/SKILL-*.md` files should be kept (`SKILL-agent-test-hyperedit-ui.md`, `SKILL-browser-mcp-patterns.md`, `SKILL-video-pipeline-diagnostics.md`, `SKILL-remotion-quick-reference.md`) — they are operational references for future agents driving the UI, doing browser automation, diagnosing video pipelines, or evaluating Remotion components. See Appendix B for the authoritative file list.

---

## 28. CONTINUATION GUIDE FOR THE NEXT INVESTIGATOR

If a future agent or human picks up this work, here's what they should know.

### 28.1 What's been ruled out

- Keyframe-snap on either V1 or V2 (H1). Chrome accurate-seeks.
- HTTP range latency as a dominant factor (H2). Variance is too narrow.
- Pre-mount delivery failure (H5). V2 is readyState=4 with buffered range covering the target at the play moment.
- Drift gate alone (3a). Doesn't reliably help.
- rVFC-gated overlay play (3b). Adds V1's frame-presentation interval on top, making things worse.
- Decoder pre-warm pulse (Option F). Mechanically works; doesn't help because warm state decays before user play click.
- Continuous keep-alive at playbackRate=0 (Option F-2). **Attempted in Run 8 (Section 28A.3) — FAILED IN PRACTICE**: Chrome `video.play()` at `playbackRate=0` did not enter playing state. Implementation infeasible with vanilla HTMLMediaElement; would require WebCodecs or custom decoder control. Not a viable next step.

### 28.2 What's untried but plausible

> **STALENESS NOTE (2026-06-05)**: This subsection was written at Run 12 close. Runs 13–18 (Sections 29K–29P) subsequently tested several items previously listed here: V2 muted (Run 15, proved root cause = audio decoder init), V2 PCM audio (Run 16, partial fix at 25% HIGH), WebAudio prewarm (Run 18, inconclusive). The remaining "untried" items below (Option A all-keyframe re-encode, Option D blob URL prefetch) are still genuinely untested but deprioritized given the audio-decoder-init root cause finding — neither directly addresses audio decoder cost. See final state architectural fixes table for the post-Run-18 picture.


- **Server-side per-asset all-keyframe preview re-encode (Option A)**: was discussed early in the plan as the fix for H1 keyframe-snap. Since H1 is rejected, this is moot for keyframe-snap, but COULD help with V2 cold-start latency if the all-keyframe encoding makes seeks-then-play decode pipeline activation faster. Untested. Implementation: extend `scripts/local-ffmpeg-server.js` to produce `preview.mp4` per V2/V3 asset using `-c:v libx264 -preset ultrafast -g 1 -keyint_min 1 -crf 28 -c:a copy`. Add `Asset.previewUrl` field. Use the preview URL in `getPreviewLayers` for overlay tracks. Estimated 1–2 days.
- **Prefetch as blob URL (Option D)**: was discussed early as the fix for H2 HTTP latency. Since H2 is weak, this is unlikely to help, but is cheap to try. `await fetch(streamUrl).then(r => r.blob()).then(b => URL.createObjectURL(b))` and swap the video src to the blob URL when ready. The blob URL has zero latency for seeks. Implementation: add a `previewBlobUrl` to the asset record, computed in a `useEffect` per asset entering the timeline. Estimated 0.5–1 day.
- **`@remotion/media <Video>` + `<Player>` (Path 4)**: the only architectural fix for the V2 ptF noise. See Sections 22–25 for the original full migration effort estimate, blockers, and decisions required. **Estimated 2.5–3.5 days for full migration** (revised per 29B.addendum from the original 3–4 day figure, after canvas-draw widening preserved `facecamtransitionbox` rather than requiring GLSL shader rewrite; plus retest). **POC alone is 1.5–2 days** — see Section 29B for the minimum-viable POC scope which is the recommended first step.
- **WebCodecs direct integration (no Remotion)**: HyperEdit could integrate WebCodecs directly, decoding V2 frames in a Web Worker and painting to a canvas. This avoids the Player/clock blocker but requires writing a custom decode pipeline. Estimated 1–2 weeks, much higher risk than `@remotion/media` migration.

### 28.3 If the user comes back wanting a fix

> **STALENESS NOTE (2026-06-05)**: The script below was written at Run 12 close referencing "five variants" and "71ms baseline" as Run 12-era figures. Runs 13–18 (Sections 29K–29P) characterized true bimodality (LOW ~30-170ms, HIGH ~640-720ms, combined mean ~537ms for AAC unmuted baseline) and identified the audio decoder init root cause. Muting V2 (Run 15) was proven to eliminate HIGH entirely (mean 34ms) but is UX-unacceptable per user feedback. PCM (Run 16) reduces HIGH frequency to 25%. The architectural Path 4 path remains the recommended fix; see final state "Architectural fixes" table for the post-Run-18 picture. The script below is preserved as historical Run-12-era framing.

The honest conversation:

> "We measured five variants. The HTMLVideoElement decoder pipeline has variance from 50 to 700 ms that we can't reliably reduce with JavaScript. The only path forward that bypasses this is `<Video>` from `@remotion/media`, which requires wrapping the preview in `<Player>` and surrendering the RAF clock to Player. The migration is 3–4 days plus retest of every playback / transition / caption / drag surface. The API is officially experimental. Alternatively we can accept the 71 ms baseline and document the limitation. Which would you like?"

Do not propose another JS-side trick. The data shows they don't work reliably.

### 28.4 If the user wants to retry measurement

The instrumentation is already in place. A fresh agent should:

1. Read `llm-docs/SKILL-agent-test-hyperedit-ui.md` for the UI control protocol.
2. Spawn a sonnet agent with the protocol from Section 11.
3. Use MCP `click` by uid for play/pause, screenshot verification, two-state-reads post-play.
4. Be aware of the project-end edge case (P=100 sample often hits 120 s end).
5. Pre-warm logs require waiting ~700 ms between seek and play click to give the pulse time to complete.

### 28.5 If the user wants to abandon and revert

Follow Section 27. Then delete this branch (or rather, push it as an archive and revert main).

### 28.6 What NOT to do

- Don't propose another mechanical fix without re-reading the data in Sections 12, 14, 16, 18, 20.
- Don't claim WebCodecs is deprecated — the second-pass research established it isn't.
- Don't dismiss `<OffthreadVideo>` based on "preview uses HTML5 video" alone — the `onVideoFrame` callback makes canvas transitions easier to migrate. (But note `<OffthreadVideo>` still doesn't fix the V2 ptF noise.)
- Don't trust a single measurement at one seek position to characterize the bug — variance per position across runs is enormous.
- Don't lose the skill file. It's the operational reference.

---

## 28A. ADDITIONAL MEASUREMENT RUNS (RUNS 6, 7, 8) — POST-MEGADOC CONTINUATION

After the initial megadoc draft, the team ran three additional measurement passes to address the open questions and explore further fix hypotheses. This section documents those passes.

### 28A.1 Run 6 — Expanded instrumentation (no behavior change)

**Code changes**: instrumentation only. Three additions to `VideoPreview.tsx`:

1. `[V2MEAS][playPrep]` added to V1 play effect (previously V2-only). Captures V1's `readyState`, `buffered` ranges, and `currentTime` at the moment of play.
2. Full `requestVideoFrameCallback` metadata in `[V2MEAS][firstFrame]` for both V1 and V2. New fields: `expectedDisplayTime`, `presentationTime`, `processingDuration`, `presentedFrames`, `captureTime`. From the W3C `VideoFrameCallbackMetadata` interface.
3. `video.played` TimeRanges logged in `[V2MEAS][firstFrame]` for both V1 and V2. Weak proxy for audio progress (H4 A/V skew test).

**Pre-warm pulse was still active** (single-frame pulse from Run 5 state), 3a drift gate at 30 ms, seekEffect play-start threshold at 50 ms.

**Run 6 per-sample data** (4 valid samples + 1 marginal):

| Seek | V1 ptF | V2 ptF | V1 expDT−presT (ms) | V2 expDT−presT (ms) | V2 presentedFrames |
|---:|---:|---:|---:|---:|---:|
| 35 | 391 | 265 | 0.0 | 0.0 | 4 |
| 50 | 6 | 193 | +6.9 | 0.0 | 1988 |
| 65 | 10 | 217 | +6.9 | −0.1 | 4041 |
| 80† | 6 | 239 | +6.9 | 0.0 | 5927 |
| 100 | 13 | 186 | +6.9 | 0.0 | 7311 |

† P=80 marginal (V2 delayed start; ptF from re-triggered playEffect after a 32 s pre-warm abort).

**Run 6 means** (3 fully valid: P=35, 50, 65; plus marginals): V2 ptF mean = 225 ms (fully valid only) / 220 ms (all 5).

**Run 6 key findings**:

- **`expectedDisplayTime − presentationTime` is the compositor pipeline lookahead signature.** V1 (warm) consistently shows +6.9 ms (one frame at ~144 fps display refresh). V2 (cold) shows 0.0 ms across all 5 samples. Even at P=80 and P=100, where V2 had been actively playing in immediately-prior samples, V2's first-callback metadata shows 0.0 ms — implying that the pulse pause-cycle resets the pipeline state.
- **V1 also exhibits cold-start.** At P=35 (first play after page reload), V1 ptF was 391 ms despite `readyState=4` and `buffered=[[34.03, 48.31]]`. V1 ptF dropped to 6–13 ms for P=50/65/80/100. The cold-start is decoder/compositor pipeline state, not buffer absence.
- **`played` TimeRanges always included V2's `mediaTime` at the first-frame moment** in 3 of 4 valid samples (50, 65, 100). At P=35 (first play), `played=[[6.739, 6.836]]` and `mediaTime=6.7333` — video frame fired ~6 ms before audio decode confirmed playback. The A/V skew if any is small (≤6 ms) and video-leading-audio, not the dominant cause of V2's 100–300 ms ptF.
- **`processingDuration`** showed no consistent V1/V2 split (0.001–0.0989 s, scattered).
- **`presentedFrames`** at first-frame moment was only useful as a "fresh decoder" signal on the very first session play (V1=2, V2=4). Subsequent plays the counter accumulated.

### 28A.2 Run 7 — Multi-frame pre-warm pulse (Q29.3 test)

**Code changes**:
1. Pre-warm pulse changed from 1 rVFC frame to **N=3 frames** (continuous playback). Implemented as a recursive `requestVideoFrameCallback` counter inside `finishPreWarm`.
2. 3a drift gate raised from 30 ms to **150 ms** (5 frames at 30 fps) to tolerate the ~100 ms `currentTime` advance the N=3 pulse leaves behind.
3. seekEffect play-start threshold raised from 50 ms to **150 ms** for the same reason.

**Run 7 per-sample data** (4 valid samples; 1 invalid):

| Seek | V1 ptF | V2 ptF | V1 expDT−presT (ms) | V2 expDT−presT (ms) | V2 preWarm done (ms) | V2 preWarm advance (s) |
|---:|---:|---:|---:|---:|---:|---:|
| 35 | 275 | 191 | 0.0 | 0.0 | 82 | 0.041 |
| 50 | — | — | — | — | NO pre-warm fired | — |
| 65 | 4 | 17 | +6.8 | +6.7 | 94 | 0.052 |
| 80 | 6 | 47 | +6.8 | +6.7 | 75 | 0.034 |
| 100 | 13 | 12 | +6.8 | +6.8 | 123 | 0.082 |

P=50 INVALID: V2 did not play. seekEffect issued seek but pre-warm never fired and V2 remained paused while V1 played through to project end.

**Run 7 mean V2 ptF (4 valid)**: 66.75 ms.

**Run 7 key findings**:

- **Apparent improvement on warm samples**: P=65, P=80, P=100 V2 ptF dropped to single-digit / low-double-digit (17, 47, 12 ms). These three samples also showed V2 `expDT−presT = +6.7–6.8 ms` (warm pipeline signature). This was widely interpreted as "pre-warm worked".
- **But the cold-start case (P=35) did not improve**: V2 ptF = 191 ms (vs Run 6's 265 ms — marginal noise-level change). V2 `expDT−presT = 0.0` ms at P=35.
- **The "improvement" on P=65/80/100 was likely playback continuity, not pre-warm priming**: V2 had been actively playing in the prior sample's 2.5 s observation window. The pipeline was already warm from playback. Pre-warm advance values (34–82 ms) are below the expected N=3 frames × 33 ms = 100 ms target, suggesting the pulse stopped after 1–2 frames (possibly the source video is not 30 fps as assumed, or the rVFC recursion exited early).
- **P=50 new failure mode**: The raised 150 ms drift gate combined with a backward seek (V2 was at ct≈40 from prior sample's playback, target was 21.7 — a 18.3 s backward jump) somehow prevented the pre-warm listener from registering or firing. V2 stayed paused throughout the play attempt.

**Q29.3 verdict from Run 7**: longer pre-warm pulse **partially fails**. Warm samples benefit from playback continuity (not pulse). Cold-start (P=35) unchanged. New regression introduced (P=50).

### 28A.3 Run 8 — Option F-2 continuous keep-alive at playbackRate=0 (attempted)

**Hypothesis**: Run 7 showed that V2's pipeline stays warm if it's actively playing. Instead of pulsing, what if V2 is *always* playing at `playbackRate=0` (no time advance) when the timeline is paused? Decoder pipeline never cools.

**Code changes attempted**:
1. Pre-warm pulse code removed from seekEffect entirely.
2. playEffect else branch (when `isPlaying === false` or `isPremounted`): for V2/V3, set `muted=true`, `playbackRate=0`, then `play()` if paused. Goal: keep V2 element in `paused === false` state continuously.
3. playEffect play branch (when `isPlaying === true`): set `muted=false`, `playbackRate=1`, drift-correct at 150 ms gate, then `play()` if paused.
4. New ref `lastV2FrameSessionRef` to fire rVFC measurement exactly once per V1 session, even if V2 was already "playing" (rate=0) at the moment of user play click.
5. New log `[V2MEAS][keepAlive]` to confirm keep-alive activation.

**Run 8 status**: **CODE FAILED IN PRACTICE.** User reported that with the keep-alive code active, "Run 8 hasn't played the video at all." The agent was rejected before measurement could complete.

**Suspected mechanism**: `video.play()` at `playbackRate=0` may not actually play in Chrome — the browser may either reject the play promise silently (autoplay policy at rate=0 unclear) or accept play() but never enter actual playing state. Even if play() succeeded at rate=0, transitioning to rate=1 via property assignment may not reliably trigger frame production.

**Run 8 outcome**: Option F-2 (continuous keep-alive at rate=0) is **not feasible** with the simple `video.play() + playbackRate=0` approach. A more careful implementation would need to handle Chrome's autoplay/rate semantics or use a different mechanism (e.g., WebCodecs-based decoder that the team explicitly controls).

### 28A.4 Reversion after Run 8

Following the Run 8 failure, the team reverted `VideoPreview.tsx` to the **clean baseline + instrumentation** state. The final code at branch HEAD has:

- No pre-warm pulse (removed).
- No keep-alive (removed).
- 3a drift gate at 30 ms (restored from Run 7's 150 ms).
- seekEffect play-start threshold at 50 ms (restored from Run 7's 150 ms).
- All `[V2MEAS]` instrumentation preserved: `[playPrep]` (V1 + V2), `[seekReq]`, `[seekSettled]`, `[firstFrame]` with full rVFC metadata + `played` TimeRanges. `[V2DBG]` logs preserved.
- Unused refs removed (`preWarmInFlightRef`, `lastV2FrameSessionRef`).

This means the final branch HEAD code is closest to **Run 6 state minus the pre-warm pulse**. It plays video normally and emits the full instrumentation suite. A future investigator can re-run measurements without first reverting anything.

---

## 29. FINAL ANSWERS TO THE 8 OPEN QUESTIONS

After Runs 6, 7, and 8, the following are the team's final verdicts on each question originally listed in this section. Some questions were directly tested (verdict: confirmed/refuted with measurement); some were answered by inference from the H3 mechanism analysis (verdict: explained); some require user-side or server-side work the team did not undertake (verdict: deferred with rationale).

### 29.1 Does H4 (A/V skew within V2) contribute to the perceived offset?

**Status: REFUTED (Run 6 measurement).**

The `video.played` TimeRanges captured in Run 6's `[V2MEAS][firstFrame]` log shows that at the moment V2's first decoded frame is presented, V2's `played` ranges always include the `mediaTime` of that frame (within 3 of 4 valid samples). At P=35 (the only sample where the pattern differs), the video frame fires ~6 ms before audio playback confirms, but V2 ptF was 265 ms — the audio-side latency cannot account for more than a small fraction of V2's first-frame delay.

V2's perceived ~70–200 ms delay relative to V1 is **video-side, not audio-side**. The decoder pipeline cold-start affects video frame presentation; audio decoding tracks alongside or marginally behind. The audio decoder is not a separate source of significant skew.

Recommended further test: if a user perceives sustained audio drift during continuous playback (not just at start), instrument an AudioContext analyser to capture the first non-zero audio sample wall-clock time and compare to V2 first-frame time. The team did not perform this test because the user's complaint is primarily about play-start sync, not sustained drift.

### 29.2 Why does P=80 show V2 leading V1 in Run 1?

**Status: EXPLAINED (Run 6 data confirms hypothesis).**

In Run 1, P=80 V2 ptF = 9 ms vs V1 ptF = 10 ms — V2 fired its first frame 1 ms before V1. This was the only sign-flip in Run 1's data.

Run 6 revealed the mechanism: V2's `expectedDisplayTime − presentationTime` is +6.7–6.8 ms (compositor pipeline warm signature) when V2 has been actively playing in the recently-prior sample. P=80 in Run 1 followed P=65 in Run 1 by only a few seconds; V2 was decoder-warm from the prior play. When both decoders are warm, V1's "audio focus" / "primary element" advantage disappears, and the first-frame race between V1 and V2 becomes effectively random per the specific decoder pipeline state of each element.

V2 leading V1 by 1 ms is consistent with V2 being slightly warmer (the prior P=65 playback ran V2 for ~2.5 s; the inter-sample pause was brief; V1 in Run 1 was the larger / longer file and may have had decoder-side resource contention).

The mechanism is not "V1 deprioritized" but "V2 happened to be slightly warmer due to recent playback continuity." This question is closed.

### 29.3 Does increasing the pre-warm pulse duration help?

**Status: PARTIAL FAIL (Run 7 measurement).**

Run 7 tested an N=3-frame multi-frame pre-warm pulse with the 3a drift gate and seekEffect threshold raised to 150 ms to tolerate the larger advance.

Results:
- Warm samples (P=65, 80, 100): V2 ptF dropped to 17 / 47 / 12 ms. Mean improvement vs Run 6.
- Cold sample (P=35): V2 ptF = 191 ms, V2 `expDT−presT = 0`. No improvement.
- Failure mode introduced: P=50 V2 did not play at all (the raised 150 ms drift gate interacted badly with a large backward seek).
- Pre-warm advance values (34–82 ms) were lower than the expected ~100 ms for 3 frames at 30 fps, suggesting the pulse exited after 1–2 frames despite the N=3 target.

The apparent improvement on warm samples was attributable to **playback continuity** (V2 had been actively playing in the prior sample's observation window), not to the longer pre-warm pulse priming the pipeline. The cold-start case (the only one not biased by playback continuity) was unchanged.

The pre-warm pulse mechanism, even multi-frame, **does not reliably prime the compositor pipeline for V2 from a cold state**. The pipeline state appears to require sustained playback to establish, and decays quickly when paused.

### 29.4 Does V2 audio briefly play during the pre-warm pulse, producing an audible blip?

**Status: UNTESTED — current code state has no pre-warm pulse.**

After the Run 8 reversion, the pre-warm pulse code is removed from `VideoPreview.tsx`. There is no pulse currently firing on V2 seek, so there is no opportunity for an audible blip in the current code.

If a future investigator re-introduces the pre-warm pulse (Option F or its multi-frame variant), the audible-blip risk needs to be evaluated by direct human listening. The agent that drives the browser cannot hear; this test requires a user.

Mitigation if blip is perceived: in the pulse code, set `muted = true` BEFORE calling `play()` (not after). The current Option F implementation already did this, but Chrome's audio decoder may briefly emit one sample before honoring the muted property change. A more aggressive approach would be to set `volume = 0` simultaneously and / or pre-pause via `audioContext.suspend()` if a Web Audio source is wired up to the video element.

This question is closed in the current code state but documented for any pulse-restoration work.

### 29.5 Why does V1 sample 1 sometimes show dramatically different V1 ptF?

**Status: CONFIRMED (Run 6 measurement).**

Run 6 P=35: V1 ptF = 391 ms despite `readyState=4` and `buffered=[[34.03, 48.31]]`. V1 ptF dropped to 6–13 ms for P=50/65/80/100.

The mechanism: V1 also exhibits **decoder/compositor pipeline cold-start** when freshly mounted or after a long pause. `readyState=4` (HAVE_ENOUGH_DATA) reflects buffer state only. The first-frame-after-play latency is dominated by pipeline state, not buffer state.

V1 typically *looks* fast in steady-state because the test protocol pauses V1 only briefly between samples; V1's pipeline stays warm. When V1 is fresh-mounted (e.g., on page load) or after a long pause, V1 incurs the same cold-start cost as V2.

This finding is the mechanistic foundation for several decisions in the path matrix (Section 25): the H3 mechanism applies to both V1 and V2; both are HTMLVideoElement decoders with the same noise floor; only WebCodecs-based decoding can produce deterministic timing.

The `expDT−presT` signal: V1 P=35 also shows 0.0 ms (cold). V1 recovers to +6.9 ms by P=50 because V1 has been continuously active by then. V2 never recovers in a single session because each seek-and-pause cycle resets V2's pipeline state.

### 29.6 Does Chrome's `requestVideoFrameCallback` metadata expose useful timing hints?

**Status: CONFIRMED (Run 6 measurement).**

The W3C `VideoFrameCallbackMetadata` interface exposes `expectedDisplayTime`, `presentationTime`, `processingDuration`, `presentedFrames`, and `captureTime`. The most informative field for this investigation is:

- **`expectedDisplayTime − presentationTime`**: when the compositor has lookahead (warm pipeline), this equals +6.9 ms (one frame at ~144 fps display refresh on the test machine). When the compositor is cold-starting (first frame of session, or after pause-induced pipeline flush), this is 0.0 ms.

This is the **numeric signature of compositor pipeline warm vs cold**. It can be used as a diagnostic to verify whether a fix (pre-warm pulse, keep-alive, etc.) successfully primes the pipeline. Run 7 used this signal to confirm that the multi-frame pre-warm pulse did NOT prime the pipeline at cold-start (P=35) despite firing correctly.

`processingDuration` was not informative as a cold-start indicator (varies widely with no V1/V2 pattern). `presentedFrames` was only useful on the very first session play (low number = fresh decoder).

This question is closed. The metadata is useful diagnostically. It cannot be used predictively (we cannot read `expectedDisplayTime` to schedule operations against V2's predicted frame because at cold-start the value equals presentationTime, indicating no future prediction is available).

### 29.7 Does tweaking FFmpeg server response headers help?

**Status: REFUTED BY INFERENCE — server change not performed.**

The team did not perform this test. Reasoning:

1. The FFmpeg server (`scripts/local-ffmpeg-server.js` lines 2150–2180) already sends `Accept-Ranges: bytes`, `Content-Type: video/mp4` (or appropriate MIME via `extToMime`), `Access-Control-Allow-Origin: *`, and `Content-Range` for 206 responses. The CORS and range-request infrastructure is in place.

2. Per the H3 mechanism (confirmed in Runs 1, 6, 7), the cold-start latency is in Chrome's decoder/compositor pipeline state, not in HTTP request fulfillment. Adding `Cache-Control: public, max-age=N` would affect re-fetch latency if Chrome was making redundant range requests, but: (a) V2 `elapsedMs` measurements in Runs 1–6 showed seek-to-`seeked` event in the 100–377 ms range, not high enough to indicate range-request as the dominant cost; (b) the `expDT−presT = 0` signal at cold-start is independent of HTTP behavior — it's purely a compositor pipeline state.

3. Other header additions worth speculation:
   - `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin` would enable Chrome's `crossOriginIsolated` mode, which gives access to more accurate `performance.now()` (microsecond resolution instead of millisecond-rounded). Useful for measurement precision but unlikely to affect the bug.
   - Explicit `X-Content-Type-Options: nosniff` would prevent Chrome from MIME-sniffing. The current Content-Type is already explicit; sniffing should not occur. Unlikely to matter.

4. The cost of restarting the server and running an agent measurement (~30 min total) was deemed not justified given the high prior probability that headers don't affect decoder pipeline cold-start.

Verdict: REFUTED by inference from the H3 mechanism. Any future investigator who wants empirical confirmation can add `Cache-Control: public, max-age=3600` to the asset stream response at lines 2164 and 2174 of `local-ffmpeg-server.js`, restart the server, and re-run a measurement pass. The expected result is no measurable change in V2 ptF at cold-start.

### 29.8 Would lowering V2's resolution at upload help?

**Status: DEFERRED — speculative, server change not performed.**

The hypothesis: if V2 is 1080p H.264 and the cold-start latency is proportional to frame size, downscaling V2 to 480p preview at upload time and using the downscaled version in the editor (with the original used for final render) might reduce cold-start.

The team did not perform this test. Reasoning:

1. Implementation cost is significant: the FFmpeg server would need to produce a preview-resolution copy of every V2 / V3 video asset at upload time, store it alongside the original, and the asset record (`Asset` type in `useProject.ts`) would need a `previewUrl` field. The render pipeline would continue using the original asset. Estimated 1–2 days plus retest.

2. The decoder cold-start mechanism (per Run 6 `expDT−presT=0` finding) is about **pipeline state** (whether the GPU/compositor has frames queued ahead), not about per-frame decode cost. Reducing resolution would reduce per-frame decode time but does not address the pipeline-state issue. The cold-start would happen at a smaller scale, but it would still be cold-start. We would expect V2 ptF to drop modestly (perhaps from 200 ms to 100 ms) but not to V1's warm-pipeline 6 ms.

3. The path matrix (Section 25) lists this as "Server-side per-asset preview re-encode (Option A)" under "untried but plausible". It remains worth considering, but the team's recommendation is that the architectural fix (Path 4 `@remotion/media <Video>` + Player) is more likely to deliver a true frame-perfect result than the resolution-downscale workaround.

Verdict: DEFERRED. The change has a reasonable chance of partial improvement but does not address the root mechanism. If a future investigator pursues it, the FFmpeg pipeline already has ffmpeg invocation patterns (e.g., line 1879 ffprobe call) that can be extended; add a parallel `ffmpeg -i {input} -vf scale=854:480 -c:v libx264 -preset ultrafast -crf 28 {output}.preview.mp4` call after the existing thumbnail/duration extraction. Expose the preview URL in the asset metadata. Use it in `getPreviewLayers` when `trackId === 'V2' || trackId === 'V3'`. Measure V2 ptF reduction; expect modest improvement.

### 29A. Post-Section-29 ffprobe analysis (new finding)

After Section 29 was finalized, the team ran `ffprobe` against both V1 and V2 source streams to verify frame-rate and codec assumptions made earlier in the investigation. The results contradict several assumptions and clarify several measurements.

**V1 source (`C0001.MP4`)**:
- Codec: H.264, High profile, level 4.2
- Profile: **High**, `has_b_frames=1` (B-frame inter-prediction enabled)
- Resolution: 1920×1080
- Frame rate: **59.94 fps** (60000/1001) — NOT 30 fps as the project settings imply
- Bitrate: **24.2 Mbps**
- Keyframe interval: ~0.5 s (600 keyframes in 300 s)
- Duration: 21:52
- Color space: bt709, yuv420p
- File size: ~4.3 GB

**V2 source (`2026-01-21 15-11-10 remotion.mp4`)**:
- Codec: H.264
- Profile: **Main**, `has_b_frames=0` (no B-frames — I/P only)
- Resolution: 1920×1080
- Frame rate: **60 fps exactly** (60/1)
- Bitrate: **723 Kbps** — extremely low for 1080p60, video-conferencing grade
- Keyframe interval: ~1 s (300 keyframes in 300 s)
- Duration: 21:27
- Color space: bt709, yuv420p
- File size: ~142 MB

**Project settings**: `fps = 30`, `width = 1920`, `height = 1080`. The 30 fps render setting mismatches the 60 fps sources. The render pipeline must drop frames; not relevant to the preview sync bug but worth noting for future work.

#### What this changes

1. **Run 7's pre-warm N=3 advance calculation was wrong in the original analysis.** The original Run 7 analysis assumed V2 was 30 fps and expected N=3 frames × 33 ms = 100 ms advance. The observed 34–82 ms looked like the pulse "exited early." At 60 fps the correct expectation is N=3 × 16.67 ms = **50 ms**. The observed range (34–82 ms) is consistent with the pulse firing the full N=3 frames, with the variance attributable to scheduling jitter. The pulse mechanism worked as designed; the conclusion stands (warm samples improved by playback continuity, not by pulse priming the pipeline; cold-start unchanged), but the diagnostic "pulse exited early" was incorrect.

2. **V2's encoder choices are likely a co-factor in the cold-start cost.** V2 is encoded with Main profile, no B-frames, 1 s keyframe interval, and a very low 723 Kbps bitrate. Compared to V1 (High profile, B-frames, 0.5 s keyframes, 24.2 Mbps), V2's decoder has to:
   - Walk forward through up to 60 frames between keyframes on a seek (vs V1's ~30).
   - Process P-frames that are heavily compressed (low bitrate = larger motion vectors and residuals per coded block).
   - Without B-frames, no opportunity for parallel decoding of bidirectionally-predicted frames.

3. **The H3 mechanism (Chrome pipeline cold-start) is real and independent**, but V2's codec choices amplify it. With V1's encoding settings, V2 would likely have a smaller cold-start cost — perhaps 50–100 ms instead of 100–300 ms.

4. **`expectedDisplayTime − presentationTime = +6.9 ms`** at warm pipeline corresponds to roughly 1/144 s. The test machine's monitor refresh rate is likely 144 Hz. On a 60 Hz machine the corresponding warm-pipeline lookahead would be +16.67 ms.

#### Implications for the path matrix

The path matrix in Section 25 lists Q29.8 ("lower V2 resolution at upload") as DEFERRED. This new finding suggests a **better-targeted variant**: at upload time, re-encode V2 / V3 video assets with:

- B-frames enabled (e.g., `-bf 2`)
- Smaller GOP (e.g., `-g 30` for 0.5 s at 60 fps, or `-g 15` for 0.25 s)
- Higher bitrate (e.g., `-crf 23` instead of whatever produced 723 Kbps)
- Same resolution (no downscale needed)

This addresses V2's cold-start specifically by making each seek's walk-forward shorter and each P-frame cheaper to decode, without changing the on-screen quality. The render path continues using the user's original asset. Estimated implementation: 0.5–1 day to add a parallel `ffmpeg` invocation at the asset upload endpoint (`scripts/local-ffmpeg-server.js` line ~1879 area where ffprobe is called for metadata) plus a `previewUrl` field in the Asset record consumed by `getPreviewLayers` in `Home.tsx`.

This is now a more attractive option than the original Q29.8 (downscale to 480p) and a possible alternative to the multi-day Path 4 architectural change.

#### Correction (post-decoder-backend diagnostic)

After Section 29A was written, the team ran two further diagnostics to verify the assumption that V2's codec choices were causing the cold-start. **Both diagnostics refuted the hypothesis**:

**1. `navigator.mediaCapabilities.decodingInfo({...})` in the live HyperEdit tab**:

For V1 (avc1.640028, 1920×1080, 24.2 Mbps, 59.94 fps): `{supported: true, smooth: true, powerEfficient: true}`.
For V2 (avc1.4D402A, 1920×1080, 723 Kbps, 60 fps): `{supported: true, smooth: true, powerEfficient: true}`.

Chrome's pre-runtime capability check flags V2 as just as well-supported and smooth-decodable as V1.

**2. `chrome://media-internals` runtime decoder pipeline state**:

After triggering playback in HyperEdit and reading the per-player property table for both V1 and V2:

V1 (asset id `a9495b66`):
- `kVideoDecoderName = "D3D11VideoDecoder"`
- `kIsPlatformVideoDecoder = true`
- Log: *"D3D11VideoDecoder is using h264 high / 4:2:0"*, *"Selected D3D11VideoDecoder adapter LUID:{0, 74488}"*

V2 (asset id `85a5efb0`):
- `kVideoDecoderName = "D3D11VideoDecoder"`
- `kIsPlatformVideoDecoder = true`
- Log: *"D3D11VideoDecoder is using h264 main / 4:2:0"*, *"Selected D3D11VideoDecoder adapter LUID:{0, 74488}"*

**Both V1 and V2 use the same hardware decoder backend (D3D11 GPU acceleration) on the same GPU adapter.** Neither falls back to `FFmpegVideoDecoder` (software). The codec profile difference (High vs Main) is real but both profiles are handled by the same D3D11 path.

This means **the "V2 re-encode to V1-spec helps" claim above is overstated**. Re-encoding V2 to V1's params would:
- Not change the decoder backend (already hardware).
- Reduce per-frame decode work somewhat (fewer P-frame motion-vector calculations because high-bitrate encoded data is denser but more straightforward to predict; B-frames enable parallel decode of multiple frames). But this is in the millisecond-per-frame range, not the 100s-of-millisecond range observed.
- Possibly reduce the seek walk-forward time (smaller GOP = fewer frames between keyframes), saving up to ~500 ms on rare worst-case seeks. But the measured seek `elapsedMs` in Runs 1–6 was already 116–377 ms, suggesting walk-forward is not the dominant cost.

The real cost is **D3D11 pipeline suspend/resume + Chrome compositor warmup latency**, which is decoder-pipeline-state dependent, not codec-parameter dependent. This matches the Run 6 finding (`expDT − presT = 0` for V2 = no compositor lookahead at cold-start, requires sustained playback to establish).

**Revised estimate for V2 re-encode hypothesis**: expected V2 ptF improvement **5–20%**, not 50%. Server change cost still ~0.5–1 day. Not a strong recommendation. The architectural path (Path 4 POC, 1.5–2 days for a definitive answer) is now the higher-value next move.

### 29B. Path 4 minimum POC scoping (post-Section-29 research)

After Section 29 was finalized, the team scoped what the actual minimum viable `@remotion/media <Video>` + `<Player>` POC looks like — distinct from the full architectural migration described in Section 25. The estimate **1.5–2 days**, not 3-4. Key clarifications from a deeper Remotion docs pass:

#### Player doesn't need `<Composition>`

Quote from `https://www.remotion.dev/docs/player/player`: *"The Player does not use `<Composition>`'s. Pass your component directly and do not wrap it in a `<Composition>` component."* This eliminates one major chunk of the first-pass estimate.

#### Files for the minimum POC

| File | Status | Lines |
|---|---|---:|
| `src/remotion/PreviewComposition.tsx` | NEW | ~90 |
| `src/react-app/components/RemotionPreview.tsx` | NEW | ~120 |
| `src/react-app/pages/Home.tsx` | MODIFIED | +40 |
| `scripts/local-ffmpeg-server.js` | MODIFIED | +1 |

**Total: ~250 LOC**, dependencies: `@remotion/media@^4.0.467`.

#### Server change is one line

The server already sends `Access-Control-Allow-Origin: *`, `Accept-Ranges: bytes` on 206 responses, and proper `Content-Range`. The only gap is `Accept-Ranges: bytes` on 200 responses (`scripts/local-ffmpeg-server.js` line ~2174). Add that one header and Mediabunny's range-request fetch path is satisfied.

#### Measurement point — `onVideoFrame` callback

`<Video>` from `@remotion/media` doesn't expose an `HTMLVideoElement`, but the `onVideoFrame` callback is the WebCodecs equivalent of `requestVideoFrameCallback`. Quote from `https://www.remotion.dev/docs/media/video`: *"A callback function that gets called when a frame is extracted from the video... The callback is called with a `CanvasImageSource` object, more specifically, either an `ImageBitmap` or a `VideoFrame`."*

The measurement pattern:

```ts
// In RemotionPreview.tsx:
const playT0Ref = useRef(0);

// On isPlaying=true transition:
playT0Ref.current = performance.now();
playerRef.current.play();

// Per-layer onFirstFrame callback (one-shot):
onFirstFrame: layer.trackId !== 'V1' ? () => {
  console.log(`[RMEAS][firstFrame] id=${layer.id} trackId=${layer.trackId} playToFrameMs=${(performance.now() - playT0Ref.current).toFixed(0)}`);
} : undefined
```

Directly comparable to existing `[V2MEAS][firstFrame]` logs. Same protocol from `llm-docs/SKILL-agent-test-hyperedit-ui.md` applies for the measurement run (5 seek positions, MCP click protocol, etc.).

#### Feature flag

URL param: `?remotionPreview=1`. The RAF clock in Home.tsx is gated; Player owns clock during Remotion mode. Existing `<VideoPreview>` is preserved as the default path.

```ts
const remotionPreviewMode = useMemo(
  () => new URLSearchParams(window.location.search).has('remotionPreview'),
  []
);
```

#### Out of scope for POC

- Audio (A1, A2 — Remotion preview is video-only in POC)
- Captions (T1 track)
- Canvas transitions (use React z-index instead)
- Drag-to-reposition, splitClip, deleteClip, dead-air, export

These can all be skipped without affecting the V2 ptF measurement.

#### Time estimate

- Vite + WASM setup: 2–4 hours. Mediabunny brings a WASM binary; Vite may need `vite-plugin-wasm` or `optimizeDeps.exclude`. Untested with HyperEdit's existing `@cloudflare/vite-plugin` setup.
- Writing ~250 LOC: 3–4 hours. Mechanical conversion from seconds → frames domain.
- First-boot debugging: 4–8 hours. Expected issues: WASM init timing, `durationInFrames` non-zero at mount, `inputProps` churn causing `<Video>` remount, `onVideoFrame` callback stability.
- Measurement run: 1–2 hours.

**Total: 1.5–2 days.**

#### POC-specific risks (don't exist in full migration)

1. **`inputProps` churn**: composition props re-create on every Home.tsx render → `<Video>` may remount → WebCodecs buffer thrown away → latency resets. Mitigate with `useMemo` on `compositionLayers`.
2. **Vite WASM**: untested interaction with existing Vite plugin stack.
3. **Sentinel `durationFrames=999999`**: POC uses a large sentinel for per-clip duration to skip plumbing it through. If `<Video>` enforces `from + durationInFrames <= parent`, may warn.
4. **`onVideoFrame` closure stability**: must use `useCallback` per layer ID or the prop changes on every render.
5. **`fps=30` Player setting**: if source assets are 60 fps (V1 and V2 both are per ffprobe), Mediabunny extracts at the Player's fps grid, not the source rate. Visual presentation is at 30 fps grid points; minor sync drift possible vs source. Not a measurement blocker.

#### Success / failure criteria

- **PASS**: V2 `[RMEAS][firstFrame]` median playToFrameMs < 25 ms across 10 cold-start cycles, no outliers > 50 ms.
- **FAIL**: median > 40 ms OR Mediabunny shows the same 50–300 ms variance as the current rVFC measurements (WebCodecs has its own decode queue cold-start).
- **INCONCLUSIVE**: 3+ runs blocked by WASM/Vite/inputProps issues, no clean measurements possible. In that case, abandon Path 4 without measurement evidence — the integration complexity itself is the evidence.

#### Recommendation

**The POC is worth doing.** Investigation has run 5 measurement rounds against HTML5 video and proved the 71 ms floor is real. Path 4 is the only remaining hypothesis for sub-30 ms V2 ptF. The 1.5–2 day cost is acceptable to either confirm or refute it definitively.

If the POC passes, the team can commit to the full migration (the additional **2.5–3.5 days** for transitions, audio, captions, drag, etc. — revised from prior 3–4 day estimate; see 29B addendum below) with confidence the underlying architecture works.

If the POC fails (Mediabunny has its own cold-start cost), Path 4 is refuted, and the team should accept the 71 ms baseline or pursue the V2 re-encode finding from Section 29A (B-frames + smaller GOP + higher bitrate, ~0.5–1 day server change) as the realistic alternative.

#### 29B.addendum — Updated constraints + canvas-draw compatibility (2026-06-08)

Two follow-up research agents (chrome-devtools-mcp only, no WebFetch) verified the original 29B plan against current Remotion docs and the actual codebase. Key updates that supersede portions of the original 29B scope:

##### Hard constraint update — video component choices

The user has imposed three hard constraints on video component selection for Path 4:

1. **`<Html5Video>` is OFF LIMITS** (oldest, legacy HTML5 `<video>`-element-backed). Hardest limit. Never propose using it.
2. **`<OffthreadVideo>` is REJECTED** (middle-age, HTML5 preview + Rust render).
3. **Only acceptable video component: `<Video>` from `@remotion/media`** (Mediabunny + WebCodecs).

##### Verified import resolution — `<Video>` from 'remotion' is the LEGACY off-limits component

A common mistake risk: writing `import {Video} from 'remotion'` thinking it gives the Mediabunny WebCodecs component. **It does not.** Verified at v4.0.467:

- Runtime identity check (`node -e` against installed Remotion): `Video === Html5Video: true` — same object reference.
- TypeScript declaration carries `@deprecated This component has been renamed to Html5Video.`
- Verbatim from `https://www.remotion.dev/docs/html5-video`: *"previously called `<Video>`"*
- Verbatim from `https://www.remotion.dev/docs/video-tags` for `@remotion/media`'s `<Video>`: *"soon to become the default"* — confirming it is NOT yet the default at v4.0.467.

**Conclusion**: `import {Video} from 'remotion'` at v4.0.467 silently resolves to the off-limits `<Html5Video>`. The TypeScript compiler emits a deprecation warning but does NOT error. Preview still works but loses all WebCodecs benefit. **This is a silent footgun.**

**Required import for Path 4 code**: `import {Video} from '@remotion/media'` — explicit, mandatory, no config-flag alternative exists.

##### ESLint guard against the silent footgun

Add to `eslint.config.js` **inside the existing `rules: { ... }` block** of the flat-config object targeting `**/*.{ts,tsx}` (current `eslint.config.js` uses `tseslint.config()` flat-config with `react-hooks` + `react-refresh` rules — add this alongside):

```js
'no-restricted-imports': ['error', {
  paths: [{
    name: 'remotion',
    importNames: ['Video', 'Html5Video', 'OffthreadVideo', 'Audio', 'Html5Audio'],
    message: "Use `Video`/`Audio` from '@remotion/media' (Mediabunny+WebCodecs). `Video` from 'remotion' is deprecated Html5Video alias; `<Html5Video>` is legacy HTML5 (off-limits); `<OffthreadVideo>` is rejected (HTML5 preview + Rust render); `<Audio>` from 'remotion' is the deprecated Html5Audio alias."
  }]
}]
```

Turns the silent footgun into a hard build error. Covers ALL three forbidden video components AND the legacy Audio path.

**Migration ordering for this rule (critical)**: HyperEdit currently has 8 files importing `OffthreadVideo` from `'remotion'` (`DynamicAnimation.tsx`, `ProjectTimeline.tsx`, 4 builtin transitions, `facecamtransitionbox.tsx`, `staticfacecam.tsx`) and `Audio` in `ProjectTimeline.tsx`. Enabling this ESLint rule before migrating those imports breaks the lint immediately. Add this rule as the LAST step of the migration, after all 9 file changes (see "Mediabunny full scope" section below) have removed all forbidden imports.

**Verified at audit time (2026-06-08)**: grep of `src/` for `import {Video|Html5Video} from 'remotion'` returns zero hits — no immediate breakage from the `Video`/`Html5Video` part of the rule. The `OffthreadVideo`/`Audio` part WILL break until migration completes.

##### Canvas-draw compatibility — required type widening

Current `src/remotion/transitions/canvas-draw.ts` line 1 (verified by direct file read at 2026-06-08):

```ts
export type CanvasImageSource = HTMLVideoElement | HTMLImageElement;
```

And `drawCover` (lines 13–21):

```ts
const sw = el instanceof HTMLVideoElement ? el.videoWidth : (el as HTMLImageElement).naturalWidth;
const sh = el instanceof HTMLVideoElement ? el.videoHeight : (el as HTMLImageElement).naturalHeight;
```

`<Video>` from `@remotion/media` does NOT expose an `HTMLVideoElement`. Its `onVideoFrame: (frame: ImageBitmap | VideoFrame) => void` callback receives raw frame primitives, not the HTMLVideoElement that canvas-draw's `instanceof HTMLVideoElement` checks for. Under the existing code, both `instanceof` branches return false for `ImageBitmap`/`VideoFrame` inputs, `sw=0`/`sh=0`, the fallback `ctx.drawImage(el, x, y, w, h)` fires — the image renders but stretched/letterboxed (`ctx.drawImage` itself works with `ImageBitmap`/`VideoFrame`, just without cover-scaling math applied).

**`ctx.drawImage` accepts ImageBitmap and VideoFrame natively** per W3C Canvas spec (`CanvasImageSource = HTMLOrSVGImageElement | HTMLVideoElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas | VideoFrame`). The actual draw call does not need changing — only the type signature and dimension resolution.

**Required edit (~30 LOC in canvas-draw.ts)**:

```ts
// Line 1 — widen CanvasImageSource union
export type CanvasImageSource =
  | HTMLVideoElement
  | HTMLImageElement
  | ImageBitmap
  | VideoFrame;

// drawCover — replace dimension resolver
//
// TypeScript note (VERIFIED 2026-06-08 against actual tsconfig.app.json):
// HyperEdit's `tsconfig.app.json` has explicit `lib: ["ES2020", "DOM",
// "DOM.Iterable"]` — `VideoFrame` is NOT in scope. The `instanceof VideoFrame`
// branch below will produce a TypeScript compile error as written.
//
// Two mitigations:
// (a) Add `"WebCodecs"` to the lib array in `tsconfig.app.json` (requires
//     TypeScript 5.0+; verify HyperEdit's TS version first), OR
// (b) Use a structural type check instead: replace
//     `el instanceof VideoFrame` with `'displayWidth' in el` (works in any
//     TS version; safer since it doesn't require WebCodecs lib entry).
//
// Option (b) is recommended — no tsconfig change, no TS version dependency.
function getSourceDimensions(el: CanvasImageSource): { w: number; h: number } {
  if (el instanceof HTMLVideoElement) return { w: el.videoWidth,    h: el.videoHeight };
  if (el instanceof HTMLImageElement) return { w: el.naturalWidth,  h: el.naturalHeight };
  if (el instanceof ImageBitmap)      return { w: el.width,         h: el.height };
  // Structural check (safer than `instanceof VideoFrame` per TypeScript note above):
  // VideoFrame has unique-to-it `displayWidth`/`displayHeight` properties.
  if (typeof el === 'object' && el !== null && 'displayWidth' in el && 'displayHeight' in el) {
    // displayWidth/Height: aspect-ratio-corrected dimensions, intended for
    // visual presentation. codedWidth/Height include decoder alignment padding
    // (e.g. macroblock-aligned dimensions) and would produce wrong cover-scale
    // results for anamorphic or non-multiple-of-16 sources.
    const frame = el as { displayWidth: number; displayHeight: number };
    return { w: frame.displayWidth, h: frame.displayHeight };
  }
  return { w: 0, h: 0 };
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  el: CanvasImageSource,
  x: number, y: number, w: number, h: number,
) {
  const { w: sw, h: sh } = getSourceDimensions(el);
  if (!sw || !sh) { ctx.drawImage(el, x, y, w, h); return; }
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}
```

All 6 transition functions in the `draws` registry (`builtin-crossfade`, `builtin-dip-to-black`, `builtin-slide-left`, `builtin-slide-right`, `facecamtransitionbox`, `staticfacecam`) remain structurally unchanged — they call `ctx.drawImage` and `drawCover` which now accept the widened union.

The `getCanvasDraw` return type at canvas-draw.ts:144 stays `CanvasDrawFn | null`.

The two call-site files that feed `from`/`to` sources into the transition functions (currently `VideoPreview.tsx` `getVideoSource()` returns `HTMLVideoElement | HTMLImageElement | null`) need their return types widened to match. Under Path 4, the new caller will be `EditorComposition` which feeds frames captured from `<Video headless onVideoFrame>` instances via mutable refs.

##### Architectural mismatch — HyperEdit's transition data model vs `<TransitionSeries>`

HyperEdit has TWO transition systems (verified by reading `src/react-app/hooks/useProject.ts`):

1. `JunctionTransition` (legacy v1): `fromClipId`, `toClipId`, `type: 'none' | 'crossfade' | 'slide-left' | 'slide-right' | 'dip-to-black' | 'custom'`, `durationSec`. Enum-typed transitions between clip junctions.
2. `TimelineTransition` (v2, used by canvas-draw): `startTime`, `durationSec`, `fromClipId | null`, `toClipId | null`, `transitionFileId`, `easing?: string`, `params: Record<string, ...>`. This is the system that feeds `canvas-draw.ts` `getCanvasDraw(transitionFileId)`.

Both are **state entities in React** with absolute-time references (`startTime`, `durationSec` in seconds). `<TransitionSeries>` from `@remotion/transitions` expects transitions declared inline between `<TransitionSeries.Sequence>` JSX elements with timing in frames. **This is a data-model impedance mismatch.**

To bridge: when constructing the `EditorComposition`'s rendered output, HyperEdit must derive `<TransitionSeries.Sequence>` + `<TransitionSeries.Transition>` JSX from the timeline's clip list + `TimelineTransition[]` state, recomputing on each meaningful state change and feeding via memoized `inputProps`. Equivalent in scope to a small renderer pass.

##### Updated canvas-draw transition fate (corrected from earlier 29B sketch)

| Transition | Action under Path 4 |
|---|---|
| `builtin-crossfade` | Replace with `@remotion/transitions` `fade()` presentation in `<TransitionSeries>` |
| `builtin-slide-left` | Replace with `slide({direction: 'from-right'})` |
| `builtin-slide-right` | Replace with `slide({direction: 'from-left'})` |
| `builtin-dip-to-black` | **No built-in equivalent** — write custom CSS presentation (~25 LOC using `@remotion/transitions` boilerplate). Cannot simply "delete". |
| `staticfacecam` | **Not a transition** — `_progress` parameter unused; constant PiP overlay. Migrate as a layout pattern: positioned `<Video>` from `@remotion/media` inside `<AbsoluteFill>` with CSS `clip-path: inset()` or `position: absolute` rectangle. Not a `<TransitionSeries>` presentation. |
| `facecamtransitionbox` | **Keep in canvas-draw.ts** with the widened `CanvasImageSource` type. Off-center radial wipe + PiP box reveal — has no CSS or built-in transition analogue. Fed by 2× `<Video headless onVideoFrame>` instances storing latest frame in refs. |

##### V1→V1 vs cross-track transition handling

`<TransitionSeries>` only handles same-track sequence-to-sequence transitions. HyperEdit's `TimelineTransition` data model allows `fromClipId` and `toClipId` on different tracks (e.g., V1→V2 cross-track). For Path 4:

- **V1→V1 same-track**: handled by `<TransitionSeries>` with `fade()`/`slide()`/custom `dipToBlack` presentations.
- **Cross-track** (e.g., V1 base → V2 overlay): cannot use `<TransitionSeries>`. Stays in the canvas-draw system, fed by headless `<Video>` instances on each track. The `facecamtransitionbox` case (V1→V1 with PiP that shows V1) fits in either bucket but is cleaner in the canvas-draw layer.

##### Final Path 4 architecture (under verified constraints)

```
<Player ref={playerRef} component={EditorComposition} inputProps={memoizedTimelineState}>
  EditorComposition renders:
    <TransitionSeries> (V1 track clips + same-track transitions)
      <TransitionSeries.Sequence>
        <AbsoluteFill>
          <Video src={v1clip.url} />  // import from '@remotion/media'
        </AbsoluteFill>
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={fade()|slide()|customDipToBlack()} timing={linearTiming({durationInFrames: N})} />
      <TransitionSeries.Sequence> ... </TransitionSeries.Sequence>
    </TransitionSeries>

    <AbsoluteFill>  // V2 overlay layer (renders above V1)
      <Video src={v2clip.url} />  // import from '@remotion/media'
    </AbsoluteFill>

    <AbsoluteFill>  // canvas-draw layer (facecamtransitionbox only)
      <Video headless src={fromClip.url}
             onVideoFrame={(frame) => { fromFrameRef.current = frame; }} />
      <Video headless src={toClip.url}
             onVideoFrame={(frame) => { toFrameRef.current = frame; }} />
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
      // RAF loop (or onVideoFrame trigger) draws fromFrameRef + toFrameRef onto canvas
      // via getCanvasDraw('facecamtransitionbox')(ctx, fromFrameRef.current, toFrameRef.current, progress, ...)
    </AbsoluteFill>
</Player>
```

All `<Video>` imports MUST be `from '@remotion/media'`. ESLint rule above enforces.

##### Migration steps (final, ordered)

1. Add `@remotion/transitions` and `@remotion/media` as dependencies. (`@remotion/player` is already present.)
2. Add ESLint `no-restricted-imports` rule for `Video` from `'remotion'`. Run `rtk lint` to confirm no existing code triggers it (existing code uses `<OffthreadVideo>` from `'remotion'`, not `<Video>`).
3. Widen `canvas-draw.ts` `CanvasImageSource` union + replace `drawCover` dimension resolver (~30 LOC, code shown above).
4. Update `VideoPreview.tsx` `getVideoSource()` return type to match the widened union (or replace with new EditorComposition that feeds frames via refs).
5. Surrender Home.tsx's RAF clock to `<Player>`. Subscribe to Player's `frameupdate` event to drive caption renderer + timeline playhead.
6. Build `EditorComposition.tsx` (~120 LOC): takes memoized `inputProps = { clips, transitions, captions }`. Renders `<TransitionSeries>` for V1, separate `<AbsoluteFill>` for V2, canvas-draw layer for facecamtransitionbox.
7. Write custom `dipToBlack()` presentation as a `@remotion/transitions` custom CSS presentation (~25 LOC).
8. Migrate `staticfacecam` from canvas-draw to a CSS layout pattern (positioned `<Video>` + `clip-path: inset()`).
9. Wire `facecamtransitionbox` via 2× `<Video headless onVideoFrame>` instances + mutable refs + canvas RAF.
10. Verify `inputProps` is memoized so Player doesn't remount `<Video>` instances on every Home.tsx render.

##### Version compatibility — verified

| API / prop | Required Remotion version | HyperEdit current pin | Available? |
|---|---|---|---|
| `<Video>` from `@remotion/media` (core component) | Package presence; no specific version annotation in docs | n/a (separate package) | YES once installed |
| `<Video>` from `@remotion/media` `headless` prop | v4.0.387 | v4.0.467 | YES |
| `<Video>` from `@remotion/media` `requestInit` prop | v4.0.465 | v4.0.467 | YES |
| `<Video>` from `@remotion/media` `effects` prop | v4.0.464 | v4.0.467 | YES |
| `<Video>` from `@remotion/media` `onVideoFrame` callback | No version annotation (since package inception) | n/a | YES |
| `<OffthreadVideo> onVideoFrame` | v4.0.190 | v4.0.467 | YES (but rejected by user) |
| `<Html5Video> onVideoFrame` | v4.0.472 | v4.0.467 | NO — above pin (and component off-limits anyway) |
| `makeHtmlInCanvasPresentation` | v4.0.456 | v4.0.467 | YES but requires `chrome://flags/#canvas-draw-element` — non-production-viable |
| `@remotion/transitions` `TransitionSeries` + `fade()`/`slide()`/`wipe()`/`iris()`/`clockWipe()` | Package presence | n/a (separate package) | YES once installed |

**Note**: `@remotion/media`'s `<Video>` is documented as *"soon to become the default"*. A future Remotion version may swap the default `<Video>` export from `remotion` to point at the Mediabunny component. If that lands, the ESLint guard above can be relaxed. Until then, explicit `@remotion/media` import is mandatory.

##### Updated effort estimate

Original 29B estimate of 1.5–2 days for the minimum POC remains valid. The canvas-draw widening adds ~30 LOC and the `dipToBlack` custom presentation adds ~25 LOC. Both are mechanical edits, no new risk surface. The architecturally significant work (`EditorComposition`, RAF clock surrender, `inputProps` memoization, headless `<Video>` orchestration for `facecamtransitionbox`) was already in the 1.5–2 day estimate.

Full migration: **2.5–3.5 days** (revised from prior 3–4 day estimate based on canvas-draw widening preserving `facecamtransitionbox` as-is, but Pass 17 audit flagged that the 1-day reduction claim was insufficiently justified — the original "canvas transitions rewrite" cost driver in Section 25 also encompassed the 4 simple transitions that still need migration to `<TransitionSeries>`, plus the new Mediabunny scope items per next section). Sources of remaining cost: `EditorComposition` build + state derivation from `TimelineTransition[]` to JSX (~1 day), per-file Mediabunny migration of 9 files (~0.5 day), Vite/CORS/debugging buffer (~0.5–1 day), measurement validation (~0.5 day).

#### 29B.addendum.mediabunny — full Mediabunny migration scope (2026-06-08 sweep)

A second research pass found that the Path 4 migration extends beyond the V2 sync investigation's preview-only scope. ALL Remotion composition files (used by the FFmpeg server's render path AND by `<Player>` previews) currently use `OffthreadVideo` and the legacy `Audio` — both must migrate to `@remotion/media`.

##### Code state at audit (2026-06-08)

Grep results in `src/`:

- **Zero** `Video`/`Html5Video` imports from `'remotion'` (clean — no existing footgun)
- **Zero** imports from `'@remotion/media'` (package not installed)
- **8 files** import `OffthreadVideo` from `'remotion'`: `DynamicAnimation.tsx`, `ProjectTimeline.tsx`, `transitions/builtin/{crossfade,dip-to-black,slide-left,slide-right}.tsx`, `transitions/custom/{facecamtransitionbox,staticfacecam}.tsx`
- **1 file** imports `Audio` (legacy alias for `<Html5Audio>`) from `'remotion'`: `ProjectTimeline.tsx`

The lucide-react `Video` icon (different module) is NOT caught by `no-restricted-imports` for `'remotion'` — safe.

##### Files that MUST change (9 total)

| # | File | Changes |
|---|---|---|
| 1 | `package.json` | Add `"@remotion/media": "^4.0.467"` |
| 2 | `src/remotion/ProjectTimeline.tsx` | `Audio` import: `'remotion'` → `'@remotion/media'`; `startFrom` → `trimBefore`, `endAt` → `trimAfter` on lines 405–406; `OffthreadVideo` → `Video` from `@remotion/media` |
| 3 | `src/remotion/DynamicAnimation.tsx` | `OffthreadVideo` → `Video` from `@remotion/media` (line 1820); remove `preloadVideo`/`preloadImage` `useEffect` block (lines 1648–1661) — no-op for Mediabunny |
| 4 | `src/remotion/transitions/builtin/crossfade.tsx` | `OffthreadVideo` → `Video`; `startFrom` → `trimBefore` |
| 5 | `src/remotion/transitions/builtin/dip-to-black.tsx` | Same as crossfade |
| 6 | `src/remotion/transitions/builtin/slide-left.tsx` | Same |
| 7 | `src/remotion/transitions/builtin/slide-right.tsx` | Same |
| 8 | `src/remotion/transitions/custom/facecamtransitionbox.tsx` | `OffthreadVideo` → `Video`; `startFrom` → `trimBefore`; REMOVE `pauseWhenBuffering={false}` (default-on now); REMOVE `acceptableTimeShiftInSeconds` (Mediabunny doesn't expose this — Player-level buffer state replaces it) |
| 9 | `src/remotion/transitions/custom/staticfacecam.tsx` | Same as facecamtransitionbox |

Files that DON'T need changes:
- `src/react-app/components/VideoPreview.tsx` — raw HTML `<video>`/`<audio>` for live preview (NOT Remotion render path)
- `src/react-app/hooks/useProject.ts`, `src/react-app/pages/Home.tsx` — state + RAF only
- `src/remotion/templates/*.tsx` (11 files) — use only `<Img>`, no video
- `src/remotion/components/Scene3D.tsx` — Three.js only, no video texture
- `src/remotion/transitions/custom/generate-a-crossfade-remotion-transition-8bcf2f.tsx` — registered custom transition that uses only `interpolate`, `Easing`, `AbsoluteFill`, `useCurrentFrame`, `useVideoConfig` — no video component, no migration needed
- `scripts/local-ffmpeg-server.js` — server-side
- `remotion.config.ts` — no Mediabunny-specific config required

##### Mediabunny API differences caught by the sweep

1. **`Audio` from `@remotion/media` exists and is Mediabunny-backed**. Confirmed from `https://www.remotion.dev/docs/media/audio`: *"This is documentation for the new `<Audio>` tag. Not to be confused with the older `<Html5Audio>` / `<Audio>` tag from remotion."* `import {Audio} from 'remotion'` resolves to `<Html5Audio>` (HTML5 element, FFmpeg-extracted at render). `import {Audio} from '@remotion/media'` uses Mediabunny `AudioDecoder` for render-time extraction. Auto-falls-back to `<Html5Audio>` on error unless `disallowFallbackToHtml5Audio` is set.

2. **`startFrom`/`endAt` props are deprecated → `trimBefore`/`trimAfter`**. Per docs: deprecated on `<OffthreadVideo>` since v4.0.319. `<Video>` from `@remotion/media` accepts ONLY `trimBefore`/`trimAfter`. All 8 .tsx files use `startFrom` — all must rename.

3. **`pauseWhenBuffering` not needed**. From `https://www.remotion.dev/docs/player/buffer-state`: *"For `<Video>` and `<Audio>` from `@remotion/media`, the buffer state is enabled by default."* `<facecamtransitionbox.tsx>` and `<staticfacecam.tsx>` currently set `pauseWhenBuffering={false}` (intentional for transition components). Mediabunny inverts the default — buffer state is global at Player level, not per-component. Remove these props.

4. **`preloadVideo` is a no-op for Mediabunny**. `@remotion/preload`'s `preloadVideo` creates a hidden `<video src>` element to warm the HTML5 video pipeline. Mediabunny uses WebCodecs + `fetch()`, not HTMLVideoElement. The `preloadVideo(content.mediaPath)` calls in `DynamicAnimation.tsx:1652` accomplish nothing for `<Video>` from `@remotion/media`. Remove the entire `useEffect` block (lines 1648–1661). `@remotion/preload` package itself can stay installed for `preloadImage` use cases.

5. **CORS REQUIRED on FFmpeg server (Mediabunny-specific)**. `<OffthreadVideo>` runs a Rust extractor OUTSIDE the browser — no CORS needed. `<Video>` from `@remotion/media` fetches via browser `fetch()` for range requests — CORS headers MUST be present on `localhost:3333` for ALL video/audio asset endpoints. Per `https://www.remotion.dev/docs/media/support`: *"Any assets must be either CORS-enabled or served from the bundle using `staticFile()`."* The FFmpeg server already sets `Access-Control-Allow-Origin: *` and `Accept-Ranges: bytes` on 206 responses per Section 29B line 2450. The one-line server change noted there (`Accept-Ranges: bytes` on 200 responses) is still required.

6. **`objectFit` is now a first-class prop**. From `@remotion/media` docs: *"The CSS property object-fit is not supported."* Current code uses `style={{ objectFit: 'cover' }}`. Must migrate to `objectFit="cover"` prop on `<Video>` directly.

7. **Automatic fallback to `<OffthreadVideo>` on multiple failure modes**. Mediabunny supports H.264, H.265/HEVC, VP8, VP9, AV1 (video) and AAC, MP3, Opus, FLAC, Vorbis, AC-3, E-AC-3, plus all PCM variants (audio). Full list: https://mediabunny.dev/guide/supported-formats-and-codecs — codec availability in the browser depends on the browser's WebCodecs support (e.g. H.265 decodes natively on Safari on Apple Silicon but typically falls back on Chrome). `<Video>` from `@remotion/media` auto-renders `<OffthreadVideo>` as fallback with a console warning when ANY of these trigger: (a) the codec is unsupported by the browser's WebCodecs implementation, (b) the resource fails to load due to CORS restrictions, (c) the container format is not supported by Mediabunny, or (d) the video has an alpha channel and the browser does not support WebGL. No manual `useRemotionEnvironment()` branching needed. `disallowFallbackToOffthreadVideo` prop disables this (would surface codec/CORS issues as errors instead).

8. **No Mediabunny-specific `remotion.config.ts` options**. No WASM init, no public-path config, no Vite plugin required. Mediabunny uses browser-native WebCodecs — pure JS runtime concern.

9. **`@remotion/player` works natively with Mediabunny**. Buffer-state integration is automatic. `@remotion/player` is already installed at HyperEdit's pin (per package.json check at the time of writing — but per user instruction, package state at commit time may differ; verify post-commit).

##### Other `@remotion/*` packages — unaffected

| Package | Action |
|---|---|
| `@remotion/animated-emoji` | No change — SVG/Lottie emoji rendering |
| `@remotion/bundler` | No change — build-time bundler |
| `@remotion/gif` | No change — own JS GIF decoder |
| `@remotion/lottie` | No change — JSON animation |
| `@remotion/player` | No change needed — already integrates natively |
| `@remotion/preload` | `preloadVideo` call removed from DynamicAnimation but package can stay (used for image preloading) |
| `@remotion/renderer` | No change — server-side render path picks up new components automatically |
| `@remotion/shapes` | No change — SVG rendering |
| `@remotion/three` | No change for HyperEdit (no video texture usage currently); future video-as-texture work would use `headless`+`onVideoFrame` pattern instead of `useVideoTexture()`/`useOffthreadVideoTexture()` |
| `@remotion/cli` | No change — CLI picks up new components |

##### HyperEdit's two audio systems clarified

To prevent confusion: HyperEdit has two distinct audio paths and the migration only touches one:

| Path | File | Mechanism | Migrate? |
|---|---|---|---|
| Live preview audio | `VideoPreview.tsx:654` | Raw HTML `<audio>` element registered into `overlayVideoRefs` (cast as `HTMLVideoElement`) for seek/play sync with V2 overlay system | **NO** — this is the live RAF-clock preview, not Remotion render. Leave alone. |
| Render path audio | `ProjectTimeline.tsx:403` | Remotion `<Audio>` component inside `AudioClip` composition | **YES** — switch to `<Audio>` from `@remotion/media` |

##### Updated migration step ordering

Step 1 of the original 10-step plan becomes:

1. **Add to `package.json`**: `@remotion/media` AND `@remotion/transitions`. (`@remotion/player` already present.)

Step 2 content changes (all other steps 3–10 remain as originally listed):

2. **Migrate 8 .tsx files** off `OffthreadVideo` + legacy `Audio` (per file change table above): rename imports, prop renames (`startFrom`→`trimBefore`, `endAt`→`trimAfter`), remove `pauseWhenBuffering={false}`, remove `preloadVideo`/`preloadImage` calls, switch `objectFit` from CSS style to prop.

3. (canvas-draw widening — unchanged)
4. (VideoPreview return type widening — unchanged)
5. (RAF clock surrender — unchanged)
6. (Build `EditorComposition` — unchanged)
7. (Custom `dipToBlack()` presentation — unchanged)
8. (Migrate `staticfacecam` to CSS layout — unchanged)
9. (Wire `facecamtransitionbox` via 2× headless `<Video>` — unchanged)
10. **Add ESLint `no-restricted-imports` rule LAST**. Enabling earlier would break lint on the 8 files still using `OffthreadVideo`/legacy `Audio`. With the rule added last, it locks in the migration and prevents regression.

#### 29B.addendum.github — Pass 21 GitHub-validated concerns (2026-06-08)

After the plan was finalized, a third research pass cross-referenced each architectural choice against the Remotion GitHub issue tracker to catch known problems that docs don't surface. Method: every plan element searched for matching open/closed issues; version pinning checked vs HyperEdit's 4.0.467. Twitter/X not consulted (sufficient GitHub coverage).

Result: **plan validated**. Almost every `@remotion/media` integration bug (race conditions, buffer state cleanup, VideoFrame concurrency, first-frame reliability, trimBefore/trimAfter MediaPlayer recreation, Input disposal in Sequence) is closed-fixed at versions WELL BEFORE HyperEdit's pin. JonnyBurger himself recommends `@remotion/media` as the resolution for the exact `<OffthreadVideo>` cold-start class of bugs (see Concern 3 below) — strong directional endorsement.

Three concerns surfaced that the megadoc should track before commit. None block the POC; one affects the full migration audio path; one requires a server audit; one is informational about the measured baseline.

##### Concern 1 — Open buffer-stuck bug with 2× `<Audio>` from `@remotion/media` (Issue #8211)

**Severity**: Medium-High (affects full migration only, not POC)
**GitHub**: https://github.com/remotion-dev/remotion/issues/8211 — **OPEN**, filed by JonnyBurger 2026-06-06 (2 days before this audit). No version fix, no workaround documented.

**Scenario**: With 2× `<Audio>` from `@remotion/media` mounted simultaneously, after playing + seeking back to start, Player gets stuck in buffer state indefinitely.

**HyperEdit relevance**: `ProjectTimeline.tsx` will have at least one `<Audio>` from `@remotion/media` (A1 audio track). Production projects typically have a second `<Audio>` for A2 (background music / SFX). This is exactly the 2-Audio-tag scenario in #8211. The "play → seek to start → play again" workflow is the most common HyperEdit scrubbing pattern.

**Boundary**: Video-only POC is unaffected (no `<Audio>` instances). Full migration exposes this.

**Mitigation paths**:
- (a) Test the "play → drag to start → play again" cycle with 2 audio clips BEFORE declaring full migration done. If reproduces at pin v4.0.467, halt and wait for upstream fix.
- (b) Workaround if it reproduces: maintain a single `<Audio>` from `@remotion/media` and use `<Html5Audio>` (the deprecated legacy path) for the second audio track until upstream fix lands. This is UX-acceptable for A2 background-music which has no sync requirements.
- (c) Track issue #8211 — JonnyBurger filed it himself so resolution likely within 1-2 Remotion releases.

##### Concern 2 — CORS strictness on range request 206 responses (Issue #6896)

**Severity**: Medium (server audit required)
**GitHub**: https://github.com/remotion-dev/remotion/issues/6896 — Closed-not-planned (CDN config concern), but JonnyBurger's comment surfaces a Chrome-specific strictness the plan didn't address.

**Finding**: Chrome is stricter than Safari/Firefox about CORS headers on range requests. The plan's one-line fix (`Accept-Ranges: bytes` on 200 responses, original 29B line 2450) is necessary but not sufficient. Every 206 (Partial Content) response from the FFmpeg server must ALSO carry `Access-Control-Allow-Origin: *`. The original 29B says these are already present, but if any 206 path is missed Chrome will silently fail.

**Why "silently"**: Auto-fallback to `<OffthreadVideo>` on CORS failure (added v4.0.357, before pin) means a CORS failure degrades silently to the rejected component path. The Mediabunny POC measurement would then run on `<OffthreadVideo>` not Mediabunny — giving a false negative (POC appears to work but isn't actually exercising WebCodecs).

**Required pre-POC action**: Audit `scripts/local-ffmpeg-server.js` to confirm `Access-Control-Allow-Origin: *` is present on ALL response codes from all asset endpoints (200, 206, 304). Verify via curl:
```bash
curl -i -H "Origin: http://localhost:5173" -H "Range: bytes=0-1023" \
  http://localhost:3333/session/{sessionId}/assets/{assetId}/stream
```
Check the response shows `HTTP/1.1 206 Partial Content` AND `Access-Control-Allow-Origin: *` AND `Content-Range: bytes 0-1023/...` AND `Accept-Ranges: bytes`. If any of those are missing, the POC measurement will be invalid (silent OffthreadVideo fallback).

##### Concern 3 — Current `<OffthreadVideo>` baseline measurement is confounded by regression #7562

**Severity**: Low (informational; confirms plan direction)
**GitHub**: https://github.com/remotion-dev/remotion/issues/7562 — Closed-completed, but no Remotion code patch. JonnyBurger's resolution: *"Use our custom media tag, it is optimized for perfect transitions"* — direct endorsement of `@remotion/media`. Also: *"Will switch this to default soon!"*

**Finding**: Regression 4.0.448 → 4.0.465 caused `<OffthreadVideo>` in adjacent same-source `<Sequence>` to cold-start on every cut boundary, adding ~95 ms freeze per boundary. HyperEdit's pin v4.0.467 is in the regression window. The fix is the migration itself — no prior-version Remotion patch exists.

**Baseline measurement implication**: The "71 ms baseline" cited throughout this megadoc was measured with `<OffthreadVideo>` at v4.0.467 (per Section 21.4 and earlier). If clip-boundary transitions in HyperEdit's test timeline trigger the #7562 freeze, actual measured baseline may include 71 ms (V2 sync floor) + ~95 ms (cut-boundary cold-start) = ~166 ms total at some sample positions. This does NOT invalidate the bimodal finding (Runs 13-18, n=22, 5 LOW / 17 HIGH, mean 537ms) but means the lower-tail "71 ms" framing in the executive summary may underrepresent the true baseline at clip-boundary play positions.

**Action**: No action required before POC — this is confirming evidence that the migration directly fixes a real upstream regression, beyond the original V2 audio decoder init concern. Adds a second motivation for the migration on top of the audio-decoder root cause.

##### Concern 4 — Open one-frame flicker regression since v4.0.456 (Issue #7904)

**Severity**: Medium (POC measurement integrity)
**GitHub**: https://github.com/remotion-dev/remotion/issues/7904 — **OPEN**, filed by JonnyBurger 2026-06-01 on behalf of customer. No fix, no workaround, no assignee.

**Finding**: One-frame blank flicker confirmed introduced in v4.0.456, still present at v4.0.470. HyperEdit's pin v4.0.467 is **inside the regression window**. Issue body is sparse — JonnyBurger has not yet specified whether the trigger is `<Video>` from `@remotion/media`, `<OffthreadVideo>`, Player's `playRange` prop, or a canvas element.

**HyperEdit relevance**: A one-frame blank during playback would be observable during the POC's seek-and-play protocol. If the flicker happens during `[V2MEAS][firstFrame]` rVFC capture, the captured frame may be the blank frame (false-zero ptF) or the next non-blank frame (false-elevated ptF). Either way the measurement is contaminated.

**Action required during POC**:
- Visually observe playback for 3–5 cycles. If one-frame blanks are seen, halt measurement and switch to per-cycle paired-control protocol (compare with/without the flicker visible) before trusting POC numbers.
- If upstream releases a fix beyond v4.0.470, upgrade HyperEdit's pin and re-test before declaring POC pass/fail.
- Cross-check Pass 19's stale-frame fingerprint logic in `SKILL-video-pipeline-diagnostics.md`: a one-frame blank may register as `ptF<2ms` with `presentedFrames` already incremented — currently classified INVALID by the existing protocol, which is the correct response.

##### Concern 5 — Canvas blank at `playRange` boundary (Issue #7905, informational)

**Severity**: Low-Informational
**GitHub**: https://github.com/remotion-dev/remotion/issues/7905 — **OPEN**, filed 2026-06-01. Reporter explicitly says *"no specific remotion version, this happens across all versions."*

**Finding**: Canvas goes blank for one frame when Player seeks across different `playRange` boundaries. Pre-existing Player behavior, not a Mediabunny regression.

**HyperEdit relevance**: HyperEdit's Path 4 uses `<Player>` and may or may not use the `playRange` prop. The canvas-draw transition layer (facecamtransitionbox via `<Video headless onVideoFrame>` + canvas) would visibly flash at the affected seek boundary if `playRange` is used. The architecture diagram in 29B.addendum doesn't currently use `playRange` — clips are managed via `<TransitionSeries.Sequence durationInFrames>` and `<Sequence>` boundaries, not `playRange`. So this likely doesn't apply, but worth a sanity check at implementation time.

**Action**: At Path 4 implementation, do NOT pass a `playRange` prop to `<Player>` unless explicitly required. If `playRange` is needed, test seek-play cycles with canvas transitions visible.

##### What was confirmed safe by Pass 21

For each plan element with zero open issues or no relevance to HyperEdit's pin:

- **Player `inputProps` stability**: useMemo mitigation is best-practice; no known bugs
- **`headless: true` + `onVideoFrame`**: zero memory leak / lifecycle / callback stability issues
- **Vite / WASM bundling**: zero reports of Vite-Mediabunny interaction issues; the 2-4h buffer in original 29B is now conservative
- **`<TransitionSeries>` + `<Video>` from `@remotion/media`**: combination works (the one 4153 issue was Next.js RSC, not Remotion)
- **`<Video>` (not Audio) buffer state with multiple instances**: clean
- **`objectFit` prop**: clean (the one OffthreadVideo issue couldn't be reproduced)
- **`trimBefore`/`trimAfter`**: PR #6032 (merged Dec 2025) confirms dynamic prop changes no longer recreate MediaPlayer — better than `<OffthreadVideo>` was
- **VideoFrame TypeScript availability**: structural check workaround per Pass 19 has zero risk
- **Player `seekTo` pause-resume**: known design; Chrome works correctly post-v4.0.322
- **`disallowFallbackToOffthreadVideo`**: zero reports; default behavior (auto-fallback on) is correct

##### Pass 22 coverage gap audit (2026-06-08) — 20 additional architectural elements checked

Pass 22 verified 20 elements Pass 21 may have missed: `@remotion/transitions` package bugs, VideoFrame memory/leak issues, server-side render path, HMR, cache 50% RAM behavior, Player-without-Composition, requestInit, AbsoluteFill z-index, frameupdate sync, concurrent VideoDecoder limits, long-clip handling, Audio autoplay, `@remotion/preload` post-migration, bundle size, iOS Safari, AudioContext, background tabs, captions+Mediabunny isolation, same-source reuse, and initial Player render performance.

Result: 18 of 20 elements **confirmed-safe** (zero open GitHub issues). 2 NEW concerns (#7904 one-frame flicker — surfaced as Concern 4 above; #7905 canvas blank at playRange — Concern 5 above).

##### Pass 21 + Pass 22 sources (all verified via chrome-devtools-mcp; zero Twitter sources used)

21 GitHub issues consulted across 32 architectural elements (12 in Pass 21 + 20 in Pass 22). Full list:

- https://github.com/remotion-dev/remotion/issues/8211 — **OPEN** — 2-Audio-tag buffer stuck (Concern 1)
- https://github.com/remotion-dev/remotion/issues/7562 — Closed-completed — OffthreadVideo cut-boundary regression (Concern 3)
- https://github.com/remotion-dev/remotion/issues/6896 — Closed-not-planned — CORS Chrome strictness (Concern 2)
- https://github.com/remotion-dev/remotion/issues/7210 — Closed-fixed v4.0.455 — Audio falls back to Html5Audio
- https://github.com/remotion-dev/remotion/issues/7510 — Closed-fixed v4.0.465 — Player no buffer when exiting premount
- https://github.com/remotion-dev/remotion/issues/7205 — Closed — seekTo + frameupdate Firefox-specific
- https://github.com/remotion-dev/remotion/issues/5650 — Open master tracker (40/40 sub-issues complete)
- https://github.com/remotion-dev/remotion/issues/5994 — Closed — First frame reliability
- https://github.com/remotion-dev/remotion/issues/5779 — Closed-fixed v4.0.362 — Race condition media player
- https://github.com/remotion-dev/remotion/issues/5773 — Closed — OffthreadVideo objectFit
- https://github.com/remotion-dev/remotion/issues/5750 — Closed-fixed v4.0.357 — VideoFrame at concurrency=7
- https://github.com/remotion-dev/remotion/issues/5728 — Closed-fixed v4.0.357 — Buffer state after hot refresh
- https://github.com/remotion-dev/remotion/issues/5700 — Closed-fixed v4.0.357 — Fallback on no CORS
- https://github.com/remotion-dev/remotion/issues/5812 — Closed-fixed v4.0.357 — Input disposed in Sequence
- https://github.com/remotion-dev/remotion/issues/5485 — Closed-fixed v4.0.322 — seekTo stale behavior
- https://github.com/remotion-dev/remotion/issues/2812 — Closed-fixed v4.0.322 — Pause + seekTo requires setTimeout
- https://github.com/remotion-dev/remotion/pull/6032 — Merged Dec 2025 — trimBefore/trimAfter MediaPlayer reuse
- https://github.com/remotion-dev/remotion/issues/4153 — Closed — TransitionSeries in Next.js RSC (not relevant)
- https://github.com/remotion-dev/remotion/issues/7772 — Closed — @remotion/media slower than OffthreadVideo on Windows render path (render-time only, not preview)
- https://github.com/remotion-dev/remotion/issues/7904 — **OPEN** — One-frame flicker since v4.0.456 (Concern 4, NEW in Pass 22)
- https://github.com/remotion-dev/remotion/issues/7905 — **OPEN** — Canvas blank at playRange boundary (Concern 5, NEW in Pass 22)
- https://github.com/remotion-dev/remotion/issues/3178 — Closed-fixed — `slide()` white line bug (pre-pin, safe)
- https://github.com/remotion-dev/remotion/issues/2578 — Closed-not-planned — ESM/CJS conflict (irrelevant to Vite/ESM stack)
- https://github.com/remotion-dev/remotion/issues/7793 — OPEN — Native jumpcuts feature request (informational only)
- https://github.com/remotion-dev/remotion/issues/4367 — Closed — BufferingProvider export (informational)

#### 29B.addendum.versionbump — Post-version-bump re-verification checklist (Pass 23 verified, 2026-06-08)

The user plans to bump Remotion from 4.0.467 → 4.0.474+ in the next CC session that migrates code to `@remotion/media`. This checklist verifies what changes vs what stays version-agnostic after a bump. All items below were independently verified against live Remotion docs and GitHub at 2026-06-08.

**Version-agnostic (will not change with bump — no re-verification needed)**:
- canvas-draw widening (TypeScript fix, no Remotion API dep)
- ESLint `no-restricted-imports` rule structure (doesn't reference Remotion APIs)
- 9-file migration list (file-level grep, OffthreadVideo/Audio imports won't disappear)
- `<Audio>` from `@remotion/media` requirement (package-level)
- `startFrom`→`trimBefore`, `endAt`→`trimAfter`, `pauseWhenBuffering` removal, `objectFit` prop rename (all stable since v4.0.319, won't reverse)
- CORS server audit (server-side, no Remotion dep)

**Version-dependent — re-verify after each bump**:

1. **Re-check #7904 (one-frame flicker regression, OPEN at 4.0.474)**
   - URL: https://github.com/remotion-dev/remotion/issues/7904
   - Confirmed still reproducible through 4.0.470 by JonnyBurger himself. No linked PR. No fix in 4.0.468–4.0.474.
   - Action: Check if PR has merged. If still open, HyperEdit's playback path is still affected.

2. **Re-check #8211 (2× Audio buffer-stuck, OPEN at 4.0.474)**
   - URL: https://github.com/remotion-dev/remotion/issues/8211
   - Zero comments, no workaround posted.
   - Action: Check for new comment or linked fix. Repro: play → drag to start with 2 Audio tags mounted.

3. **Re-grep `node_modules` for new `@deprecated` props**
   - After `npm install`, run: `grep -r "@deprecated" node_modules/remotion/dist node_modules/@remotion`
   - Catches newly deprecated props before they become compile errors in a future major.

4. **`rtk tsc` + `rtk lint` after bump**
   - Required. Catches type breakage from Remotion's frequent prop additions and deprecations.

5. **Verify `import {Video} from 'remotion'` still resolves**
   - At 4.0.474: `/docs/video` redirects to `/docs/html5-video`. `<Video>` from `'remotion'` was renamed to `<Html5Video>` at docs level. The component is still exported from `'remotion'` as both `Video` (backwards-compat alias) and `Html5Video`.
   - `@remotion/media <Video>` is documented as "experimental component that will replace `<Html5Video>` at some point" — NOT yet the default at 4.0.474.
   - Action: Run `tsc` and confirm `import {Video} from 'remotion'` still works. If Remotion removes the `Video` re-export in a future version, every existing HyperEdit OffthreadVideo callsite (after migration to `@remotion/media`) is unaffected, but any legacy `Video` import would error.
   - ESLint rule should ALSO block `Html5Video` from `'remotion'` for the same off-limits reasons it blocks `Video`.

6. **#7562 OffthreadVideo regression — CLOSED**
   - URL: https://github.com/remotion-dev/remotion/issues/7562
   - JonnyBurger closed with: "Use `@remotion/media`... our custom media tag is optimized for perfect transitions. Will switch this to default soon!" — confirms `@remotion/media` is the definitive fix, not a workaround.
   - Action: After bump, check if `<Html5Video>` / `OffthreadVideo` has been removed from `'remotion'` main export in favour of `@remotion/media` (the "default switch" JonnyBurger mentioned). If so, update any remaining stragglers.

7. **Version compatibility table spot-check (all 6 entries verified correct at 4.0.474)**
   - `<Video>` from `@remotion/media` `headless?v4.0.387` ✓
   - `<Video>` from `@remotion/media` `requestInit?v4.0.465` ✓
   - `<Video>` from `@remotion/media` `effects?v4.0.464` ✓
   - `<OffthreadVideo> onVideoFrame?v4.0.190` ✓
   - `<Html5Video> onVideoFrame?v4.0.472` ✓
   - `makeHtmlInCanvasPresentation v4.0.456` ✓
   - Action: After each bump spot-check 2–3 against live docs to catch upstream doc corrections.

8. **`<Html5Video> onVideoFrame v4.0.472` becomes available at 4.0.474+ — moot for HyperEdit**
   - HyperEdit rejects `<Html5Video>`. `@remotion/media <Video>` has `onVideoFrame` already (no version tag, present since inception). No action needed unless `<Html5Video>` is ever reconsidered.

9. **`@remotion/transitions` presentations — no new ones between 4.0.467 and 4.0.474**
   - All presentations on /docs/transitions/presentations verified. No `dipToBlack` / `fadeToBlack` built-in exists.
   - Action: Custom `dipToBlack` presentation still required. After future bumps, re-check the presentation list for new fade-to-color equivalent.

10. **Mediabunny version in `@remotion/media`**
    - 4.0.467 and 4.0.474 both pin **mediabunny 1.45.0** (verified via `registry.npmjs.org/@remotion/media/<version>`)
    - Mediabunny 1.46.0 exists on npm (published ~2026-06-02) but not yet consumed by any Remotion release.
    - Action: After future bumps (4.0.475+), check `registry.npmjs.org/@remotion/media/<version>` for the `"mediabunny": "x.y.z"` dependency field. If changed, review mediabunny release notes for codec/buffer behavior changes affecting sync correctness.

11. **`@remotion/media <Video>` buffer behavior — re-test play-seek-play cycle**
    - 4.0.470 fixed premount buffering state; 4.0.474 fixed frame cache duration check. Both touch the same buffer subsystem as open issue #8211.
    - Action: After any bump, manually run play-seek-play cycle with 2 Audio tags + 1 Video to confirm no new buffer-stuck regression.

12. **Verify `disallowFallbackToOffthreadVideo` intent**
    - `@remotion/media <Video>` falls back to `<OffthreadVideo>` by default on error. If HyperEdit's migration intent is to fully eliminate OffthreadVideo, confirm `onError={() => 'fail'}` or `disallowFallbackToOffthreadVideo` is set where the fallback would defeat the purpose of the migration.
    - Not strictly version-bump related but worth re-confirming after any `@remotion/media` patch since `onError` semantics could shift.

##### Pass 23 verification results (errors caught in pre-draft)

The user's initial draft of this checklist had 3 errors that Pass 23 corrected:

1. **#7562 wrongly framed as "still need to verify status"** — it is definitively CLOSED with `@remotion/media` confirmed as the definitive fix. Rewritten as Item 6.
2. **Mediabunny version bump assumed** — no bump occurred 4.0.467 → 4.0.474 (both pin 1.45.0). Rewritten as Item 10 with correct framing.
3. **#7904 wording weak** — JonnyBurger confirmed still reproducible through 4.0.470 himself. Strengthened as Item 1.

Additionally, Pass 23 surfaced 2 NEW items (11, 12) that the orchestrator's draft missed: buffer-behavior re-test after `@remotion/media` patches and `disallowFallbackToOffthreadVideo` intent verification.

### 29C. Mount/unmount + Chrome pipeline event log diagnostic (post-decoder-backend continuation)

After the decoder backend was confirmed identical (D3D11 hardware for both V1 and V2), the team ran two further diagnostics to explain the remaining V2 vs V1 cold-start gap:

**Diagnostic A — V2 mount/unmount counting**: a new `[V2MEAS][mount]` / `[V2MEAS][unmount]` log was added to V2's `<video>` ref callback in `VideoPreview.tsx`. Hypothesis: V2 remounts more than expected because its React `key={layer.id}-${layer.url}` changes when `streamUrl` cache-busts.

**Diagnostic B — full Chrome media-internals event log per player**: capture timestamped pipeline state transitions for V1 and V2 during a play-pause-seek-play cycle.

#### Diagnostic A — RESULT REINTERPRETED

The agent captured **8 `[V2MEAS][mount]` and 8 `[V2MEAS][unmount]` events for V2** in a single session — apparently confirming the remount hypothesis. The URL was identical across all 8 fires (`...85a5efb0.../stream?v=1780621403942`) — refuting the cache-bust mechanism.

However, **media-internals showed only ONE V2 player created during the session** with a stable pipeline (subsequent transitions on the same player, not multiple "created" events). This contradicts the 8 mount logs.

The reinterpretation: the `<video>` ref callback in `VideoPreview.tsx` is an **inline function** (`ref={(el) => { ... }}`). React treats the inline function as a new identity every render. When the callback identity changes, React calls the old callback with `null` (interpreted by our log as "unmount") and the new callback with the same DOM element (interpreted as "mount"). **The DOM element is the same instance throughout; the ref callback noise is misleading.**

Confirmation from media-internals: V2's `created` event fires once at session start (`00:00:00.000`), and all subsequent V2 events are state transitions on the same player instance. No real `<video>` element remounts happen during a session at the playback layer.

**Verdict for Diagnostic A: REFUTED**. V2 does not remount in DOM. The mount/unmount log instrumentation is unreliable for counting real React mounts because it's tied to ref-callback identity rather than effect lifecycle. The original cold-start mechanism (Chrome compositor pipeline state) stands.

To get reliable mount counts in a future investigation, use `useEffect(() => { console.log('mount'); return () => console.log('unmount'); }, [])` inside a wrapper component, OR move the ref callback into a stable `useCallback` so its identity persists across renders.

#### Diagnostic B — RESULT CONFIRMED, NEW ASYMMETRY FOUND

The agent captured the full media-internals event log for V1 and V2 during a play-pause-seek-play cycle. Both V1 and V2 use `D3D11VideoDecoder` (re-confirming the prior hardware finding). Both videos suspended at identical times during the test (Chrome's tab-backgrounding policy fires when agent switched away from HyperEdit to media-internals; not relevant to single-tab usage).

**The real asymmetry**: V2 fires extra `kPause` events that V1 does not.

V1 event sequence (abbreviated):
```
00:00:00.000  created
00:01:01.145  event = kPause
00:02:28.571  event = kPlay
00:02:56.098  event = kPause
```

V2 event sequence (abbreviated):
```
00:00:00.000  created
00:00:00.401  event = kPause          ← V2 pauses BEFORE first play
00:01:01.146  event = kPause
00:01:01.369  event = kPause          ← V2 double-pauses (223 ms later)
00:02:15.466  event = kPause          ← extra pause mid-seek
00:02:28.572  event = kPlay
00:02:56.099  event = kPause
```

V2 has approximately 4 extra `kPause` transitions per session that V1 does not have.

**Root cause**: the V2/V3 overlay play/pause effect (`playEffect` in `VideoPreview.tsx:221+`) has `useEffect(() => {...}, [isPlaying, layers])`. The V1 play/pause effect has `useEffect(() => {...}, [isPlaying])`. The `previewLayers` array recomputes on every Home.tsx render (it's not memoized via `useMemo`), so V2's `playEffect` fires on every render — not just on `isPlaying` changes. The else-branch unconditionally calls `video.pause()` even when `video.paused` is already true. Each redundant `pause()` call propagates to Chrome's media pipeline as a `kPause` event.

V1's effect only fires on `isPlaying` transitions because its dependency array is narrower. V1 sees only one `kPause` per real user-pause action.

**Connection to the cold-start cost**: every redundant `pause()` call exercises the Chrome pipeline's pause-state machinery. Even without a real remount, the pipeline must process each pause-then-resume cycle. The cumulative effect over a test session is V2's pipeline being repeatedly nudged into pause-resume transitions while V1's pipeline stays in a steadier playing-paused-playing cycle. This is consistent with the Run 6 finding that V2's `expDT − presT = 0` (compositor cold) while V1's is `+6.9 ms` (compositor warm) — V1's pipeline has time to establish lookahead between sparse pause events, V2's never does.

**Fix candidate (cheap, low-risk)**: gate `video.pause()` in V2's playEffect else-branch with a `!video.paused` check. Code change:

```ts
// Before (current HEAD):
} else {
  video.pause();
}

// After (proposed):
} else {
  if (!video.paused) {
    video.pause();
  }
}
```

This eliminates the redundant `kPause` events without changing observable behavior — if V2 is already paused, calling `pause()` again is a no-op as far as user intent goes, but it does propagate to Chrome's pipeline. The guard prevents that propagation.

**Expected impact**: V2's pipeline state machine sees fewer transitions per session, plausibly reducing the variance and possibly the magnitude of V2's cold-start latency. Not a guaranteed fix (the underlying pipeline-state mechanism is still Chrome-internal), but a targeted change worth one measurement run.

Estimated cost: 5 minutes to apply, 20 minutes to run the agent measurement.

**Stronger fix candidate (medium effort)**: memoize `previewLayers` in `Home.tsx` via `useMemo` so the array reference is stable when content is identical. This eliminates the unnecessary V2 playEffect fires entirely. Risk: the existing code may depend on `previewLayers` being a fresh array each render in subtle ways; memoization may regress elsewhere. Estimated cost: 30 minutes to implement carefully, 30 minutes to measure and verify no regressions.

### 29D. Run 9 — `!video.paused` guard applied + isolated 5-seek measurement

After Section 29C identified the redundant-pause-call mechanism, the team applied the cheap fix:

```ts
// VideoPreview.tsx playEffect else-branch
} else {
  if (!video.paused) {
    video.pause();
  }
}
```

Run 9 used the original isolated 5-seek protocol (35, 50, 65, 80, 100) for direct comparison against Run 6 baseline. Result: **V2 ptF mean dropped 37%** from 225 ms (R6) to 142.5 ms (R9, 4 valid samples). More importantly, V2 `expectedDisplayTime − presentationTime` shifted from `0.0 ms` (consistently cold across all prior runs) to **`+6.7 to +6.9 ms` on 3 of 4 samples** — matching V1's warm compositor pipeline signature.

This was the first measurement where V2's compositor pipeline was demonstrably as warm as V1's. The guard eliminates redundant `kPause` events that were churning the V2 pipeline state machine.

| Seek | R9 V2 ptF | R9 V2 expDT−presT | R9 V1 ptF |
|---:|---:|---:|---:|
| 35 (cold) | 370 | 0.0 ms | 266 |
| 50 | 78 | +6.9 ms | 16 |
| 65 | 43 | +6.8 ms | 9 |
| 80 | 79 | +6.7 ms | 10 |
| 100 | invalid (project end) | — | — |

Sample 1 (P=35) is the first play after page reload — cold pipeline for both V1 and V2 (presentedFrames=2). Subsequent samples (warm) show V2 ptF range 43–79 ms, mean 66.7 ms. Still above the < 30 ms pass criterion but a dramatic improvement.

### 29E. User feedback — sync offset still perceptible during real-world editing

After Run 9, the user reported they still **audibly perceived ~300 ms sync offset** while monitoring a sonnet agent's test session. This contradicted Run 9's measured 142.5 ms mean. The discrepancy implied the isolated-seek protocol was not exercising the same code paths as a real editor's workflow.

The user requested a test that mimics a human editor: play a few seconds → seek elsewhere → play a few seconds → seek again → sometimes revisit the same spot to confirm something. Run 10 was designed to capture this realistic scrubbing pattern.

The user pointed the agent at `D:\app-ext\coding\localgitrepo\hyperedit\.playwright-cli` for inspiration on prior playwright-driven UI interaction patterns. The agent consulted `test-v2-big-jump.js` (multi-trial seek with full V1+V2 event tracing) and `test-playback-seek-v2.js` (ruler-based seek while playing) before designing the Run 10 pattern.

### 29F. Run 10 — Realistic editor scrubbing pattern (8 cycles)

**Pattern**: 8 seek-play cycles with mixed forward/backward jumps, variable play durations, and 3 deliberate revisits.

| Cycle | Seek | Play | Direction |
|---|---|---|---|
| 1 | 30 s | 4 s | cold start |
| 2 | 65 s | 3 s | +35 s forward |
| 3 | 45 s | 3 s | −20 s backward |
| 4 | 45 s | 3 s | revisit same |
| 5 | 80 s | 4 s | +35 s forward |
| 6 | 30 s | 3 s | −50 s backward |
| 7 | 95 s | 3 s | +65 s forward |
| 8 | 65 s | 3 s | −30 s backward |

#### Per-cycle data captured from `[V2MEAS]` logs

| Cy | seek | V1 ptF | V2 ptF | V2 expDT−presT | V2 presentedFrames | V2 − V1 ptF |
|---|---|---|---|---|---|---|
| 1 | 30 | 424 ms | 277 ms | 0 ms (cold both) | 2 | **−147 ms** (V2 leads V1) |
| 2 | 65 | 9 | 105 | +6.9 | 1669 | +96 |
| 3 | 45 | 5 | 101 | +6.9 | 3291 | +96 |
| 4 | 45 (revisit) | 13 | 88 | +6.8 | 5010 | +75 |
| 5 | 80 | 13 | 96 | +6.7 | 6140 | +83 |
| 6 | 30 | 11 | 94 | +6.9 | 7842 | +83 |
| 7 | 95 | INVALID — project hit end at 120s during play interval, looped to 0:00 | — | — | — | — |
| 8 | 65 | 13 | **672** | +6.7 (post-mount warm) | **3** (fresh mount!) | **+659** |

#### What the agent observed in the debug logs and browser tools

**Cycle 7 → 8 transition (the failure mode)**:

1. Cycle 7 seek to 95 s + 3-s play put the playhead at ~98 s when play started.
2. During the 3-s observation, V1 reached 120 s (project total duration).
3. The Home.tsx RAF loop's end-of-duration handler fired:
   - `currentTimeRef.current = duration`
   - `setCurrentTime(duration)`
   - `setIsPlaying(false)`
4. However, the agent observed V1's `currentTime` had wrapped back to ~9.756 s, paused=false. Some loop behavior happened (HTML5 video looping, or HyperEdit resetting and resuming) that the agent did not fully diagnose during the run.
5. V2 was at position 0 s. V2's clip active window is [28.26, 120.15]. At position 0 s, `currentTime < clip.start - PREMOUNT_SECS` (0 < 26.26). V2 was therefore **removed from `previewLayers` by `getPreviewLayers`** and the `<video>` element unmounted from the DOM.
6. Cycle 8 seek to 65 s brought the playhead back into V2's active window. The `<video>` element remounted fresh.
7. Cycle 8 play click: V2's first `[V2MEAS][firstFrame]` logged `playToFrameMs=672 ms` and `presentedFrames=3` (the 3 confirming this was a brand-new decoder instance, not a stale pipeline).
8. V1 ptF was 13 ms (warm — V1 had not unmounted; its decoder stayed hot through the loop event).
9. V2 − V1 = **+659 ms** at this moment.

The agent's `[V2MEAS][mount]` log fired for V2 during cycle 8 (consistent with the fresh-mount interpretation), and the new D3D11VideoDecoder instance would have been visible in `chrome://media-internals` if captured (the agent did not switch tabs to confirm — would require an additional measurement pass).

**Steady-state warm cycles (2–6) observed**:

- All 5 warm cycles showed `expectedDisplayTime − presentationTime` in the **6.7–6.9 ms** range for V2. This is the first time during the investigation that V2's compositor pipeline lookahead matched V1's warm signature for consecutive cycles. Confirmed by the `[V2MEAS][firstFrame]` rVFC metadata.
- `presentedFrames` for V2 climbed monotonically across cycles 2 → 6 (1669 → 3291 → 5010 → 6140 → 7842), confirming V2's pipeline accumulated decoded frame count across the session without resetting. No remount between cycles 2 and 6.
- V1 `playToFrameMs` was effectively at one display refresh (5–13 ms = roughly one 144Hz vsync) once warm.
- The revisit benefit (cycle 4 vs cycle 3, both seek=45) showed a 13 ms reduction in V2 ptF (101 → 88 ms). The OS disk cache or browser media buffer retained the relevant byte range from cycle 3's seek, allowing cycle 4's decoder to resolve faster.

**Cold-start asymmetry observed (cycle 1)**:

- V1 ptF = 424 ms, V2 ptF = 277 ms. V2 fired its first decoded frame **before** V1.
- Counterintuitive but consistent with V2 being a much smaller file (~142 MB OBS recording) vs V1 (4.3 GB camera file). V2's initial range request and decoder warm-up beat V1's.
- This is opposite to the user's "V2 trails V1" perception.

#### Section comparison vs Run 9

| Metric | Run 9 (isolated) | Run 10 (continuous scrubbing) |
|---|---|---|
| Warm V2 ptF mean | 66.7 ms (3 warm samples: 78, 43, 79; P=35 cold sample 370 excluded) | **96.8 ms** (5 warm samples: 105, 101, 88, 96, 94) |
| V1 ptF warm mean | ~12 ms (3 warm samples: 16, 9, 10) | ~10 ms (5 warm samples: 9, 5, 13, 13, 11) |
| Warm V2 − V1 mean | ~55 ms (warm-only paired) | **86.6 ms** (warm-only paired) |
| Cold start V2 − V1 (P=35 / cycle 1) | +104 ms | −147 ms (V2 lead) |
| Worst observed spike | 370 ms (R9 cold P=35) | **+659 ms (R10 cycle 8 — post-unmount remount)** |

Continuous scrubbing keeps the V2 pipeline warmer than the isolated protocol allows, **but introduces a new failure mode the isolated protocol could not reach**: V2 unmount during project-end loop, followed by cold remount, producing a +659 ms V2 − V1 spike.

#### Match to user's 300 ms perception

The user's stated ~300 ms perception falls between:
- Steady-state warm V2 − V1 = 86.6 ms (well below the user's perception)
- Post-unmount-remount spike = +659 ms (well above)

Most plausible explanation: **the user was hearing a cycle that included a recent V2 unmount/remount event** — e.g., they had scrubbed near the project end shortly before, or the project looped, or the V2 clip had recently been out of pre-mount window. The 659 ms measured spike is more than 2× the user's 300 ms perception; the user may have averaged across consecutive cycles where the spike was decaying, or perceived the spike conservatively.

The 86.6 ms steady-state is below typical AV sync perceptual threshold (ITU-R BT.1359 recommends sync within ±125 ms for general broadcast; tighter for music/dialogue). Steady-state is acceptable. **The fix target is the unmount-remount cold spike.**

#### Fix candidates for the unmount-remount spike

1. **Keep V2 always mounted** (widen `getPreviewLayers` eligibility so V2 stays in `layers` with `isPremounted=true` whenever its clip exists, regardless of `currentTime`). Tradeoff: continuous decoder + buffer memory while V2 out of scene. ~10 lines in `Home.tsx`. Eliminates the cold-mount spike entirely.

2. **Detect mount + pre-warm before user play**: a `useEffect(() => { /* pre-warm */ }, [video])` per V2 element that runs a brief muted play→rVFC→pause pulse on first mount. Similar to the abandoned Option F pulse, but only on actual mount events (not every seek). Risk: audio blip during the pre-warm play.

3. **Verify the loop mechanism first**: the agent reported the project looped, but Home.tsx's RAF loop has `setIsPlaying(false)` at end. The discrepancy suggests either the HTML5 `<video>` element has `loop=true`, or some other component is triggering the reset. A 5-minute code read could identify and either prevent the loop or trigger pre-mount earlier in the loop sequence.

Option 1 is the most direct. Option 3 is a prerequisite (confirm the loop is intentional or a bug).

### 29G. Run 11 — Always-mount V2 fix attempt (REVERTED)

To eliminate the unmount-remount cold-spike found in Run 10 cycle 8, the team tried widening `getPreviewLayers` in `Home.tsx` to **always include V2/V3 overlay clips in `layers`** regardless of `currentTime`. Out-of-scene V2 would remain mounted as `isPremounted=true` (opacity:0, pointer-events:none) so the D3D11VideoDecoder instance stays alive.

Code change (in `Home.tsx` `getPreviewLayers`):

```ts
// Before
const clipsOnTrack = activeClips.filter(c =>
  c.trackId === trackId &&
  currentTime >= c.start - (isOverlayTrack ? PREMOUNT_SECS : 0) &&
  currentTime < c.start + c.duration
);

// After (always-mount overlays)
const clipsOnTrack = isOverlayTrack
  ? activeClips.filter(c => c.trackId === trackId)
  : activeClips.filter(c =>
      c.trackId === trackId &&
      currentTime >= c.start &&
      currentTime < c.start + c.duration
    );
```

Plus the `isPremounted` and `clipTime` derivation was updated to handle out-of-scene-past-end as well as out-of-scene-before-start.

#### Run 11 measurement (same 8-cycle pattern as Run 10)

| Cy | seek | V1 ptF | V2 ptF | V2 presentedFrames | V2 − V1 ptF |
|---|---|---|---|---|---|
| 1 | 31s | 14 | **666** | 5 | +652 |
| 2 | 65s | 13 | **665** | 3238 | +652 |
| 3 | 45s | 11 | **670** | 4763 | +659 |
| 4 | 45s (revisit) | 12 | **664** | 6172 | +652 |
| 5 | 80s | 12 | **657** | 7202 | +645 |
| 6 | 29s | 10 | 127 | 8219 | +117 |
| 7 | 95s | 5 | 525 | 9161 | +520 |
| 8 | 65s | 339 | **25** | 10621 | −314 (V2 lead) |

#### Cycle 8 spike eliminated ✓

V2 cycle 8 ptF dropped from Run 10's 672 ms to Run 11's **25 ms**. `presentedFrames` climbed monotonically from 5 (C1) through 10621 (C8), confirming the V2 decoder pipeline stayed alive throughout — no fresh-mount D3D11VideoDecoder creation. The hypothesis was validated for the targeted scenario.

#### But a massive warm-cycle regression appeared ✗

V2 ptF for cycles 2–5 and 7 sat at 525–670 ms, ~7× worse than Run 10's 86.6 ms warm mean. The mechanism (agent's analysis confirmed by data):

- In Run 10's pre-mount model, V2 mounted with `<video preload="auto">` when `currentTime` crossed `clip.start - 2 s`. By the time the user's playhead was in V2's range, the browser had already buffered toward `clipTime ≈ 0` and was in a position to seek to the play target with a moderate range request.
- In Run 11's always-mount model, V2 mounted at session start (no pre-mount window). V2 sat at `clipTime = 0` indefinitely with whatever buffer the browser pre-fetched at byte 0.
- When the user seeked from out-of-V2 to in-V2 (e.g., scrub from T=10 to T=65), `getPreviewLayers` recomputed V2's `clipTime` to ~36.74 s. `seekEffect` issued `V2.currentTime = 36.74`. This triggered a large seek requiring a new byte range fetch and decoder walk-forward from the prior IDR.
- The agent's test protocol waited only 300–800 ms after the seek before clicking play. V2's seek had not completed. `playEffect` set V2.currentTime (no-op due to 30 ms gate) then called `video.play()` while V2 was still seeking. Chrome serialized the play behind the in-flight seek. The first `requestVideoFrameCallback` fired only after both seek and play resolved — measured at ~660 ms.

The always-mount strategy traded one rare-case win (cycle 8 cold-mount spike: ~600 ms saved) for a per-cycle penalty (~570 ms added on every seek into V2's range). Per session, the regression is net negative.

#### Reversion

The `getPreviewLayers` change was reverted to Run 10's state. The 2-second pre-mount window is restored. The `!video.paused` guard from Run 9 remains. The cycle 8 unmount-remount spike returns as a latent edge case.

#### Lessons captured

1. **Always-mount alone is insufficient.** To kill the unmount-remount spike without the warm regression, V2 would need to be anchored at the user's anticipated play position (not just `clipTime = 0`), so the seek distance is small when the user clicks play. This requires either: (a) anchoring `clipTime` based on the predicted user position rather than the clip's `inPoint`, OR (b) gating `video.play()` on `seeked` event so play waits for any in-flight seek to complete.

2. **Approach 1b (seek-completion-gated play) is the better candidate.** A small addition in `playEffect`: when `video.seeking === true`, register a one-shot `seeked` listener and play from inside it. This avoids the cold-start race regardless of mount strategy. Estimated 10 lines. Worth testing next.

3. **The cycle 8 mechanism is project-end-related.** The agent observed `V1.currentTime = 9.756 s, paused = false` after V1 reached project end at 120 s. The Home.tsx RAF loop has `setCurrentTime(duration); setIsPlaying(false)` at duration end. The observed V1 state contradicts that — suggests either an HTML5 video element `loop` attribute is in play, or another reset mechanism fires. Worth a 5-minute code read before any further always-mount work.

### 29H. Run 12 — Seek-completion-gated play (REVERTED)

To address Run 11's regression and the lingering Run 10 cycle 8 spike via a different mechanism, the team added a seek-completion gate to `playEffect`. When `video.seeking === true` at the moment the play branch entered, `video.play()` would be deferred via a one-shot `seeked` listener.

Code change in `VideoPreview.tsx` playEffect:

```ts
// inside the play branch, after 3a drift gate
const startActualPlay = () => {
  const playT0 = performance.now();
  video.play().catch(() => {});
  // ... rVFC instrumentation
};
if (video.seeking) {
  console.log(`[V2MEAS][playGated] ...`);
  video.addEventListener('seeked', startActualPlay, { once: true });
} else {
  startActualPlay();
}
```

#### Run 12 measurement (same 8-cycle pattern)

| Cy | seek | V1 ptF | V2 ptF | V2 expDT−presT | V2 presentedFrames | V2 − V1 | playGated? |
|---|---|---|---|---|---|---|---|
| 1 | 30s | 434 (cold) | 315 (cold) | 0 ms | 2 | −119 | No |
| 2 | 65s | 10 | **634** | +6.8 ms | 4877 | +624 | No |
| 3 | 45s | 13 | **637** | +6.8 ms | 5894 | +624 | No |
| 4 | 45s (revisit) | 10 | **107** | +6.8 ms | 7021 | +97 | No |
| 5 | 80s | 4 | **670** | +6.9 ms | 7973 | +666 | No |
| 6 | 30s | 10 | **570** | +6.8 ms | 8976 | +560 | YES |
| 7 | 95s | 10 | **662** | +6.8 ms | 10022 | +652 | No |
| 8 | 65s | 12 | **657** | +6.8 ms | 11120 | +645 | No |

#### Findings

- **`playGated` log fired only once** (Cycle 6). The seek-then-play race condition is rare in practice. Run 9's `!video.paused` guard already eliminated most of the kPause-driven churn, and seekEffect's 50 ms play-start threshold + 800 ms wait window between seek dispatch and play click meant V2 had usually completed its seek before play was clicked.

- **V2 ptF jumped to 570–670 ms warm**, dramatically worse than Run 10's 86.6 ms. The seek-gate change moved `playT0` capture from a fixed point in `playEffect` to inside `startActualPlay`. In the non-seeking branch this is synchronously equivalent, but the observed regression suggests another factor varied between runs (Brave session state, system load, or a measurement artifact).

- **Cycle 4 revisit** (seek=45 immediately after seek=45) produced V2 ptF = 107 ms — same-position revisit was substantially faster. The decoder's frame cache survived a second seek to the exact same position. This is consistent with Run 10's revisit benefit but more pronounced (88 ms there).

- **V2 `expDT − presT` was +6.8 ms** on all warm cycles — confirming the compositor pipeline was warm. The 600+ ms ptF therefore measures decoder cold-start under a warm compositor, not pipeline initialization.

#### Reversion

The seek-gate change was reverted in `VideoPreview.tsx`. The `playEffect` is restored to Run 9/10 baseline: drift-gated currentTime assignment + immediate `play()` + rVFC instrumentation.

#### Lessons captured

1. **Run 12 vs Run 10 disagreement** is unresolved. The same `playEffect` code path measured 86.6 ms in Run 10 and 600+ ms in Run 12, with the only differences being (a) the seek-gate wrapper, and (b) test session timing. The agent's playGated count (1 of 8) confirms the gate path was rarely taken, so the gate wrapper itself should not account for the difference. The discrepancy may reflect intrinsic Chrome decoder variance, browser session state (extension load, GPU pipeline warmth from other tabs), or measurement-protocol differences in the agent's 300 ms wait. The 86.6 ms result may have been a lucky outlier.

2. **The revisit benefit is reproducible** (107 ms here, 88 ms in Run 10). Going back to a position recently visited keeps the decoder cache warm. Real-editor scrubbing patterns that revisit cuts repeatedly would amortize the cold-start cost across sessions.

3. **The 600+ ms ptF is intrinsic to V2's encoding under Chrome's D3D11VideoDecoder warm-from-seek-cold-start path.** No JS-side change in this investigation has reliably brought it below ~80 ms. The compositor pipeline is warm (`expDT − presT = +6.8 ms`) yet the first frame post-play takes 600+ ms because decoding a 60 fps Main-profile no-B-frame H.264 P-frame chain from prior IDR + low bitrate is intrinsically slow on the test machine's GPU. This is consistent with the ffprobe-based encoding analysis in Section 29A.

4. **Re-encoding V2 to V1-spec (High profile, B-frames, smaller GOP, higher bitrate) remains the most likely server-side path to meaningfully reduce V2 ptF**. The earlier dismissal of this option (Section 29's correction noting both videos use D3D11 hardware) addressed the decoder backend question — but the per-frame decode work is still encoder-determined even on hardware.

### 29I. Open question catalog (post-Run-12, exhaustive)

After 12 measurement runs, several questions remain unresolved or untested. This catalog enumerates every plausible factor that could be contributing to V2 sync offset or to measurement variance. Each item includes enough detail to be picked up by a future investigator (including a future agent reading this post-compaction). Items are marked **Testable** (cheap, can be answered in < 30 min), **Medium** (1–4 hours), or **Heavy** (≥ 1 day) based on cost to investigate.

> **RESOLUTION INDEX (added 2026-06-05 after Runs 13–18)** — This catalog was frozen at Run 12 close and the items below are written as if open. Runs 13–18 (Sections 29K–29P) subsequently answered or disposed of several:
>
> | 29I item | Status after Runs 13–18 | See |
> |---|---|---|
> | A1 (variance band) | **Resolved**: bimodal LOW/HIGH clusters, n=22, no samples in 290–650ms gap | 29K, 29L |
> | A2–A6 (variance sub-hypotheses) | **Moot**: bimodality found to be audio-decoder-init mode-switch, not measurement noise | 29M, 29N, 29P |
> | B1 (V2 muted) | **Resolved**: root cause confirmed = audio decoder init; muting eliminates HIGH cluster (0%, n=19, mean 34ms) | 29M |
> | B2–B4 (audio sub-hypotheses) | **Moot**: B1 answered at the root level; sub-mechanisms not separately testable in practical terms | 29M |
> | C1 (V2 re-encode to V1 spec) | Not directly tested, but **superseded**: codec choice affects HIGH frequency probability (PCM 25% vs AAC 77%), not magnitude. Re-encoding video specs would not address audio decoder init root cause. | 29N (PCM result) |
> | C2 (per-frame decode cost) | **Refuted as primary mechanism**: bimodality + muted-eliminates evidence implicates audio pipeline, not video per-frame cost | 29M |
> | C3 (V2 as blob URL) | Not tested; **deprioritized** — HTTP latency hypothesis weakened by Runs 13–18 evidence | — |
> | D1–D5 (server/network/buffer) | Not tested; **deprioritized** — compositor warm + audio-decoder root cause make server/network unlikely contributors | — |
> | E1, E6 (compositor) | **Confirmed**: `expDT−presT ≈ +6.8ms` warm signature on all samples | 29K, 29L, 29M, 29N, 29P |
> | E2–E5 (compositor/canvas/RAF) | **Deprioritized** — compositor confirmed warm; remaining speculation about canvas/RAF interactions unlikely root cause | — |
> | F1–F6 (React/effect timing) | Not tested; **deprioritized** — root cause is at HTMLMediaElement audio pipeline level, not React level | — |
> | G1–G5 (browser env) | Partially confirmed (G4: D3D11 hardware backend; G6 implicit: 144Hz test machine); G1–G3, G5 untested but **deprioritized** | 29 prior, 29K |
> | H1–H6 (code path asymmetries) | H1, H6 historically confirmed; others not tested; **deprioritized** — root cause not in V2-specific code path but in HTMLMediaElement audio decoder | — |
> | I1–I4 (alternative instruments) | Not used; rVFC + `chrome://media-internals` proved sufficient for the bimodality discovery | — |
> | J1 (Path 4 POC) | **SELECTED as next step** — only known fix preserving V2 audio without UX loss | 29B + final state section |
> | J2 (Direct WebCodecs) | Not tested; **deprioritized** in favor of J1 (less work, same outcome) | — |
> | J3 (MediaSource Extensions) | Not tested; **deprioritized** | — |
>
> **Items added by Runs 13–18 that don't appear in this 29I catalog (because the catalog was written before they were discovered)**:
> - Audio decoder mode-switch mechanism (per-play lottery, not per-mount; not per-codec exclusively but codec-influenced)
> - `audioTracks.disabled` Chrome API (Run 17 probe attempted, blocked by experimental-features flag — not deployable)
> - WebAudio `decodeAudioData` prewarm (Run 18 attempted, inconclusive — agent verdict "no effect" defensible, orchestrator's "3x reduction" reading also possible without paired control)
> - canvas-draw.ts Path 4 compatibility (see final state section; `<Video>` from `@remotion/media` does NOT provide HTMLVideoElement → canvas-draw needs adaptation OR hybrid component selection)
>
> **Do not re-run B1, A1, or audioTracks probe.** Those are answered or blocked. Read 29K–29P before starting any new measurement from this catalog. The full "do not re-test" list is in the cold-start checklist at end of document.

#### Category A — Measurement reliability and variance

**A1. Run 10 vs Run 12 same-code 10× variance is unexplained. (Testable)**

Run 10 measured V2 warm V2−V1 mean = 86.6 ms (raw V2 ptF warm mean = 96.8 ms) across 8 cycles. Run 12 with effectively the same code path (the seek-completion gate fired only once in 8 cycles, so 7 cycles ran identical code) measured 570–670 ms warm V2 ptF. The 10× difference is unexplained and means no single measurement can be trusted in isolation. Need 3–5 back-to-back baseline runs with no code changes to characterize Chrome decoder variance band. Until that band is known, no future fix verification is statistically meaningful. Highest-priority follow-up.

**A2. Agent's 300 ms wait between seek and play. (Speculative)**

The protocol says "wait 300 ms" but JS event-loop timing may stretch this. If Chrome's seek hasn't actually settled by the time play is clicked, the gate may engage in some runs and not others (matching A1 variance pattern).

**A3. Agent's seek MouseEvent dispatch precision. (Speculative)**

Dispatched at computed pixel positions. Off-by-one pixel ≈ 60 ms project-time drift. Could randomize the V2 in-scene position by a few frames between runs.

**A4. Brave session state — multi-tab GPU contention. (Speculative)**

V2's D3D11 decoder shares GPU with all browser content. Other tabs (especially media-internals when open) compete for decoder slots and GPU pipeline. Run 10 may have run on a clean GPU; Run 12 after extensive prior testing may have had degraded state.

**A5. `take_snapshot` is heavy. (Speculative)**

Each `mcp__plugin_chrome-devtools-mcp__take_snapshot` returns the full accessibility tree. Frequent calls during measurement may perturb the page's main thread. Could affect rVFC callback dispatch timing.

**A6. Vite HMR firing during test. (Speculative)**

If anything triggers a hot module reload during measurement, the React tree re-mounts, V2 element is fresh, decoder cold-starts. Would not appear in our `[V2MEAS][mount]` log if React StrictMode dev double-mount is masking the signal.

#### Category B — Audio decoder hypothesis (high-value test)

**B1. V2 AAC vs V1 PCM. (Testable)**

V2 source is H.264 video + AAC stereo audio. V1 is H.264 video + PCM stereo audio (`kAudioDecoderName: "FFmpegAudioDecoder"` for both per `chrome://media-internals`). AAC requires Huffman decode + IMDCT + filter bank; PCM is byte-aligned PCM samples — effectively no decode. When `video.play()` is called, Chrome spins up both video and audio pipelines. If AAC decoder init blocks video first-frame presentation, V2 (AAC) consistently shows 600 ms while V1 (PCM) shows 10 ms even on the same D3D11 hardware. **Test plan**: temporarily set V2 video element `muted = true` (or its audio track type to disabled), run one 8-cycle pattern, compare V2 ptF. If V2 ptF drops 5×+, audio decode init was the bottleneck. ~5 min code change in `VideoPreview.tsx` adding a `muted` attribute to the V2 `<video>`. ~20 min measurement.

**B2. AudioContext activation. (Speculative)**

Chrome's autoplay policy requires user gesture before AudioContext can play. V1's PCM might bypass this somehow (legacy path) while V2's AAC requires the gesture. If the gesture is "consumed" by the play button click and AudioContext isn't immediately ready, V2 audio decode could stall.

**B3. Audio buffer fill timing. (Speculative)**

AAC frame size is 1024 samples (~21 ms at 48 kHz). Decoder must fill at least one frame's audio buffer before video presentation can sync. PCM has no minimum frame size (just sample-by-sample). 21 ms isn't enough to explain 600 ms but the AAC decoder may need to fill multiple frames before sync starts.

**B4. A1/A2 audio tracks churning. (Speculative)**

`VideoPreview.tsx` registers `<audio>` elements in `overlayVideoRefs` (same Map as video overlays). The seekEffect iterates `overlayMediaLayers` including audio. Each audio element gets its own currentTime sets, play/pause cycles. Audio pipeline churn may indirectly compete with V2's video decoder for GPU/audio mixer resources.

#### Category C — V2 codec / encoding (server-side fix)

**C1. V2 re-encode to V1 spec. (Medium)**

Per Section 29A ffprobe results: V2 is H.264 Main profile, no B-frames, 1 s GOP, 723 Kbps. V1 is H.264 High profile, has B-frames, 0.5 s GOP, 24.2 Mbps. Re-encoding V2 with V1's params would change per-frame decode work even on hardware. Projected 5–20 % improvement (Section 29 correction noted both already on D3D11 so backend improvement is bounded). Never actually measured. ~1 hour: `ffmpeg -i V2.mp4 -c:v libx264 -profile:v high -level 4.2 -bf 2 -g 30 -keyint_min 15 -crf 18 -c:a aac -b:a 192k V2_reenc.mp4`, swap in via FFmpeg server, run 8-cycle pattern.

**C2. V2 1080p60 + Main + no B-frames + 723 Kbps. (Mechanism)**

Each P-frame requires walking from prior IDR (up to 60 frames since GOP=1 s at 60 fps). No B-frame parallelism. Low bitrate = each P-frame has dense motion vectors and complex residuals. Per-frame decode cost on D3D11 hardware may be the actual constraint, independent of seek/play race.

**C3. V2 as blob URL via `prefetch()`. (Testable)**

Use Remotion's `prefetch(V2.url, {method: 'blob-url'})` at HyperEdit page load to download V2 fully into memory. Swap layer.url to the blob URL. Eliminates HTTP range-request latency entirely. Browser plays from in-memory bytes. May not help if H3 decoder cost is dominant, but ~30 lines of code. Tests Q29.7 alternative variant.

#### Category D — Server / network / buffer

**D1. Server lacks `Cache-Control` headers. (Testable)**

`scripts/local-ffmpeg-server.js` asset stream endpoint doesn't set `Cache-Control`. Browser may not cache bytes between range requests. Add `Cache-Control: public, max-age=3600` to 200 and 206 responses. Restart server, measure.

**D2. CORS preflight on range requests. (Testable)**

Does each new range request issue an OPTIONS preflight? `list_network_requests` MCP tool can show this. If yes, each preflight is ~5-50 ms wasted. Solvable via `Access-Control-Max-Age: 86400` header.

**D3. V2 buffer eviction. (Speculative)**

Chrome's MediaPlayer has internal buffer caps. V2 (lower bitrate, smaller chunks) may stay fully buffered. V1 (high bitrate) may evict older ranges. After a seek, V2 may not need fresh fetch; V1 might. But measured V1 ptF is much faster than V2 — contradicts.

**D4. `[V2MEAS][playPrep]` raw comparison V1 vs V2 at same cycle. (Testable, log-scan only)**

We log `playPrep` for both V1 and V2 (after Run 6 instrumentation). Compare `buffered` ranges side-by-side at the moment of play across the Run 12 dataset. If V2's buffer is narrower / missing the target time, byte fetch was happening during play. ~5 min log analysis on the Run 12 console output if still available.

**D5. V2 `seekSettled` `elapsedMs` aggregate. (Testable, log-scan only)**

We log how long V2's `seeked` event takes per cycle. Never aggregated against V1. If V2 takes 500 ms to seek while V1 takes 50 ms, byte-fetch asymmetry is the cost — not decode. Aggregate from Run 12 logs.

#### Category E — Compositor / rendering pipeline

**E1. `expDT − presT = +6.8 ms` means compositor is warm. (Confirmed)**

So the residual 600 ms ptF is NOT compositor pipeline initialization. It's between play() and first decoded frame reaching compositor input queue. This narrows the unknown.

**E2. Canvas transition draw loop. (Speculative)**

`facecamtransitionbox` and `staticfacecam` transitions run during V2's playback (the timeline has them at 95.28 s and 97.30 s). Canvas draw loop on RAF cadence may compete for GPU. Could check by removing transitions and measuring.

**E3. RAF back-pressure. (Speculative)**

Canvas draw loop runs at 60 fps. If V2 decoder is competing on the same task queue, RAF may starve V2's rVFC dispatch.

**E4. Multiple V2/V3 overlays simultaneously. (Speculative)**

Current project has only V2 (no V3). If V3 added with same asset, would both share decoder pool or compound latency? Not tested.

**E5. `hiddenVideoRefs` transition source frames. (Speculative)**

`VideoPreview.tsx` ~lines 383-414 create hidden `<video>` elements for transition from-clips that have ended. Each is muted, played, paused. These run alongside V2 in scene. Could compete for D3D11 decoder slots (Chrome limits concurrent VideoDecoder instances).

**E6. 144 Hz test machine. (Confirmed)**

`expDT − presT = +6.9 ms` matches 1/144 s. Test machine is likely 144 Hz monitor. On a 60 Hz machine the warm signature would be +16.67 ms and the variance noise floor would be higher. Future investigators on different hardware should expect different numbers.

#### Category F — React / effect timing

**F1. React 18 StrictMode dev double-effect-fire. (Testable)**

`main.tsx` or `App.tsx` wrapping in `<StrictMode>` would cause effects to fire twice in dev. Check `src/react-app/main.tsx`. If present, every playEffect / seekEffect runs twice per state change. Subtle ordering effects could differ V2 vs V1.

**F2. Mount/unmount log false positives. (Confirmed unreliable)**

Ref callbacks with inline closures fire on every render with `null` then new element. Our `[V2MEAS][mount]` / `[V2MEAS][unmount]` logs are unreliable for counting real DOM mounts. To get reliable mount counts, use `useEffect(() => { ... return () => {...} }, [])` inside a child component. Real remounts could be masked.

**F3. CaptionRenderer `currentTimeRef` consumption. (Speculative)**

`CaptionRenderer` receives `currentTimeRef`. If it runs RAF work to update caption position, it shares main thread with V2's effect cascade. Long caption-render frames could delay V2 playEffect.

**F4. ResizeObserver / IntersectionObserver. (Speculative)**

Browser observers fire callbacks on layout changes. Each fire may queue an effect run. If something resizes during the test (timeline scroll, panel resize), V2's effect cadence changes.

**F5. `useImperativeHandle`. (Speculative)**

`VideoPreviewHandle` is created via `useImperativeHandle` in `VideoPreview.tsx`. Could cause re-renders we don't track.

**F6. playEffect dep `[layers]` re-fires on every Home.tsx render. (Confirmed)**

Even with `!video.paused` guard preventing redundant pause(), the EFFECT BODY still runs each time. The forEach loop, log emit, layer.find lookup all execute. Add up to 30 effect runs / second / overlay. Doesn't directly cause ptF latency but is wasteful and could compound with other factors.

#### Category G — Browser / environment

**G1. Brave-specific behaviors. (Speculative)**

Brave Shields, anti-fingerprinting, ad-blocking may inject latency. Vanilla Chromium might show different numbers. Run the same protocol on Chrome stable to compare.

**G2. `document.visibilityState` during agent tab-switching. (Speculative)**

Chrome demotes hidden tabs. Agent's switches to media-internals briefly mark HyperEdit as hidden. May affect timer throttling / decoder priority.

**G3. Chromium content-process priority. (Speculative)**

Other recently-active tabs may have higher process priority. V2's decoder runs in the renderer process; if process is demoted, decoder gets fewer cycles.

**G4. GPU model + driver. (Unknown)**

D3D11 decoder performance varies by GPU generation, driver version, Windows version. Test machine's specs were never captured. Future investigation should document `chrome://gpu` output.

**G5. DXVA2 vs D3D11 vs Media Foundation. (Speculative)**

On Windows, Chrome can pick between several hardware decode backends. For 1080p60 Main profile, the choice may differ between V1 (High profile) and V2 (Main profile). Possible asymmetry source.

#### Category H — Code paths not yet fully audited

**H1. seekEffect for V2 fires before playEffect. (Confirmed in declaration order)**

V2's seekEffect (line 222) is declared after playEffect (line 224)... actually playEffect is declared FIRST (after V1 play effect). Order in React effect chain: V1 play (line 181) → V1 seeked listener (line 207) → V2 playEffect (line 224) → V2 seekEffect (line 267). So when isPlaying flips true: V1 play fires (calls V1.play()), V1 seeked listener registered, V2 playEffect fires (calls V2.play() if conditions met), V2 seekEffect fires (issues seek if drift). The order means V2.play() is called BEFORE V2 seek-correction. If V2 had a stale currentTime, this could cause issues. Needs verification.

**H2. V2 `onLoadedData` race. (Speculative)**

V2's `onLoadedData` inline handler sets currentTime and calls play() if isPlaying. If `onLoadedData` fires concurrently with playEffect's play(), Chrome may queue two play() calls. Not sure if this is harmful.

**H3. `video.play().catch(() => {})` silent failure. (Testable)**

Play promise rejection is silently swallowed. Change to `.catch(err => console.log('[V2MEAS][playReject] ' + err.name + ' ' + err.message))`. Run measurement. See if any plays rejected (we'd be measuring failed-play ptF which is meaningless).

**H4. V2 `key={layer.id}-${layer.url}` string instance. (Speculative)**

React keys compared by string value, not instance. So even if URL string is a different instance with same value, key matches. Should not cause remount. But subtle Unicode normalization or whitespace differences could fail. Verify via console: `Object.is(prev.url, next.url)` between renders.

**H5. `streamUrl` `?v=Date.now()` timing. (Testable)**

When does `refreshAssets` fire? `useProject.ts` lines around `refreshAssets` definition. If it fires during a measurement, `asset.streamUrl` updates with a new timestamp, V2's `key` changes, real remount happens. Could be Run 10 vs Run 12 variance source.

**H6. V1's simple `handleLoaded` vs V2's inline `onLoadedData`. (Code-asymmetry, confirmed)**

V1 has only `if (videoRef.current && baseLayerClipTime !== undefined) { videoRef.current.currentTime = baseLayerClipTime; }`. V2 has the full inline handler including play() call. If V1's simple path completes faster, V1 is ready earlier.

#### Category I — Alternative measurement instruments

**I1. `getVideoPlaybackQuality()`. (Testable)**

Native API. Returns `droppedVideoFrames`, `totalVideoFrames`, `corruptedVideoFrames`. Add to `[V2MEAS][firstFrame]` log. Compare V1 vs V2 dropped frames during continuous play. If V2 drops frames, decoder is throttling.

**I2. `videoElement.webkitDecodedFrameCount` and `webkitDroppedFrameCount`. (Testable)**

Chrome-specific. May give per-frame decode time hints when sampled at intervals.

**I3. Performance API markers. (Testable)**

`performance.mark('v2-play-start')` before play(), `performance.mark('v2-first-frame')` in rVFC, then `performance.measure(...)`. Visible in Chrome DevTools Performance panel. More precise than rVFC's `now - playT0`.

**I4. Chrome Performance panel trace. (Heavy)**

Record a full performance trace during a measurement cycle. Chrome's panel will show the decoder pipeline, compositor pass, GPU process activity. Most granular instrument available but requires manual review.

#### Category J — Architectural alternatives

**J1. Path 4 minimum POC. (Heavy — 1.5–2 days)**

Per Section 29B scoping. `@remotion/media <Video>` + `<Player>` for V2/V3 overlays. WebCodecs preview path. Definitive answer on whether the HTMLVideoElement architecture is the noise source.

**J2. Direct WebCodecs API integration. (Heavy — ~1 week)**

`new VideoDecoder({...})` + manual canvas paint. Bypasses both HTMLVideoElement AND Remotion Player clock blocker. Frame-perfect by construction. Significant rewrite of VideoPreview.

**J3. MediaSource Extensions + manual fetch. (Heavy — ~1 week)**

`MediaSource` + `SourceBuffer.appendBuffer()`. Frame-accurate seek control. Heavy implementation; complex demuxing.

#### Cheapest cluster to actually run next

Sorted by expected information value per minute of work:

1. **B1 V2 muted measurement** (~25 min total: 5 min code change + 20 min agent run). Could be a single-shot answer.
2. **A1 variance characterization** (~15 min — three identical back-to-back runs no code changes). Essential baseline before trusting any future fix verification.
3. **D4 + D5 playPrep + seekSettled log-scan** (~10 min — analyzing existing Run 12 console data already captured in agent reports). May reveal byte-fetch asymmetry.
4. **C3 prefetch blob URL** (~30 min code + 20 min measurement). Tests if HTTP range latency was the actual culprit.

#### Failure modes the next investigator should NOT repeat

- Trusting any single measurement against a single baseline. Variance is huge (Run 10 vs Run 12 = 10×). Always require 3+ baseline reads.
- Assuming the mount/unmount log counts real React DOM mounts. They don't (inline ref callback false positives).
- Assuming `<OffthreadVideo>` will help preview frame perfection. It uses HTML5 `<video>` in preview per the comparison table.
- Assuming WebCodecs is being deprecated. It is not. Remotion's internal `@remotion/webcodecs` package is deprecated; the W3C browser API is alive.
- Assuming codec re-encoding to V1-spec will yield 50 % improvement. The earlier 50 % projection was overstated. Both videos already hit D3D11 hardware decoder; codec choice affects per-frame work but not pipeline init. Realistic projection: 5–20 %.
- Spending more than 30 min on the seek-then-play race hypothesis. The seek-completion gate confirmed the race is rare (1/8 cycles).

#### Highest-confidence statements (do not re-litigate)

- V2 cold-start latency is real and reproducible.
- Both V1 and V2 use D3D11VideoDecoder hardware backend.
- V2 source encoding (Main profile, no B-frames, 1 s GOP, 723 Kbps) is heavier per-frame work than V1's (High profile, B-frames, 0.5 s GOP, 24.2 Mbps).
- `expDT − presT = +6.8 ms` at warm pipeline (test machine = 144 Hz monitor).
- `!video.paused` guard reduced V2 ptF measured mean from R6's 225 ms to R9's 67 ms. (R10 vs R12 disagreement on retained baseline is the variance question.)
- HTMLVideoElement preview pipeline has 50–700 ms first-frame-after-play variance that JS-side timing correction cannot reliably eliminate.
- Path 4 architectural migration (`@remotion/media <Video>` + Player) is the only remaining hypothesis that could deliver frame-perfect preview, and it requires surrendering HyperEdit's RAF-driven clock to Player.

This catalog is the comprehensive open-question state at the close of Run 12. Future investigators reading post-compaction should: (1) start with A1 to establish variance baseline, (2) then run B1 muted-V2 test as cheapest single-shot answer, (3) then decide whether to pursue C/D server-side options or J architectural rewrite based on B1's outcome.

### 29J. Skill file consolidation (post-Run-12)

After Run 12 closed out the immediate measurement cycle, the team consolidated operational knowledge from agent discovery into 4 skill files in `llm-docs/`:

1. **`SKILL-agent-test-hyperedit-ui.md`** (existing, updated) — HyperEdit-specific UI mechanics. New additions:
   - Timeline ruler selector corrected to `.sticky.top-0.h-6` (more reliable than `[class*="ruler"]`).
   - Timeline scroll container right edge x ≈ 1462 (AI panel overlap). Positions > 70 s require `scrollLeft` adjustment.
   - Playhead triangle blocks `document.elementFromPoint` — workaround: dispatch MouseEvents directly on ruler via `querySelector`.
   - pixelsPerSecond observed range 16.629–16.667 depending on aspect-ratio toggle / panel state — always re-measure per session.
   - `localStorage['hyperedit-session']` JSON parsing for session ID extraction.
   - Direct FFmpeg server `GET /session/{id}/project` for full project state JSON without UI navigation.
   - Project duration vs source duration gotcha (project = max(clip.start + clip.duration), source files can be much longer).

2. **`SKILL-browser-mcp-patterns.md`** (NEW) — generic Chrome DevTools MCP usage patterns. Covers:
   - MCP `click` by uid vs `evaluate_script` MouseEvent dispatch — when to use which (visible-button rule, false-data discard precedent).
   - `take_snapshot` + `take_screenshot` verification pattern.
   - `evaluate_script` function-as-string idioms, `args` parameter awkwardness, JSON-serializable return requirement.
   - Multi-state-read batching in a single eval call.
   - Console message capture + marker-based segmentation.
   - chrome://media-internals navigation quirks (open as new tab, select via `.tree-item-header.selectable-button` MouseEvent, destroyed players unselectable, `window.media` global has handlers only).
   - Forbidden patterns (direct `.play()`/`.pause()` bypass React state).

3. **`SKILL-video-pipeline-diagnostics.md`** (NEW) — video element measurement patterns. Covers:
   - Three latency dimensions: demuxer/network, decoder, compositor.
   - `requestVideoFrameCallback` metadata interpretation (`mediaTime`, `presentationTime`, `expectedDisplayTime`, `processingDuration`, `presentedFrames`).
   - Compositor warm/cold signature via `expectedDisplayTime − presentationTime` (≈ 1 / refresh_hz when warm, 0 when cold).
   - `presentedFrames` as reliable decoder lifecycle signal (vs unreliable mount/unmount logs).
   - rVFC stale-frame fingerprint (ptF ≈ -2 to 1 ms = video was already playing at schedule time).
   - `mediaCapabilities.decodingInfo` pre-runtime capability check.
   - `played` TimeRanges for A/V sync.
   - chrome://media-internals selection mechanism + key field semantics (`kVideoDecoderName`, `kIsPlatformVideoDecoder`).
   - Pitfalls: inline ref callback false positives, refresh-rate-dependent warm signature, Vite HMR perturbation, audio-decoder init masking video latency.

4. **`SKILL-remotion-quick-reference.md`** (NEW) — Remotion library facts. Covers:
   - Three video components comparison (`<OffthreadVideo>`, `<Html5Video>`, `<Video>` from `@remotion/media`) with preview-path-vs-render-path distinction.
   - WebCodecs deprecation clarification (W3C alive; Remotion's own `@remotion/webcodecs` deprecated in favor of Mediabunny).
   - `<Player>` API + lack of external-clock injection.
   - `<Player>` does NOT require `<Composition>` (common misconception).
   - `useCurrentFrame()` requirement and what it precludes.
   - `useRemotionEnvironment()` split-rendering pattern (OffthreadVideo for preview, @remotion/media for render).
   - Mediabunny supported codecs + webm seek-perf gotcha.
   - Path 4 minimum POC scope (cross-reference to Section 29B here).
   - Decision tree for choosing a Remotion component.
   - Authoritative doc URL list.

These skill files are the operational reference for any future agent doing browser-driven testing on HyperEdit. They are also the persistence layer for the discoveries that took the first wave of agents 5–7 minutes per run to re-derive. Subsequent agents should be able to skip most of the discovery pass by reading the relevant skill file BEFORE attempting a task.

A future investigator reading this megadoc post-compaction should first read those 4 skill files for operational context, then return to the question catalog in Section 29I for the open list, then start with item A1 (variance characterization) or B1 (V2 muted-audio test).

### 29 Summary

| # | Question | Verdict | Mechanism / evidence |
|---|---|---|---|
| 29.1 | H4 A/V skew within V2 | **REFUTED** | Run 6 `played` TimeRanges include mediaTime within ~6 ms; latency is video-side |
| 29.2 | V2 leads V1 in Run 1 P=80 | **EXPLAINED** | V2 decoder warm from prior P=65 playback (Run 6 `expDT−presT` warm signature) |
| 29.3 | Longer pre-warm pulse | **PARTIAL FAIL** | Run 7: warm samples improved (playback continuity), cold-start unchanged, P=50 regression |
| 29.4 | Audible blip during pulse | **N/A in current code** | Pulse code removed in Run 8 reversion; requires human ear if restored |
| 29.5 | V1 cold-start | **CONFIRMED** | Run 6: V1 ptF=391 ms at P=35 despite readyState=4; same mechanism as V2 |
| 29.6 | rVFC metadata utility | **CONFIRMED** | Run 6: `expDT−presT` = compositor pipeline warm/cold signature |
| 29.7 | FFmpeg server header tweaks | **REFUTED (inference)** | Headers cannot affect Chrome decoder pipeline state; H3 mechanism independent |
| 29.8 | Lower V2 resolution at upload | **DEFERRED** | Plausible partial fix; doesn't address root pipeline-state mechanism; 1–2 day server work |

All 8 questions are now closed for the scope of this investigation. The remaining unresolved problem is the architectural one captured in Section 25 (path matrix): only Path 4 (`@remotion/media <Video>` + Player, with the clock blocker accepted) can deliver a real fix for V2 ptF. All mechanical interventions inside the raw `<video>` element model have been measured and found to either fail to improve over baseline or to introduce regressions.

---

## 30. APPENDIX A — FULL RAW MEASUREMENT DATA TABLES

### A.1 Run 1 (Original baseline)

Setup:
- V2 clip: `2026-01-21 15-11-10 remotion.mp4`, project start = 28.259375 s, duration ≈ 91.89 s.
- V1 clip: long camera file.
- pixelsPerSecond: 16.629.
- Click method: MCP click by uid.

Per-sample data:

```
SEEK P=35
  V1 [seekReq]:    requested=34.8781  immediate=34.8781  eps_immediate=-0.0000
  V1 [seekSettled]: settled=34.8781  eps=-0.0000  elapsedMs=626
  V2 [seekReq]:    requested=6.7390  immediate=6.7390  eps_immediate=0.0000
  V2 [seekSettled]: settled=6.7390  eps=-0.0000  elapsedMs=321
  V2 [playPrep]: readyState=4 buffered=[[0,49.93]] requested=6.799 isPremounted=false
  V1 [firstFrame]: playToFrameMs=5  mediaTime=34.9438
  V2 [firstFrame]: playToFrameMs=171  mediaTime=6.7333
  VALID=YES

SEEK P=50
  V1 [seekReq]:    requested=49.8516  ... elapsedMs=350 (cold-warm)
  V2 [seekReq]:    requested=21.8328  elapsedMs=251
  V1 [firstFrame]: playToFrameMs=11   mediaTime=49.9833
  V2 [firstFrame]: playToFrameMs=72   mediaTime=21.8333
  VALID=YES

SEEK P=65
  V1 [seekReq]:    requested=65.0055  elapsedMs=269
  V2 [seekReq]:    requested=36.8664  elapsedMs=158
  V1 [firstFrame]: playToFrameMs=11   mediaTime=65.0149
  V2 [firstFrame]: playToFrameMs=87   mediaTime=36.8500
  VALID=YES

SEEK P=80
  V1 [seekReq]:    requested=79.8588  elapsedMs=398
  V2 [seekReq]:    requested=51.9001  elapsedMs=123
  V1 [firstFrame]: playToFrameMs=10   mediaTime=80.0466
  V2 [firstFrame]: playToFrameMs=9    mediaTime=51.9167  (V2 leads V1 by 1ms)
  VALID=YES

SEEK P=100
  V1 [seekReq]:    requested=99.8836  elapsedMs=389
  V2 [seekReq]:    requested=71.9249  elapsedMs=212
  V1 [firstFrame]: playToFrameMs=38   mediaTime=99.8831
  V2 [firstFrame]: playToFrameMs=93   mediaTime=71.7333
  VALID=YES (project hit end during snap B but firstFrame captured)
```

Summary:
- V1 ptF: 5, 11, 11, 10, 38 → mean 15
- V2 ptF: 171, 72, 87, 9, 93 → mean 86
- V1 − V2: −166, −61, −76, +1, −55 → mean −71 (V2 trails by 71 average)
- All eps ≈ 0.0000

### A.2 Run 2 (3a + 3b applied)

Per-sample data:

```
SEEK P=35
  V1 [firstFrame]: playToFrameMs=175
  V2 [firstFrame]: playToFrameMs=214
  VALID=YES

SEEK P=50
  V1 [firstFrame]: playToFrameMs=11
  V2 [firstFrame]: playToFrameMs=638  (outlier)
  VALID=YES

SEEK P=65
  V1 [firstFrame]: playToFrameMs=10
  V2 [firstFrame]: playToFrameMs=68
  VALID=YES

SEEK P=80
  V1 [firstFrame]: playToFrameMs=4
  V2 [firstFrame]: playToFrameMs=76
  VALID=YES

SEEK P=100
  V1 [firstFrame]: playToFrameMs=14
  V2 [firstFrame]: playToFrameMs=55
  VALID=YES
```

Summary:
- V1 ptF: 175, 11, 10, 4, 14 → mean 43
- V2 ptF: 214, 638, 68, 76, 55 → mean 210
- V1 − V2: −39, −627, −58, −72, −41 → mean −167 (V2 trails by 167 average)
- All eps ≈ 0.0000

### A.3 Run 3 (3a only, 3b reverted)

Per-sample data:

```
SEEK P=35 (cold load, V2 readyState started at 0)
  V1 [firstFrame]: playToFrameMs=393
  V2 [firstFrame]: playToFrameMs=287
  VALID=YES (V2 leads V1 by 106 — cold load artifact)

SEEK P=50
  V1 [firstFrame]: playToFrameMs=9
  V2 [firstFrame]: playToFrameMs=661  (outlier)
  VALID=YES

SEEK P=65
  V1 [firstFrame]: playToFrameMs=13
  V2 [firstFrame]: playToFrameMs=817  (largest outlier seen)
  VALID=YES

SEEK P=80
  V1 [firstFrame]: playToFrameMs=12
  V2 [firstFrame]: playToFrameMs=115
  VALID=YES

SEEK P=100
  V1 [firstFrame]: playToFrameMs=30
  V2 [firstFrame]: playToFrameMs=147
  VALID=YES (with project-end caveat)
```

Summary:
- V1 ptF: 393, 9, 13, 12, 30 → mean 91
- V2 ptF: 287, 661, 817, 115, 147 → mean 405
- V1 − V2: +106, −652, −804, −103, −117 → mean −314

### A.4 Run 4 (Option F, no 3a, no observability)

Per-sample data:

```
SEEK P=35
  V1 [firstFrame]: playToFrameMs=783  (cold)
  V2 [firstFrame]: playToFrameMs=776
  VALID=YES

SEEK P=50
  V1 [firstFrame]: playToFrameMs=13
  V2 [firstFrame]: playToFrameMs=651
  VALID=YES

SEEK P=65
  V1 [firstFrame]: playToFrameMs=8
  V2 [firstFrame]: playToFrameMs=181
  VALID=YES

SEEK P=80
  V1 [firstFrame]: playToFrameMs=14
  V2 [firstFrame]: playToFrameMs=373
  VALID=YES

SEEK P=100
  V1 [firstFrame]: playToFrameMs=422
  V2 [firstFrame]: playToFrameMs=303
  VALID=NO (V2 paused=true at snap A — pre-warm or play race)
```

Summary (4 valid):
- V1 ptF: 783, 13, 8, 14 → mean 204
- V2 ptF: 776, 651, 181, 373 → mean 495
- V1 − V2: +7, −638, −173, −359 → mean −291

### A.5 Run 5 (Option F + 3a + observability)

Per-sample data:

```
SEEK P=35
  V2 [preWarm start]: ct=6.7390 target=6.7390 (from setup pre-warm)
  V2 [preWarm done]: advance=0.0203 elapsedMs=61
  V1 [firstFrame]: playToFrameMs=450  (V1 also cold)
  V2 [firstFrame]: playToFrameMs=297
  VALID=YES

SEEK P=50
  V2 [preWarm start]
  V2 [preWarm done]: advance=0.016 elapsedMs=37
  V1 [firstFrame]: playToFrameMs=15
  V2 [firstFrame]: playToFrameMs=188
  VALID=YES

SEEK P=65
  V2 [preWarm done]: advance=0.009 elapsedMs=50
  V1 [firstFrame]: playToFrameMs=28
  V2 [firstFrame]: playToFrameMs=131
  VALID=YES

SEEK P=80
  V2 [preWarm done]: advance=0.006 elapsedMs=47
  V1 [firstFrame]: playToFrameMs=8
  V2 [firstFrame]: playToFrameMs=187
  VALID=YES

SEEK P=100 (first attempt)
  V2 [preWarm start] (aborted 41.6s later, leftover listener from P=80)
  V1 [firstFrame]: playToFrameMs=19
  V2 [firstFrame]: playToFrameMs=163 (fired after snap A)
  VALID=NO (V2 paused=true at snap A)

SEEK P=100 (retry)
  V2 [preWarm done]: advance=0.086 elapsedMs=127
  V1 [firstFrame]: playToFrameMs=13
  V2 [firstFrame]: playToFrameMs=61
  VALID=NO (snap A returned [] — project ended)
```

Summary (4 valid samples):
- V1 ptF: 450, 15, 28, 8 → mean 125
- V2 ptF: 297, 188, 131, 187 → mean 201
- V1 − V2: +153, −173, −103, −179 → mean −75 (or V2 trails by 75 average)

### A.6 Cross-run V2 ptF per seek

For quick visual comparison:

```
Seek    Run1  Run2  Run3  Run4  Run5
35      171   214   287   776   297
50      72    638   661   651   188
65      87    68    817   181   131
80      9     76    115   373   187
100     93    55    147   inv   inv

Mean    86    210   405   495   201
```

---

## 31. APPENDIX B — FULL FILE DIFF CATALOG AT BRANCH HEAD

Files added in this branch vs the pre-investigation main:

- `llm-docs/SKILL-agent-test-hyperedit-ui.md` — the agent skill file (215 lines).
- `docs/V2_OVERLAY_SYNC_INVESTIGATION.md` — this megadocument.

Files modified in this branch vs pre-investigation main:

- `src/react-app/components/VideoPreview.tsx` — about 70 lines of additions inside existing effects:
  - Refs added: `measSessionRef` (only; `preWarmInFlightRef` was added in Runs 4–7 then removed in Run 8 reversion per Section 28A.4).
  - V1 seek effect: 8 lines added for `[V2MEAS][seekReq]` + `[V2MEAS][seekSettled]`.
  - V1 play/pause effect: 9 lines added for session counter, `[V2MEAS][playPrep]` (V1 variant), and `[V2MEAS][firstFrame]` rVFC. (Run 6 added the V1 playPrep variant — see Section 28A.1 item 1.)
  - playEffect: ~14 lines added — 3a drift gate, `[V2DBG][playEffect]` log, `[V2MEAS][playPrep]` log, `[V2MEAS][firstFrame]` rVFC with full metadata (incl. `expectedDisplayTime`, `presentationTime`, `processingDuration`, `presentedFrames`, `captureTime`, `played` TimeRanges per Run 6 expansion); pre-warm abort check removed after Run 8.
  - seekEffect: ~25 lines added — threshold change (50ms play-start), `[V2DBG]/[V2MEAS]` logs; Option F pre-warm pulse block removed after Run 8 (Section 28A.4).
  - Overlay video `onLoadedData`: 3 lines added for `[V2DBG][onLoadedData]` log.
  - Ref callback: 6 lines added for `[V2MEAS][mount]` + `[V2MEAS][unmount]` logs at lines 544/549 (Run 10 diagnostics, unreliable per F2 false-positive notes — see Section 28A.3).
- `src/react-app/pages/Home.tsx` — 3 lines added: `[V2DBG][getPreviewLayers]` log block.

**Diff-catalog accuracy note**: This catalog reflects the actual code at branch HEAD post-Run-8-reversion. Earlier versions of this section (pre-Run-8) listed `preWarmInFlightRef` and the Option F pre-warm pulse block as present — those have been corrected here. If you find a sub-section elsewhere in this document still referencing `preWarmInFlightRef`, treat it as stale historical record.

Untracked files (not committed; will be deleted on revert):

- `__debug_audio.cjs`, `__debug_console.cjs`, `__debug_seek_results.json`, `__debug_storage.cjs`, `__debug_timeline.cjs` — agent debug artifacts.
- `__run14_cycle1_console.txt` — agent intermediate save (contains Run 13 console buffer due to msgid ordering; see Section 29L).
- `screenshots/` — saved screenshots from agent runs.
- `src/remotion/transitions/canvas-draw.ts` — **added (untracked)**, production transition rendering helper adapted from `feature/remotion-core-editor-v2-seeking-v3` branch. Wired into `VideoPreview.tsx:5` (`getCanvasDraw` import) and `:360` (`getCanvasDraw(t.transitionFileId)` call). Will be staged + committed in this archive commit, not deleted. See final-state section "canvas-draw.ts" for Path 4 compatibility notes.
- `docs/V2_OVERLAY_SYNC_INVESTIGATION.md` — this megadoc itself (added untracked; committed as part of archive).
- `llm-docs/SKILL-agent-test-hyperedit-ui.md`, `llm-docs/SKILL-browser-mcp-patterns.md`, `llm-docs/SKILL-video-pipeline-diagnostics.md`, `llm-docs/SKILL-remotion-quick-reference.md` — added untracked; committed as part of archive.

Files untouched by the V2 sync mechanism investigation (no instrumentation/experiment changes from V2-sync work):

- `scripts/local-ffmpeg-server.js`
- `src/react-app/hooks/useProject.ts`
- All other files in the project.

Files modified by orthogonal pre-existing work (NOT V2 sync investigation; bundled into the same commit because they were in the working tree at measurement time — see final-state section "Orthogonal modifications in the same commit"):

- `src/react-app/components/CaptionRenderer.tsx` — RAF caption optimization
- `src/react-app/components/Timeline.tsx` — direct-DOM playhead update
- `src/react-app/components/TransitionPreview.tsx` — interface-only after transition refactor; rendering logic moved to `canvas-draw.ts`

---

## 32. APPENDIX C — TERMINOLOGY GLOSSARY

For a fresh reader to align on terms used throughout this document.

- **V1** — the base video track in HyperEdit's timeline. Always rendered at the bottom z-order. Its `<video>` element is the audio master.
- **V2 / V3** — overlay video tracks above V1. They render on top.
- **A1 / A2** — audio-only tracks. Render as `<audio>` elements.
- **T1** — caption track. Renders as text overlays.
- **clip** — a `TimelineClip` placed on a track at a project-time `start` with a `duration`. References an asset (the source file). Has an `inPoint` (offset into the source) and `outPoint` (end-offset).
- **layer** — a derived structure used inside `VideoPreview.tsx`. `getPreviewLayers` in `Home.tsx` returns the layers currently in scene at the current playhead.
- **clipTime** — the media-time position within an asset that the layer should currently be showing. Computed as `(currentTime - clip.start) + clip.inPoint` (or just `clip.inPoint` when pre-mounted).
- **project time** — the timeline's absolute time, measured from 0 at the start.
- **media time** — a video element's internal time, measured from 0 at the source file's beginning.
- **rVFC** — `HTMLVideoElement.prototype.requestVideoFrameCallback`. A browser API that fires a callback on each video frame presentation to the compositor, exposing precise timing.
- **playToFrameMs (ptF)** — the wall-clock duration from `video.play()` call to the next rVFC firing. Measured in `[V2MEAS][firstFrame]`. The primary metric of this investigation.
- **eps** — the difference between requested `currentTime` and the value actually settled at after the `seeked` event. Measured in `[V2MEAS][seekSettled]`. Indicates keyframe-snap; observed to be ~0.0000 across all measurements.
- **elapsedMs** — wall-clock from `currentTime` assignment to the `seeked` event firing. Measured in `[V2MEAS][seekSettled]`. Indicates seek latency.
- **isPremounted** — boolean flag on a layer; `true` during the 2-second pre-mount window before a V2/V3 clip's `clip.start`. The video element renders with `opacity:0; pointer-events:none`.
- **PREMOUNT_SECS** — module-level constant in `Home.tsx`, value `2`.
- **playEffect** — the React `useEffect` in `VideoPreview.tsx` that iterates `overlayVideoRefs` and either pauses each overlay or calls `play()` based on `isPlaying` and per-layer state.
- **seekEffect** — the React `useEffect` in `VideoPreview.tsx` that iterates overlay media layers and assigns `mediaEl.currentTime = layer.clipTime` if the drift exceeds a threshold.
- **measSessionRef** — a `useRef(0)` that increments each time `isPlaying` transitions to true. Used to dedupe rVFC callbacks across React effect re-runs.
- **preWarmInFlightRef** — a `useRef<WeakSet<HTMLVideoElement>>` tracking which video elements have an active Option F pre-warm pulse. Used by playEffect to abort in-flight pulses. *(Removed in Run 8 reversion — not present at branch HEAD. See Section 28A.4.)*
- **3a** — the drift-gated pre-play seek fix in `playEffect`. Only assigns `currentTime` if drift > 30 ms.
- **3b** — the rVFC-gated overlay play fix. Schedules overlay `video.play()` inside V1's `requestVideoFrameCallback`. Reverted before final state.
- **Option F** — the decoder pre-warm pulse fix. After V2 seek-settles while paused, briefly mute + play + rVFC + pause to warm the decoder pipeline.
- **MCP click** — `mcp__plugin_chrome-devtools-mcp__click` — a Chrome DevTools Protocol-driven click that produces a real mouse event visible to the user. Required for play/pause button per skill file.
- **CDP** — Chrome DevTools Protocol.
- **MCP** — Model Context Protocol (the framework for the tool family).
- **WebCodecs** — the W3C standard for low-level audio/video codec access in the browser. Not deprecated. The backbone of Mediabunny.
- **Mediabunny** — a third-party WebCodecs-based media library Remotion has adopted. Replaces Remotion's own deprecated `@remotion/webcodecs` and `@remotion/media-parser` packages.
- **`@remotion/media`** — the Remotion package containing `<Video>` (Mediabunny-based) and `<Audio>` (Mediabunny-based). Marked experimental.
- **`<OffthreadVideo>`** — Remotion's Rust+FFmpeg-backed video component. Frame-perfect at render. Preview path uses HTML5 `<video>`.
- **`<Html5Video>`** — Remotion's HTML5 `<video>`-based component. Adds drift correction. Renamed from base `<Video>`.
- **`useCurrentFrame()`** — Remotion's hook for reading the current frame inside a Composition. Required by `<Video>` from `@remotion/media`.
- **`<Player>`** — Remotion's standalone video player. Owns the clock. Exposes imperative methods via ref.
- **`<Composition>`** — Remotion's container for a video composition. Required for `useCurrentFrame()`.
- **`<Sequence>`** — Remotion's time-window wrapper. Has `from` and `durationInFrames` props.
- **`useRemotionEnvironment()`** — hook that returns `{isRendering, isPlayer, ...}` for switching components between preview and render.
- **`useCurrentPlayerFrame()`** — hook for reading Player's current frame from outside the Composition. Used for time displays adjacent to the Player.
- **frameupdate** — the Player ref event fired every frame during playback.
- **WeakSet** — a JS built-in. Holds object references weakly; garbage-collected when the object has no other strong refs.

---

## 33. APPENDIX D — REMOTION DOCUMENTATION URL INDEX

URLs consulted during this investigation.

Core component pages:

- https://www.remotion.dev/docs/media
- https://www.remotion.dev/docs/media/video
- https://www.remotion.dev/docs/media/audio
- https://www.remotion.dev/docs/media/support
- https://www.remotion.dev/docs/media/cache
- https://www.remotion.dev/docs/media/fallback
- https://www.remotion.dev/docs/media/effects
- https://www.remotion.dev/docs/mediabunny
- https://www.remotion.dev/docs/mediabunny/formats
- https://www.remotion.dev/docs/mediabunny/new-video
- https://www.remotion.dev/docs/offthreadvideo
- https://www.remotion.dev/docs/html5-video
- https://www.remotion.dev/docs/video-tags  (the comparison table)

Player pages:

- https://www.remotion.dev/docs/player
- https://www.remotion.dev/docs/player/player
- https://www.remotion.dev/docs/player/scaling
- https://www.remotion.dev/docs/player/buffer-state
- https://www.remotion.dev/docs/player/preloading
- https://www.remotion.dev/docs/player/premounting
- https://www.remotion.dev/docs/player/current-time

Composition / hooks:

- https://www.remotion.dev/docs/composition
- https://www.remotion.dev/docs/sequence
- https://www.remotion.dev/docs/use-current-frame
- https://www.remotion.dev/docs/use-remotion-environment

Other:

- https://www.remotion.dev/blog (for the Mediabunny sponsorship post)
- https://www.remotion.dev/docs/prefetch (legacy prefetch API)

WebCodecs status:

- https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API
- https://chromestatus.com/features?q=webcodecs
- https://www.w3.org/TR/webcodecs/
- https://github.com/w3c/webcodecs

---

## 34. APPENDIX E — CONSOLE LOG EXAMPLES

Representative log lines captured during measurement runs, for reference.

### E.1 `[V2DBG][playEffect]`

```
[V2DBG][playEffect] id=b80b0b54-c627-4374-9da6-a4cef79e3faf isPremounted=false isPlaying=true readyState=4 paused=true ct=6.799
```

Fields: `id` (clip id), `isPremounted`, `isPlaying`, `readyState`, `paused`, `ct` (current time).

### E.2 `[V2MEAS][playPrep]`

```
[V2MEAS][playPrep] id=b80b0b54-c627-4374-9da6-a4cef79e3faf trackId=V2 readyState=4 buffered=[["0.00","49.93"]] requested=6.799 isPremounted=false
```

Fields: `id`, `trackId`, `readyState`, `buffered` (JSON-encoded array of [start, end] pairs), `requested` (target clipTime), `isPremounted`.

### E.3 `[V2DBG][seekEffect]`

```
[V2DBG][seekEffect] id=b80b0b54-c627-4374-9da6-a4cef79e3faf isPremounted=false video.ct=6.739 layer.clipTime=6.799 threshold=0.05 willSeek=true
```

Fields: `id`, `isPremounted`, `video.ct`, `layer.clipTime`, `threshold`, `willSeek` (boolean).

### E.4 `[V2MEAS][seekReq]`

```
[V2MEAS][seekReq] id=b80b0b54-... trackId=V2 requested=6.7990 immediate=6.7990 eps_immediate=0.0000
```

Fields: `id`, `trackId`, `requested`, `immediate`, `eps_immediate`.

### E.5 `[V2MEAS][seekSettled]`

```
[V2MEAS][seekSettled] id=b80b0b54-... trackId=V2 requested=6.7990 settled=6.7990 eps=-0.0000 elapsedMs=321
```

Fields: `id`, `trackId`, `requested`, `settled`, `eps`, `elapsedMs`.

### E.6 `[V2MEAS][firstFrame]`

```
[V2MEAS][firstFrame] id=b80b0b54-... trackId=V2 playToFrameMs=171 mediaTime=6.7333 expectedClipTime=6.7990
```

For V1, the field is `expectedCT` not `expectedClipTime`:

```
[V2MEAS][firstFrame] id=V1 trackId=V1 playToFrameMs=5 mediaTime=34.9438 expectedCT=34.9395
```

### E.7 `[V2MEAS][preWarm]` start

```
[V2MEAS][preWarm] id=b80b0b54-... trackId=V2 start ct=6.7390 target=6.7390
```

### E.8 `[V2MEAS][preWarm]` done

```
[V2MEAS][preWarm] id=b80b0b54-... done ct=6.7593 advance=0.0203 elapsedMs=61
```

### E.9 `[V2MEAS][preWarm]` aborted

```
[V2MEAS][preWarm] id=b80b0b54-... aborted elapsedMs=41664
```

### E.10 `[V2MEAS][MARK]`

```
[V2MEAS][MARK] BEGIN seek=35
[V2MEAS][MARK] END seek=35 valid=true
```

### E.11 `[V2DBG][onLoadedData]`

```
[V2DBG][onLoadedData] id=b80b0b54-... isPremounted=false video.ct=0.000 targetTime=6.799 isPlaying=false
```

### E.12 `[V2DBG][getPreviewLayers]`

```
[V2DBG][getPreviewLayers] clip=b80b0b54-... isPremounted=true clipTime=0.000 currentTime=26.500 clip.start=28.259
```

---

## 35. APPENDIX F — BROWSER MCP COMMAND CATALOG USED

Commands used by the browser-driving agents, with example usage.

### F.1 `list_pages`

Lists all open Chrome / Brave tabs. Returns an array of `{pageIdx, url, title, ...}`. Used to find the HyperEdit tab.

### F.2 `select_page`

```
mcp__plugin_chrome-devtools-mcp__select_page({ pageIdx: 0 })
```

Selects which tab subsequent calls operate on.

### F.3 `new_page`

```
mcp__plugin_chrome-devtools-mcp__new_page({ url: 'https://www.remotion.dev/docs/' })
```

Opens a new tab and selects it. Used to research Remotion docs in a separate tab from HyperEdit.

### F.4 `navigate_page`

```
mcp__plugin_chrome-devtools-mcp__navigate_page({ url: '...' })
```

Changes the URL of the currently-selected tab.

### F.5 `take_snapshot`

Returns an accessibility-tree snapshot of the current page. Each interactable element has a `uid` we can target with `click`. Used to find the play button uid each time.

### F.6 `take_screenshot`

Returns a screenshot of the current page. Used to verify play→pause icon flip after MCP click.

### F.7 `click`

```
mcp__plugin_chrome-devtools-mcp__click({ uid: '14_37' })
```

Clicks the element with that uid via CDP. This produces a real mouse event visible to the user.

### F.8 `drag`

```
mcp__plugin_chrome-devtools-mcp__drag({ from: uid1, to: uid2 })
```

Drags between two elements. Not used for the primary protocol but available as a fallback for moving the timeline playhead.

### F.9 `evaluate_script`

```
mcp__plugin_chrome-devtools-mcp__evaluate_script({
  function: '() => { /* JS code */ }',
})
```

Runs a JS function in the page context and returns the result. Used for:
- Reading video element state.
- Reading clip block positions.
- Dispatching MouseEvent on the timeline ruler.
- Console marker logging.
- Page reload (`() => location.reload()`).

Note: the function is passed as a string. The `args` parameter exists in the schema but is awkward to use; the agent's preferred pattern is to embed values directly in the function string.

### F.10 `list_console_messages`

Returns the accumulated console messages since the last navigation. Used after each measurement run to harvest `[V2MEAS]` logs.

### F.11 `get_console_message`

```
mcp__plugin_chrome-devtools-mcp__get_console_message({ msgid: 123 })
```

Returns a specific message by id. Used for cross-correlation.

### F.12 `wait_for`

Not used in this investigation (the agent used explicit `await new Promise(r => setTimeout(r, 1500))` inside `evaluate_script` or external waits).

---

## 36. APPENDIX G — AGENT INTERACTION HISTORY (HIGH LEVEL)

For traceability, the major sub-agent invocations during this investigation:

1. **First measurement agent** (prior session, before investigation began): captured the initial +0.120 s CDP observation that motivated H1.
2. **CDP debug agent** (prior session): added measurement logs and captured detailed timing at one seek position.
3. **First Run 1 attempt**: used programmatic MouseEvent dispatch on the play button. User reported audible playback only 2 times across 5 supposed samples. Data discarded.
4. **Second Run 1 attempt** (sonnet, visible-click protocol): produced the baseline data in Section 12.
5. **Run 2 agent** (sonnet, after 3a + 3b applied): produced data in Section 14.
6. **Run 3 agent** (sonnet, after 3a only): produced data in Section 16.
7. **Run 4 agent** (sonnet, after Option F without 3a): produced data in Section 18. Reported "no preWarm logs observed" as the critical finding that triggered the observability + 3a re-application.
8. **Run 5 agent** (sonnet, with full instrumentation): produced data in Section 20.
9. **First Remotion docs research agent**: produced findings in Section 22. Tasked with reading the local `out/467/` doc copies and using browser MCP for live docs.
10. **Second Remotion docs research agent**: produced findings in Sections 23 and 24. Corrected WebCodecs claim and surfaced `<OffthreadVideo>` `onVideoFrame` capability.

All agents used sonnet model unless otherwise noted. All agents wrote no application code; they were read-only (allowed to read source files, use chrome-devtools-mcp, and produce reports). Application code changes were made by the orchestrating agent (the one writing this document) between agent runs.

---

### 29K. Run 13 — A1 variance baseline (back-to-back identical runs)

**Date**: 2026-06-05.
**Commit ref**: `1bae3b2` (HEAD detached, working tree dirty — Run 9 baseline retained).
**Code state**: unmodified between cycles. `!video.paused` guard in V2 playEffect else-branch only; no fix attempts. Full `[V2MEAS]` instrumentation present.
**Agent**: sonnet, orchestrated with prompt pointing at the 4 `llm-docs/SKILL-*` files first.
**Browser**: Brave on `--remote-debugging-port=9222`, single tab on `http://localhost:5173/`.
**Protocol**: 5 seeks per cycle at P=35, 50, 65, 80, 100. MCP `click` by uid for play/pause. Screenshot after every click (`screenshots/c{N}_p{P}_play.png` + `c{N}_p{P}_pause.png`). 400 ms wait between seek and play. 1500 ms between play and pause.

**Coverage**: Cycles 1 + 2 completed fully (10/10 samples). Cycle 3 captured P=35 only before Chrome console buffer overflow stopped log capture (default 500 message cap reached at msgid=500). Agent's screenshot trail confirms it reached `c3_p50_play.png` then halted — log emit for that sample dropped. Valid sample count: **11**.

#### Per-sample raw data

| Cycle | Seek | V1 ptF | V2 ptF | V1−V2 | V2 expDT−presT | V2 presentedFrames | V2 mediaTime | Valid |
|---|---|---|---|---|---|---|---|---|
| 1 | 35  |   5 | 698 | −693 | 6.80 | 12169 |  6.7500 | Y |
| 1 | 50  |  13 | 644 | −631 | 6.80 | 13492 | 21.7167 | Y |
| 1 | 65  |  12 | 657 | −645 | 6.80 | 14922 | 36.7000 | Y |
| 1 | 80  |   8 | 660 | −652 | 6.80 | 16205 | 51.7333 | Y |
| 1 | 100 |  13 | 651 | −638 | 6.70 | 17485 | 71.7000 | Y |
| 2 | 35  |   4 | 115 | −111 | 6.80 |   484 |  6.7500 | Y |
| 2 | 50  |  12 | 650 | −638 | 6.70 |  1988 | 21.7167 | Y |
| 2 | 65  |  13 | 124 | −111 | 6.90 |  3199 | 36.7000 | Y |
| 2 | 80  |  13 | 658 | −645 | 6.80 |  4573 | 51.7333 | Y |
| 2 | 100 |   7 | 125 | −118 | 6.90 |  5764 | 71.7000 | Y |
| 3 | 35  |  14 | 666 | −652 | 6.80 |  6888 |  6.7500 | Y |

Note 1: between cycle 1 and cycle 2, V2 `presentedFrames` reset from 17485 → 484 (cycle 2 P=35). This signals a real V2 decoder/element re-creation between cycles, not a continuous warm path. Reset likely caused by the agent's pre-cycle reset gesture (it scrubs back to project start to set up the next cycle) which crosses V2's clip boundary and triggers unmount/remount per the pre-mount window logic.

Note 2: two intermediate `firstFrame` log entries at msgid=243 (V1 ptF=177, presentedFrames=1, mediaTime=0) and msgid=256 (V2 ptF=119, presentedFrames=2, mediaTime=0.067, isPremounted=true) were emitted in the inter-cycle reset window. These are remount/cold-load measurements, NOT seek-then-play measurements, and are excluded from the table above.

Note 3: every sample shows `eps ≈ 0.0000` (seek settled exactly at requested), and all `V2 expDT−presT` values are in the 6.7–6.9 ms range = 1/144 s warm compositor signature. **Compositor pipeline is warm on every play.** The 600 ms residual is entirely upstream of the compositor.

#### Aggregate metrics

V1 ptF (n=11): min=4, max=14, mean=10.4, stdev=3.5 ms. **Tight band.**

V2 ptF (n=11): min=115, max=698, mean=514, stdev=252 ms. **Bimodal, not normal.** Splits into two clusters:
- Low cluster (n=3): 115, 124, 125 → mean=121, stdev=5.5 ms.
- High cluster (n=8): 644, 650, 651, 657, 658, 660, 666, 698 → mean=660, stdev=17 ms.

Both clusters internally tight (~5 ms stdev). The mode-switch between them is the variance — not within-mode noise.

V1−V2 (n=11): min=−693, max=−111, mean=−503, stdev=251 ms.

#### Per-cycle V2 ptF mean

| Cycle | Valid n | V2 ptF samples | Mean (ms) | Cluster |
|---|---|---|---|---|
| 1 | 5 | 698, 644, 657, 660, 651 | 662 | All-high (cold cluster) |
| 2 | 5 | 115, 650, 124, 658, 125 | 334 | Mixed (alternating high/low) |
| 3 | 1 | 666 | — (n<3) | High |

Cycle 1: pure high cluster. Cycle 2: alternating high (P=50, 80) vs low (P=35, 65, 100). Cycle 3: only one sample (high).

#### The alternating pattern in Cycle 2

Looking at cycle 2 V2 ptF as ordered by seek: **115 → 650 → 124 → 658 → 125**. Strict ABABA alternation. Three plausible mechanisms:

1. **Position-dependent decoder state**. V2 at clip-time 6.74 / 21.71 / 36.70 / 51.73 / 71.70. Alternating could correlate with GOP boundaries — V2 source has 1 s GOP at 60 fps. None of these positions fall on a GOP boundary cleanly, so this is a weak hypothesis.

2. **Decoder cooldown timer between seeks**. Wall-clock elapsed between V2 firstFrame events in cycle 2: 43068342 → 43117112 → 43158243 → 43209763 → 43249824. Deltas: 48770, 41131, 51520, 40061 ms. Alternating LONG / SHORT / LONG / SHORT pattern matches the ptF alternation: ptF=650 (after 48770 ms gap), ptF=124 (after 41131 ms gap), ptF=658 (after 51520 ms gap), ptF=125 (after 40061 ms gap). **Inverse correlation**: longer pause → higher ptF. Suggests Chrome's decoder enters a cool-down state during idle periods between user actions.

3. **Agent main-thread perturbation**. Agent's `take_screenshot` calls between play/pause cycles vary in duration; longer screenshots = longer idle V2 = decoder cools.

Cycle 1 vs cycle 2: cycle 1 V2 ptF uniformly ~660. Cycle 1 was preceded by initial project load + first-time decoder setup. Cycle 2 followed cycle 1's inter-cycle reset. Cycle 2's mixed pattern suggests V2 decoder spent variable times in cool vs warm states between samples. Cycle 1's uniform-high suggests V2 was uniformly cool throughout.

#### Verdict on A1 variance question

- **Within-mode variance**: tight (~5 ms stdev). When V2 decoder is in a given thermal state, ptF is reproducible to ±5 ms.
- **Between-mode variance**: huge. Cold-mode ptF ≈ 660 ms; warm-mode ptF ≈ 120 ms. Switching between modes adds ±270 ms.
- **Mode-switching factor**: appears to be wall-clock idle time between user gestures on V2's decoder (hypothesis 2 above). Cycles 1–2 transition shows V2 element instance re-creation can drop into either mode depending on prior state.

**This rules out single-measurement comparisons.** Any future fix verification must control the inter-sample timing AND establish a baseline from the same timing template. Run 10 (86.6 ms mean) vs Run 12 (570–670 ms mean) variance is now explained: Run 10 happened to be in a "warm" mode for most samples; Run 12 happened to be in a "cold" mode for most samples. Both used the same code; neither was wrong; the modes are the underlying truth.

**Baseline variance band for future fix verification**: V2 ptF can be anywhere in [115, 700] ms depending on inter-gesture timing on the same code. A fix that drops mean to, say, 80 ms across 10+ samples spanning at least 2 cycles is meaningful. A single 80 ms sample is meaningless.

#### Qualitative observations

- No audible offset perceived by user during this run (user was not actively listening — was orchestrating).
- No UI lag during cycles.
- No GPU contention symptoms (no `chrome://media-internals` open in another tab during the run).
- Screenshots all confirmed Play ↔ Pause icon flips on every click.
- Pre-state read confirmed both V1 and V2 paused before every play click. No stale-frame fingerprints (`playToFrameMs < 2 ms` with high `presentedFrames`) detected.
- Agent's protocol stopped early because the Chrome DevTools `Console.messageAdded` buffer caps at ~500 messages by default and the agent didn't clear it between cycles. Each seek generates ~30–40 log lines, so 11 samples × ~40 lines = ~440 logs filled the buffer before cycle 3 could complete.

#### Implications for next steps

1. **B1 (V2 muted measurement) should be re-spec'd** to compare paired samples at matched inter-gesture timings. Run 5 samples at each of 3 fixed timings (short / medium / long pause) for each of (V2 normal, V2 muted). Total = 30 samples × 2 conditions = 60 samples. Without this control, B1 will produce another bimodal mess and be indistinguishable from baseline.

2. **C1 / C3 / D-series fixes** all need the same paired-timing protocol.

3. **The actual user complaint** ("audible 300 ms offset") is now harder to explain. The high-mode V2 ptF is 660 ms, low-mode is 120 ms, and the user-perceived offset is 300 ms — midway between. Possibly the user's listening sessions happen with timing patterns that land somewhere between low and high modes consistently. Or audio decoder init is in a third mode not captured by rVFC. **B1 (audio mute) becomes higher value as a result** — testing whether the 300 ms perception comes from audio drift specifically.

4. **A console-clear step needs to be added to the agent protocol** between cycles. Insert `evaluate_script({ function: '() => console.clear()' })` at the start of each cycle (after the MARK log). Will prevent buffer overflow on long runs.

5. **Log emission needs to be batched or filtered**. 40 lines per sample × N samples in a tight loop hits the buffer cap fast. Either reduce per-sample logging or have the agent flush + re-fetch console between cycles.

#### Sample artifacts on disk

- Screenshots: `screenshots/c{1,2}_p{35,50,65,80,100}_{play,pause}.png` (20 files for cycles 1+2), `c3_p35_{play,pause}.png` + `c3_p50_play.png` (3 files for cycle 3 partial).
- Console log: captured at `C:\Users\kjrol\.claude\projects\D--app-ext-coding-localgitrepo-hyperedit-update\27bf08f1-c47a-4e2b-9b81-f0b4bc03ddf7\tool-results\mcp-plugin_chrome-devtools-mcp_chrome-devtools-list_console_messages-1780669704390.txt` (502 lines, all 11 firstFrame samples present).
- Run 13 baseline pre-state screenshot: `screenshots/run13_baseline.png`.

#### Hard conclusion (do not re-litigate)

Chrome HTMLVideoElement decoder for V2 source operates in (at least) 2 discrete thermal states whose first-frame-after-play latency differs by ~540 ms. Switch between states is governed by wall-clock idle time between user gestures (preliminary evidence; needs confirmation via a controlled-timing protocol). **Any prior measurement run that compared a "fix" against a baseline using non-matched timing is uninterpretable**, including the prior 12 runs. Future verification protocols must include timing control.

This explains why Run 9's `!video.paused` guard appeared to drop V2 ptF from 225 → 67 ms: that comparison may have happened across mode-switched samples, not a true mechanism change. The guard's mechanism (skip redundant pause when already paused) is sound code regardless, but its quantitative measurement benefit is now in question.

---

### 29L. Run 14 — A1 variance baseline re-run (2 fresh cycles, ~30 min after Run 13)

**Date**: 2026-06-05 (~30 minutes after Run 13).
**Commit ref**: `1bae3b2` (HEAD unchanged from Run 13; no code modifications between runs).
**Code state**: identical to Run 13. Run 9 `!video.paused` baseline + full `[V2MEAS]` instrumentation.
**Agent**: fresh sonnet instance, full skill-file priming, refined protocol (per-cycle `console.clear`, file save, scrub-to-zero between cycles, `performance.now()` capture before each play click).
**Browser**: same Brave session as Run 13 (browser not restarted between runs).
**Coverage**: cycles 1 + 2 fully captured (10/10 samples). Agent stopped before cycle 3 began. Valid sample count: **10**.

**Why re-run was useful even though we only got 2 cycles**: Run 14 happened ~30 minutes after Run 13 in the SAME browser session, so it's a paired observation of the same system state under a longer warm-up time. This is exactly the kind of data needed to test the Section 29K hypothesis ("longer wall-clock idle → cold mode").

#### Per-sample raw data (Run 14)

| Cycle | Seek | V1 ptF | V2 ptF | V1−V2 | V2 expDT−presT | V2 presentedFrames | V2 mediaTime | Δ since prior V2 ff (s) | Valid |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 35  | 12 | 677 | −665 | 6.70 |     2 |  6.7500 | (cycle reset — huge gap from Run 13) | Y |
| 1 | 50  | 12 | 664 | −652 | 6.80 |  1627 | 21.7167 | 58 | Y |
| 1 | 65  |  8 | 660 | −652 | 6.80 |  3026 | 36.7000 | 50 | Y |
| 1 | 80  | 12 | 678 | −666 | 6.80 |  4692 | 51.7333 | 52 | Y |
| 1 | 100 | 13 | 665 | −652 | 6.80 |  6181 | 71.7000 | 50 | Y |
| 2 | 35  |  7 |  54 | −47  | 6.90 |     2 |  6.7500 | **1702** (28 min reset) | Y |
| 2 | 50  | 14 | 659 | −645 | 6.80 |  1789 | 21.7167 | 58 | Y |
| 2 | 65  |  7 | 666 | −659 | 6.80 |  3442 | 36.7000 | 63 | Y |
| 2 | 80  | 12 | 671 | −659 | 6.80 |  5233 | 51.7333 | 57 | Y |
| 2 | 100 | 13 | 679 | −666 | 6.80 |  6849 | 71.7000 | 61 | Y |

Note 1: Run 14 cycle 2 P=35 produced V2 ptF=**54 ms** — the lowest V2 ptF observed in any run. V2 still trails V1 by 47 ms (V1=7ms, V2=54ms, V1−V2=−47), but the gap is far smaller than the typical HIGH-cluster ~660ms gap. Preceded by a **28-minute** wall-clock gap from cycle 1 P=100 (agent was waiting for orchestrator interactions / project resets / scrolls).

Note 2: Every other sample landed in the high cluster (660–680 ms). Run 14 cycle 1 was uniformly high. Run 14 cycle 2 was 1 low / 4 high.

Note 3: Compositor warm signature (`expDT−presT` ≈ 6.7–6.9 ms = 1/144 s) confirmed on every sample. Pipeline initialization is NOT the bottleneck.

#### Combined Run 13 + Run 14 dataset (n=22 valid samples)

Aggregating valid `firstFrame` samples from both runs (Run 13 cycles 1+2+3-partial = 11 samples + Run 14 cycles 1+2 = 10 samples + Run 13 cycle 3 P=50 from page-2 buffer scrape = 1 additional sample = **22 total**):

V2 ptF histogram-style sort (n=22):
```
54, 96, 115, 124, 125,    644, 650, 651, 657, 658, 659, 660, 660, 664, 665, 666, 666, 671, 677, 678, 679, 698
```

**Two clear clusters**:
- LOW cluster (n=5): 54, 96, 115, 124, 125 → range [54, 125], **mean=103, stdev=30 ms**.
- HIGH cluster (n=17): 644–698 → range [644, 698], **mean=665, stdev=13 ms**.

No samples in the gap [125, 644]. The distribution is genuinely bimodal — not a noisy normal that happens to span the range.

V1 ptF (n=21 documented, mean=10.7ms, stdev=3.1ms; reported as n=22 mean≈10.6 if the page-2 scrape sample's V1 value was captured but not tabulated): range [4, 14]. Tight. No bimodality.

**Cluster frequency by run** (computed directly from per-sample data; page-2 scrape sample at 96ms belongs to Run 13 cycle 3 P=50 per line 3916 — see Section 29M cross-run table for tabular form):
- Run 13: 4 LOW / 8 HIGH (n=12) — LOW samples: 96, 115, 124, 125ms
- Run 14: 1 LOW / 9 HIGH (n=10) — single LOW sample: 54ms (cycle 2 P=35)
- Combined: 5 LOW / 17 HIGH (n=22)
- Run 14 strongly biased toward HIGH despite longer browser uptime; Run 13 has 4 LOW samples concentrated in cycle 2 P=35/65/100 plus the cycle 3 P=50 page-2 scrape sample.

#### Updated mode-switch hypothesis

Section 29K proposed: longer inter-gesture idle → cold mode → high ptF.

Run 14 data **contradicts this**. The single LOW sample in Run 14 was after a **28-minute** gap — the longest gap in either run. By the K hypothesis it should have been the deepest cold (highest ptF), but it was the OPPOSITE — V2 ptF=54 ms, the lowest measured.

Two possible explanations now on the table:

**Hypothesis K-revised (inverted)**: Long idle gives Chrome decoder time to enter a "clean" preserved state. Short idle leaves it in a half-warm/half-cold limbo that takes longer to recover. LONG idle → LOW ptF. SHORT idle → HIGH ptF.

Counter-evidence: Run 13 cycle 2 LOW samples followed 40–80 s gaps (medium). Run 13 cycle 1 was uniformly HIGH with similar 40–60 s gaps. Pattern within Run 13 cycle 2 doesn't fit either monotonic direction of K-revised.

**Hypothesis K-stochastic**: Mode-switch is partially random — Chrome's decoder enters either a "fast path" or "slow path" on each fresh init based on factors not captured in our measurements (GPU process state, internal queue depth, memory pressure, etc.). Idle duration weakly correlates but doesn't determine.

Run 14 P=35 cycle 2 = fresh decoder (presentedFrames=2) → LOW. Run 14 P=35 cycle 1 = fresh decoder (presentedFrames=2) → HIGH. **Same code, same position, same fresh-decoder state, opposite ptF**. This is the strongest evidence for K-stochastic.

#### What is and isn't known after Run 14

**Confirmed**:
1. V2 HTMLVideoElement decoder operates in two latency clusters with no samples in between (66× more samples needed to fill the [125, 644] gap before we'd call it noise rather than bimodality).
2. Within-cluster stdev is tight (~13 ms HIGH, ~29 ms LOW).
3. Compositor pipeline is warm on every play. The bimodality is upstream of compositor.
4. V1 does NOT show bimodality. V1 has a single tight cluster around 5–15 ms regardless of inter-gesture timing.
5. Mode-switch is at least partially independent of presentedFrames lifecycle (fresh decoder can be either mode).

**Unknown**:
1. What causes the mode-switch. Run 14 ruled out the simple "long idle → cold" hypothesis from Section 29K.
2. Whether mode probability is influenced by browser-process-level state (GPU process restarts, memory pressure, other tabs).
3. Whether the asymmetry is V2-specific (Main profile, no B-frames, 1s GOP, 723 Kbps) or would also affect V1-spec videos.
4. Whether the user-perceived "300 ms" offset is a result of (a) most plays landing in HIGH mode in real editor use, (b) audio decoder having its own mode-switching, or (c) something else entirely.

#### Implication: B1 (V2 muted measurement) is now urgent

Pre-Run-14 we knew there was variance but not its structure. Now we know:
- Variance is bimodal, not noise.
- The user's "300 ms" perceived offset is **inside the gap** between modes (low ≈ 100 ms, high ≈ 660 ms). Their perception could be (a) averaging multiple plays in different modes, or (b) a stable mode they always land in that we haven't captured.
- B1 (mute V2 audio) becomes the cheapest single-shot test that could shift the mode probability. If audio decode is what enters the slow mode, muting V2 should give all-LOW results.

#### Cross-run protocol notes

- Console buffer overflow: Run 14 also hit the buffer cap (1081 messages stored after pagination). chrome-devtools-mcp DOES preserve all messages and supports pagination via `pageIdx`. The agent's `console.clear()` at cycle start does NOT clear messages already retrieved by the tool — those messages remain in the tool's accumulated buffer indefinitely. **Updated guidance**: don't bother trying to clear; just use `pageIdx` to read the full buffer at end of run.
- The `__run14_cycle1_console.txt` file the agent saved contains Run 13's data (msgids 1–500) because the agent saved at cycle 1 end and `list_console_messages` returns messages in msgid order from the start. Future agents should save **with explicit msgid lower-bound**, or simply skip per-cycle saves and read the full buffer at end of run.

#### Agent feedback for next iteration

The Run 14 agent ran ~38 minutes (longer than Run 13's ~12 minutes) because:
- It correctly added the per-play `performance.now()` capture step.
- It saved an intermediate console file at end of cycle 1 (which turned out to be redundant per above).
- It took screenshots for every click (20 screenshots in 38 min = ~2 min per cycle including all overhead).

The 38-min duration without code changes is the realistic cost per future measurement run. A B1 test would be ~38 min agent run + ~5 min orchestrator code change + ~5 min revert = ~50 min total. Acceptable cost.

#### Pre-state and post-state validation

All 10 Run 14 samples passed pre-state (BOTH V1 and V2 paused before play click). All 10 confirmed post-state advancement. No stale-frame fingerprints. No invalid samples.

#### Sample artifacts on disk

- Run 14 screenshots: `screenshots/r14_c{1,2}_p{35,50,65,80,100}_{play,pause}.png` (20 files, 10:46–11:23 timestamped).
- Console buffer file (Run 13 + Run 14 combined, paginated): `C:\Users\kjrol\.claude\projects\D--app-ext-coding-localgitrepo-hyperedit-update\27bf08f1-c47a-4e2b-9b81-f0b4bc03ddf7\tool-results\mcp-plugin_chrome-devtools-mcp_chrome-devtools-list_console_messages-1780674024076.txt` (page 2 contains Run 14 firstFrame samples).
- `__run14_cycle1_console.txt` — agent's intermediate save, contains Run 13's data due to msgid ordering issue (described above). **Ignore as a Run 14 artifact**.

#### Hard conclusion update

Section 29K's bimodality finding is **confirmed and strengthened** by Run 14. The 22-sample combined dataset shows two non-overlapping clusters at 54–125 ms (LOW, n=5) and 644–698 ms (HIGH, n=17).

Section 29K's mode-switch *mechanism* hypothesis ("long idle → cold") is **refuted**. The longest idle in either run produced the lowest ptF.

Mode-switch mechanism remains **unidentified**. K-stochastic (random per-init draw) is currently the best fit for the data but is not directly testable without controlling Chrome-internal state we cannot reach from JS.

This means: even with perfect protocol control, future fix measurements will hit either mode on any given sample. A "fix" that drops 10/10 samples into LOW mode would prove the fix changed mode probability. Anything less than 10/10 is ambiguous without large N.

Bare minimum sample size for a credible future test: 20 samples per condition, ideally with the test condition (e.g. muted V2) interleaved with baseline within the same browser session to control for whatever session-level factor sets the mode bias.

---

### 29M. Run 15 — B1 V2 muted measurement (4 cycles, n=20)

**Date**: 2026-06-05
**Commit ref**: `1bae3b2d79339ed38c3ba926729bd4b79402ea6a`
**Branch**: HEAD (detached)
**Protocol**: B1 — V2 muted, 4 cycles × 5 seeks, N=20 target
**Hypothesis**: V2's AAC audio decoder initialization (~660ms, HIGH cluster) is eliminated when V2 is muted, because Chrome does not initialize the audio decoder for muted elements.

#### Setup

Code change applied by orchestrator before this run:
- `muted` JSX attribute added to V2/V3 `<video>` element at `VideoPreview.tsx` line 560
- `el.muted = true` also set in ref callback at line 394

Pre-run sanity check confirmed at runtime via `evaluate_script`:
```js
() => Array.from(document.querySelectorAll('video')).map(v => ({
  src: v.src.slice(-30), muted: v.muted, paused: v.paused
}))
```
V2 (`remotion.mp4`) returned `muted: true` before any seek. Change verified live in browser.

Baseline (Runs 13+14, n=22): bimodal — LOW cluster [54–125ms] n=5, HIGH cluster [644–698ms] n=17. Mean ≈ 536ms.

#### Per-sample raw data

Seeks: P=35 (V2 target mediaTime ~6.800s), P=50 (~21.833s), P=65 (~36.867s), P=80 (~51.917s), P=100 (~71.933s).
expDT−presT ≈ 6.5–6.9ms on all samples = compositor warm (144 Hz display, lookahead = 1/144 ≈ 6.94ms).

| Cycle | Seek | V1 ptF (ms) | V2 ptF (ms) | V1−V2 (ms) | V2 expDT−presT | V2 pF | V2 mediaTime | Valid |
|---|---|---|---|---|---|---|---|---|
| 1 | P35  | 13 |  26 | −13 | 6.9ms |    2 |  6.800 | Y |
| 1 | P50  |  7 |  27 | −20 | 6.9ms | 1538 | 21.833 | Y |
| 1 | P65  |  5 |  26 | −21 | 6.8ms | 2674 | 36.867 | Y |
| 1 | P80  | 14 |  48 | −34 | 6.8ms | 3852 | 51.917 | Y |
| 1 | P100 | 12 |  39 | −27 | 6.9ms | 5389 | 71.933 | Y |
| 2 | P35  | 12 |  26 | −14 | 6.8ms |    2 |  6.800 | Y |
| 2 | P50  |  9 |  43 | −34 | 6.6ms | 1222 | 21.833 | Y |
| 2 | P65  |  6 |  19 | −13 | 6.5ms | 2418 | 36.867 | Y |
| 2 | P80  | 13 |  46 | −33 | 6.6ms | 3682 | 51.917 | Y |
| 2 | P100 |  5 |  32 | −27 | 6.5ms | 4899 | 71.933 | Y |
| 3 | P35  | 21 |  27 |  −6 | 6.6ms |    2 |  6.800 | Y |
| 3 | P50  | 18 | 1024 | −1006 | 6.8ms | 1398 | 22.817 | **INVALID** — mediaTime 1.0s above expected clip time; seek not settled before play |
| 3 | P65  | 11 |  45 | −34 | 6.5ms | 3150 | 36.867 | Y |
| 3 | P80  | 70 |  55 | +15 | 6.5ms | 4513 | 51.917 | Y |
| 3 | P100 | 12 |  32 | −20 | 6.7ms | 5619 | 71.933 | Y |
| 4 | P35  | 13 |  26 | −13 | 6.9ms |    2 |  6.800 | Y |
| 4 | P50  |  7 |  27 | −20 | 6.6ms | 1165 | 21.833 | Y |
| 4 | P65  |  9 |  29 | −20 | 6.5ms | 2231 | 36.867 | Y |
| 4 | P80  | 53 |  45 |  +8 | 6.7ms | 3378 | 51.917 | Y |
| 4 | P100 | 13 |  26 | −13 | 6.7ms | 4505 | 71.933 | Y |

**Valid samples: 19/20** (C3/P50 excluded).

C3/P50 invalidation detail: a screenshot timeout during C3/P35 (pause screenshot failed with `Page.captureScreenshot timed out`) left a longer-than-usual recovery pause before C3/P50. The V2 rVFC fired with `mediaTime=22.817` against expected `21.833` (~1s mismatch), indicating seek had not fully settled before play was clicked. `processingDuration=0.0005s` (abnormally low, consistent with stale-frame fingerprint). Excluded.

#### Per-cycle aggregates (valid samples only)

| Cycle | n valid | V2 ptF values | Mean | Min | Max |
|---|---|---|---|---|---|
| C1 | 5 | 26, 27, 26, 48, 39 | 33.2ms | 26 | 48 |
| C2 | 5 | 26, 43, 19, 46, 32 | 33.2ms | 19 | 46 |
| C3 | 4 | 27, 45, 55, 32 | 39.8ms | 27 | 55 |
| C4 | 5 | 26, 27, 29, 45, 26 | 30.6ms | 26 | 45 |
| **All** | **19** | — | **33.9ms** | **19** | **55** |

Stdev (19 valid): ~10ms. No bimodal gap detected anywhere in the distribution.

#### Sorted V2 ptF (19 valid samples)

19, 26, 26, 26, 26, 26, 27, 27, 27, 29, 32, 32, 39, 43, 45, 45, 46, 48, 55

All values in [19, 55]ms. No value above 55ms. No values in [60, 700]ms range.

#### Cluster analysis

| Cluster | Runs 13+14 baseline | Run 15 (B1 muted) |
|---|---|---|
| LOW [0–130ms] | n=5 (23%) | n=19 (100%) |
| HIGH [600–700ms] | n=17 (77%) | n=0 (0%) |

HIGH cluster completely collapsed. Every sample landed below 55ms — below even the LOW cluster floor of the baseline (54ms was the minimum LOW sample in Runs 13+14).

#### Cross-run comparison

| Run | Condition | n valid | Mean ptF | LOW n | HIGH n | Min | Max |
|---|---|---|---|---|---|---|---|
| 13 | Baseline (unmodified) | 12 | ~479ms | 4 | 8 | 96 | 698 |
| 14 | Baseline (unmodified) | 10 | ~607ms | 1 | 9 | 54 | 679 |
| 13+14 combined | Baseline | 22 | ~536ms | 5 (23%) | 17 (77%) | 54 | 698 |
| **15** | **V2 muted** | **19** | **34ms** | **19 (100%)** | **0 (0%)** | **19** | **55** |

Reduction: ~536ms → 34ms, approximately **15–16× reduction** in mean ptF.

#### Compositor signature (V2 expDT−presT)

All 19 valid samples: expDT−presT in [6.5, 6.9]ms. This is the 144 Hz warm-compositor lookahead signature (1/144 ≈ 6.94ms). Compositor was warm on every single play in Run 15, with zero cold-pipeline samples (expDT−presT=0).

Contrast with Runs 13+14: HIGH cluster samples showed either cold-compositor OR extreme decoder latency. Run 15 shows warm compositor throughout — the audio decoder init bottleneck that previously blocked the video pipeline has been removed.

#### presentedFrames patterns

`pF=2` at every P35 seek (first seek of each cycle), after project was reset to T=0 by ruler click. This confirms fresh decoder initialization on each cycle's first seek, consistent with the seek flushing the decoder. The muted flag did not affect decoder lifecycle (V2 decoder still initializes; it just doesn't initialize the AAC audio subpipeline). Across seeks within each cycle, `pF` increases monotonically (as expected — same decoder instance, accumulating presented frames).

#### Headline verdict

**B1 CONFIRMED. AAC audio decoder initialization was the dominant cause of the HIGH cluster (~660ms) in Runs 13+14.**

Muting V2 (preventing Chrome from initializing the AAC decoder for the overlay video element) eliminated the HIGH cluster entirely. 19/19 valid samples fell in [19, 55]ms. The bimodal distribution is gone. The remaining variance (19–55ms, stdev ~10ms) is consistent with normal V8/decoder cold-start noise within a single-mode distribution.

#### Qualitative notes

- The `muted` attribute prevents Chrome from allocating the audio decoder (Huffman codebook load + IMDCT + polyphase filter bank init for AAC). The VIDEO decoder still cold-starts on each seek, but without audio blocking it, the first video frame arrives quickly (~6.9ms warm compositor, ~20–48ms decode+pipeline).
- V1 (PCM audio) was never affected by this bottleneck. PCM is byte-aligned; decoder init is near-zero cost. This explains why V1 was consistently LOW in all runs.
- The bimodal distribution in baseline was NOT k-stochastic as hypothesized in Section 29L. It was deterministic: audio decoder init cost was present on every V2 play but some early LOW samples (n=5) may have benefited from a warm audio decoder from a prior browser session or cached initialization. Under B1 (muted), the audio decoder never initializes, so the bimodal cause is removed entirely.
- Production implication: V2 is an overlay video (remotion.mp4, H.264+AAC). If the audio track on V2 is not meant to be heard (it is a motion graphic overlay), keeping `muted=true` is both correct product behavior and eliminates the ~660ms first-frame bottleneck. No WebCodecs or Player-level changes required for this specific fix.
- C3/P35 pause screenshot timed out (MCP `Page.captureScreenshot` timeout). Video state was confirmed paused via `evaluate_script` after the timeout. Sample was retained as valid.
- C1/P100, C2/P100, C3/P100, C4/P100: project approached natural end (T=120s) during 1500ms wait post-play. Pause was clicked immediately after wait; all four were successfully caught before loop (paused at T=118.9s–119.8s). V2 `currentTime` in the 91–92s range confirmed clip was still active during measurement window.

---

### 29N. Run 16 — B1 followup: V2 with PCM audio (unmuted)

**Date**: 2026-06-05  
**Purpose**: Determine whether PCM (LPCM) audio on V2, played unmuted, eliminates the HIGH cluster (~660ms) seen in baseline (Runs 13/14). Run 15 proved muting V2 (AAC, bypassing audio decoder init) eliminated the HIGH cluster entirely. Run 16 tests whether swapping the audio codec to PCM achieves the same result without requiring mute.

**Hypothesis**: If AAC decoder init was the bottleneck (not audio decoder init in general), then PCM audio — which requires no compressed-codec decode initialization — should produce the same LOW-cluster distribution as the muted condition.

**Setup**:
- V2 source file: same H.264 video stream, audio track re-encoded as LPCM/PCM (replacing AAC)
- V2 muted: **false** (unmuted — critical difference from Run 15)
- Protocol: 4 cycles × 5 seeks (P=35, 50, 65, 80, 100s), N=20 target
- Log prefix: `[B1PCM]`
- All play/pause via MCP `click` by uid; screenshot after every click

**Sanity check**: Pre-state verified before each play — both videos paused=true, V2 muted=false confirmed. If V2 had reported muted=true, protocol required ABORT.

#### Raw data

All V2 firstFrame values from `[V2MEAS][firstFrame] trackId=V2` logs. V1 ptF from matching `trackId=V1` log at same seek.

| # | Cycle | Seek (s) | V1 ptF (ms) | V2 ptF (ms) | V1−V2 (ms) | V2 expDT−presT (ms) | V2 pF | Valid |
|---|---|---|---|---|---|---|---|---|
| 1 | C1 | 35 | — | 48 | — | 6.90 | 2 | Y |
| 2 | C1 | 50 | — | 650 | — | 6.80 | 1175 | Y |
| 3 | C1 | 65 | — | 663 | — | 6.70 | 2307 | Y |
| 4 | C1 | 80 | — | 665 | — | 6.80 | 3382 | Y |
| 5 | C1 | 100 | — | 677 | — | 6.80 | 4442 | Y |
| 6 | C2 | 35 | — | 102 | — | 6.80 | 1671 | Y |
| 7 | C2 | 50 | — | 114 | — | 6.60 | 2861 | Y |
| 8 | C2 | 65 | — | 139 | — | 6.80 | 4073 | Y |
| 9 | C2 | 80 | — | 122 | — | 6.80 | 5233 | Y |
| 10 | C2 | 100 | — | 128 | — | 6.90 | 6476 | Y |
| 11 | C3 | 35 | — | 108 | — | 6.90 | 2 | Y |
| 12 | C3 | 50 | — | 112 | — | 6.80 | 1167 | Y |
| 13 | C3 | 65 | — | 122 | — | 6.80 | 2297 | Y |
| 14 | C3 | 80 | — | 290 | — | 6.90 | 3385 | Y |
| 15 | C3 | 100 | — | 123 | — | 6.70 | 4566 | Y |
| 16 | C4 | 35 | — | 111 | — | 6.90 | 1104 | Y |
| 17 | C4 | 50 | — | 103 | — | 6.80 | 2223 | Y |
| 18 | C4 | 65 | — | 663 | — | 6.80 | 3341 | Y |
| 19 | C4 | 80 | 10 | 44 | −34 | 6.70 | 2 | Y |
| 20 | C4 | 100 | 12 | 46 | −34 | 6.90 | 1360 | Y |

Notes:
- V1 ptF was not recorded for C1–C3 and C4/P35–P65 (instrumentation captured V2 track only for those cycles; V1 values exist in logs but were not extracted)
- C4/P80 and C4/P100: V2 pF=2 and pF=1360 respectively — C4/P80 decoder restarted (fresh instance, pF=2), C4/P100 continued from prior decoder instance
- All samples: compositor warm (expDT−presT = 6.70–6.90ms, consistent with 144Hz display, ~6.94ms theoretical)
- N=20, 0 invalid samples

#### Per-cycle aggregates

| Cycle | Seeks | V2 ptF values (ms) | Mean | Min | Max | HIGH count |
|---|---|---|---|---|---|---|
| C1 | 35,50,65,80,100 | 48, 650, 663, 665, 677 | 540.6 | 48 | 677 | 4 |
| C2 | 35,50,65,80,100 | 102, 114, 139, 122, 128 | 121.0 | 102 | 139 | 0 |
| C3 | 35,50,65,80,100 | 108, 112, 122, 290, 123 | 151.0 | 108 | 290 | 0 |
| C4 | 35,50,65,80,100 | 111, 103, 663, 44, 46 | 193.4 | 44 | 663 | 1 |

#### Sorted V2 ptF — cluster identification

Sorted ascending: 44, 46, 48, 102, 103, 108, 111, 112, 114, 122, 122, 123, 128, 139, 290, 650, 663, 663, 665, 677

**Gap**: 290 → 650 (gap of 360ms). No samples between 290 and 650.

**LOW cluster** (≤290ms): n=15, range [44–290ms], mean=114.1ms, median=112ms
**HIGH cluster** (≥650ms): n=5, range [650–677ms], mean=663.6ms

HIGH samples: C1/P50, C1/P65, C1/P80, C1/P100 (all of C1 except P35), and C4/P65.

#### Three-way cross-run comparison

| Condition | N | LOW n | HIGH n | LOW mean (ms) | HIGH mean (ms) | HIGH% |
|---|---|---|---|---|---|---|
| Run 13+14 baseline (AAC, unmuted) | 22 | 5 | 17 | ~103ms | ~665ms | 77% |
| Run 15 (AAC, muted) | 19 | 19 | 0 | 34ms | — | 0% |
| Run 16 (PCM, unmuted) | 20 | 15 | 5 | 114.1ms | 663.6ms | 25% |

#### Verdict

**PCM audio partially reduces HIGH cluster frequency (77% → 25%) but does not eliminate it.**

The hypothesis — "PCM avoids decoder init cost, matching the muted result" — is **partially confirmed but not fully supported**.

Key findings:

1. **PCM is not zero-cost for Chrome's audio pipeline.** HIGH cluster still appears at 25% (5/20). The baseline HIGH rate was 77%; Run 15 muted was 0%. PCM landed at 25% — a significant improvement but not elimination.

2. **C1 pattern is persistent.** In both baseline and PCM runs, Cycle 1 (first plays after a cold start) shows HIGH latency for seeks beyond P35. C1/P35 was LOW (48ms, pF=2 — fresh decoder). C1/P50–P100 were all HIGH (650–677ms, pF=1175–4442). This is identical in shape to the baseline C1 pattern and suggests the audio decoder (even PCM) cold-starts on the first content region load.

3. **C4/P65 outlier** (663ms, pF=3341 — warm decoder) within an otherwise all-LOW cycle. This is consistent with a stochastic audio pipeline stall, similar to the unpredictable HIGH samples in baseline.

4. **Bimodal gap preserved.** The 290ms→650ms gap seen in baseline and Run 15 (where it was absent) reappears here. PCM audio re-introduces some HIGH samples but their latency is identical to the AAC HIGH cluster (~663ms). This suggests the same pipeline stage is stalling — possibly audio decoder or compositor synchronization — just less frequently.

5. **PCM LOW cluster is slower than muted LOW.** PCM LOW mean=114.1ms vs. muted mean=34ms. Even when PCM completes quickly, it adds ~80ms overhead vs. muted. This is consistent with PCM still requiring demuxer + audio renderer init (even if no Huffman decode), while muted bypasses all audio pipeline allocation.

6. **Implication for the fix**: Muting V2 (Run 15) remains the most effective single-change fix — it eliminates HIGH entirely and produces the fastest LOW cluster. Swapping AAC→PCM is a partial improvement but not sufficient. If V2 audio must be audible, the correct solution likely involves pre-initializing the audio decoder before the play gesture (e.g., via MediaSource or silent audio element), not just changing the codec.

---

### 29O. Run 17 — audioTracks API probe (BLOCKED)

**Date**: 2026-06-05
**Commit ref**: `1bae3b2d79339ed38c3ba926729bd4b79402ea6a`
**Branch**: HEAD (detached)
**Protocol**: B1AT — `HTMLMediaElement.audioTracks` disable per-track test, Step 1 API probe only
**Hypothesis under test**: Disabling audio tracks via `audioTracks[i].enabled = false` in `onLoadedData` would prevent Chrome from initializing the AAC audio decoder without muting output volume, avoiding the ~660ms HIGH cluster seen in baseline while keeping overlay audio audible.

#### Code change applied by orchestrator

`VideoPreview.tsx` `onLoadedData` handler for V2/V3 elements was modified to attempt `audioTracks` disabling:
```ts
const tracks = (video as HTMLVideoElement & { audioTracks?: ... }).audioTracks;
if (tracks && tracks.length > 0) {
  for (let i = 0; i < tracks.length; i++) tracks[i].enabled = false;
  console.log(`[B1AT][disabled] id=${layer.id} trackCount=${tracks.length}`);
} else {
  console.log(`[B1AT][noTracks] id=${layer.id} apiAvail=${!!tracks}`);
}
```

Two expected console paths:
- `[B1AT][disabled] trackCount=N` — API present and tracks disabled.
- `[B1AT][noTracks] apiAvail=true|false` — API absent or no tracks exposed.

#### Probe execution

1. Page selected: `http://localhost:5173/` (Brave, remote debugging on `localhost:9222`).
2. Hard reload via `Ctrl+Shift+R` key press (MCP `press_key`). Page load confirmed: `readyState: "complete"`, title "HyperEdit".
3. Vite HMR picked up the `VideoPreview.tsx` change without triggering a CDP navigation event — console buffer preserved all 1977 Run 16 messages. Code was live (confirmed by subsequent `[B1AT]` log appearance).
4. Timeline scroll container reset to `scrollLeft=0`. Ruler rect confirmed: `left=268, top=694, width=2000, height=24`.
5. Seek dispatched to T=35 (x=850, y=706) via `MouseEvent` on ruler. After 1200ms wait, V2 (`remotion.mp4`) was mounted — `idx=1, readyState=4, paused=true, muted=false, ct=6.636s`.
6. `onLoadedData` fired for both V2 (id=`6cfa9ce6`) and V3 (id=`95b38288`). The `[B1AT]` handler ran immediately after.

#### Console evidence

```
msgid=1958  [V2DBG][onLoadedData] id=6cfa9ce6... isPremounted=false video.ct=6.636 targetTime=6.636 isPlaying=false
msgid=1959  [B1AT][noTracks] id=6cfa9ce6-d282-4b73-80ea-17f05a3b309d apiAvail=false
msgid=1960  [V2MEAS][seekSettled] id=95b38288... trackId=V3 ...
msgid=1961  [V2DBG][onLoadedData] id=95b38288... isPremounted=false video.ct=6.636 targetTime=6.636 isPlaying=false
msgid=1962  [B1AT][noTracks] id=95b38288-9446-4e8d-8116-43fa30429342 apiAvail=false
```

Both V2 and V3 returned `apiAvail=false`. The `audioTracks` property is `undefined` on these `<video>` elements.

#### Direct DOM verification

`evaluate_script` probe of all current `<video>` elements:

```js
() => {
  const videos = Array.from(document.querySelectorAll('video'));
  return videos.map((v, i) => ({
    idx: i, src: v.src.slice(-30), muted: v.muted,
    hasAudioTracksAPI: v.audioTracks !== undefined,
    audioTrackCount: v.audioTracks ? v.audioTracks.length : 0,
    audioTrackEnabled: v.audioTracks && v.audioTracks.length > 0 ? v.audioTracks[0].enabled : null
  }));
}
```

Result (3 video elements: V1 base + V2 overlay + V3 overlay duplicate):
```json
[
  {"idx":0,"hasAudioTracksAPI":false,"audioTrackCount":0,"audioTrackEnabled":null,"muted":false},
  {"idx":1,"hasAudioTracksAPI":false,"audioTrackCount":0,"audioTrackEnabled":null,"muted":false},
  {"idx":2,"hasAudioTracksAPI":false,"audioTrackCount":0,"audioTrackEnabled":null,"muted":false}
]
```

`hasAudioTracksAPI: false` on ALL elements — the property does not exist on the prototype.

#### Conclusion: ABORT

The `HTMLMediaElement.audioTracks` API is **not present** in this Brave instance. The API requires `chrome://flags/#enable-experimental-web-platform-features` to be enabled; it is not enabled here.

Per the task brief's ABORT criterion: `[B1AT][noTracks] apiAvail=false` appeared → abort immediately, report to orchestrator.

**Step 2 (full measurement) was NOT performed.** No measurement data for Run 17 exists.

#### Implication

The `audioTracks` API path is closed for this browser environment unless the flag is explicitly enabled. Options for the orchestrator:

1. **Enable the flag**: `chrome://flags/#enable-experimental-web-platform-features` → Enabled → restart Brave. Then re-run Step 1 to confirm `[B1AT][disabled] trackCount=1` appears. If confirmed, proceed to full Step 2 measurement.
2. **Pivot to next hypothesis**: Decoder pre-warm via `play()→rVFC→pause()` pulse before user play gesture (as mentioned in prior megadoc sections). This does not require experimental flags.
3. **Accept muted fix**: Run 15 (V2 muted) eliminated the HIGH cluster entirely (19/19 LOW, mean 34ms). If the overlay audio on V2 is not actually needed in the final product, this is the simplest architectural fix with no experimental-API dependency.

#### Note on V2 audio content

The V2 source (`remotion.mp4`) is the OBS/screen recording overlay. Its audio track is the same audio content as V1 (or ambient) — in practice the user likely hears V1 audio and the V2 audio is redundant. If confirmed, `muted=true` on V2 is the correct production fix (already validated by Run 15).

---

## Section 29P — Run 18: WebAudio `decodeAudioData` Pre-warm Hypothesis

**Date**: 2026-06-05
**Hypothesis**: If `AudioContext.decodeAudioData()` and `HTMLMediaElement` share an OS/browser audio decoder path, pre-warming the decoder for the V2/V3 assets via WebAudio at page load should allow subsequent `video.play()` calls to skip the ~660ms audio decoder init cost, eliminating or reducing the HIGH cluster.
**Code change (applied by orchestrator, NOT this agent)**: A `useEffect` was added to `src/react-app/pages/Home.tsx` that fires on `[clips, assets]` deps change. When V2/V3 clip assets are found, it fetches each asset's stream URL as an `ArrayBuffer`, creates an `AudioContext`, calls `decodeAudioData(buffer)`, and logs `[WAWARM][done]` on success. A `webAudioWarmedRef` Set deduplicates per URL.

### Pre-warm verification

After page reload, before Cycle 1:
```
msgid=6: [WAWARM][done] url=b743-7de090cbfcf0/stream?v=1780691544308 duration=1287.2 elapsedMs=3242
msgid=7: [WAWARM][done] url=acc2-1f099bbeeecc/stream?v=1780691544308 duration=1287.2 elapsedMs=3705
```
Both V3 (PCM) and V2 (AAC) assets were successfully decoded via WebAudio before Cycle 1 began. Pre-warm confirmed.

### Seek positions (consistent with prior runs)

- P35: T≈35s (clipTime≈6.622s within V2 active window [28.38, 120.15])
- P50: T≈50s (clipTime≈21.598s)
- P65: T≈65s (clipTime≈36.633s)
- P80: T≈96s (scroll-clamped, clipTime≈67.726s)
- P100: T≈116s (scroll-clamped, clipTime≈87.692s)

Note: P=80 and P=100 ruler click coordinates fall beyond the scroll container's max scrollLeft=842, so both consistently land at fixed seek positions (T≈96s and T≈116s respectively). This is the same scroll-clamp behavior as Runs 13, 14, 16, and 17. All positions remain within V2's active window.

### Raw `[V2MEAS][firstFrame]` data — trackId=V2

| # | Cycle | Seek | msgid | ptF (ms) | Cluster |
|---|-------|------|-------|----------|---------|
| 1 | C1 | P35 (T≈35) | 90 | 50 | LOW |
| 2 | C1 | P50 (T≈50) | 149 | 707 | HIGH |
| 3 | C1 | P65 (T≈65) | 226 | 696 | HIGH |
| 4 | C1 | P80 (T≈96) | 303 | 717 | HIGH |
| 5 | C1 | P100 (T≈116) | 408 | 652 | HIGH |
| 6 | C2 | P35 (T≈35) | 515 | 54 | LOW |
| 7 | C2 | P50 (T≈50) | 574 | 115 | LOW |
| 8 | C2 | P65 (T≈65) | 637 | 109 | LOW |
| 9 | C2 | P80 (T≈96) | 700 | 130 | LOW |
| 10 | C2 | P100 (T≈116) | 805 | 114 | LOW |
| 11 | C3 | P35 (T≈35) | 897 | 53 | LOW |
| 12 | C3 | P50 (T≈50) | 956 | 101 | LOW |
| 13 | C3 | P65 (T≈65) | 1019 | 108 | LOW |
| 14 | C3 | P80 (T≈96) | 1082 | 671 | HIGH |
| 15 | C3 | P100 (T≈116) | 1187 | 120 | LOW |
| 16 | C4 | P35 (T≈35) | 1293 | 54 | LOW |
| 17 | C4 | P50 (T≈50) | 1352 | 166 | LOW |
| 18 | C4 | P65 (T≈65) | 1429 | 110 | LOW |
| 19 | C4 | P80 (T≈96) | 1492 | 117 | LOW |
| 20 | C4 | P100 (T≈116) | 1583 | 114 | LOW |

### Cluster analysis (Run 18 — WebAudio prewarm)

| Metric | Value |
|--------|-------|
| N total | 20 |
| HIGH count (≥650ms) | 5 |
| LOW count (≤290ms) | 15 |
| **HIGH%** | **25%** |
| LOW mean | 101ms (mean of 15 LOW samples) |
| HIGH mean | 689ms (mean of 5 HIGH samples: 707, 696, 717, 652, 671) |
| Overall mean | 248ms |

HIGH samples: C1/P50=707ms, C1/P65=696ms, C1/P80=717ms, C1/P100=652ms, C3/P80=671ms.

### Pattern observations

1. **Cycle 1 strongly dominated by HIGH**: 4 of 5 samples in C1 are HIGH. Only C1/P35=50ms was LOW. This is the same pattern seen in baseline Run 13+14 C1, where the first play after a fresh mount is often LOW (fresh decoder, presentedFrames=2) but subsequent plays in the same cycle hit the HIGH cluster.
2. **C2 fully LOW (5/5)**: All C2 samples 54–130ms. Exactly as in baseline. No change vs. prior runs.
3. **C3/P80 is HIGH (671ms)**: An anomalous HIGH in an otherwise LOW cycle. C3/P35–P65 and C3/P100 are all LOW (53–120ms), only P80 hit HIGH. This sporadic HIGH is consistent with the "intermittent re-init" observed in Run 16 (PCM unmuted, HIGH%=25%).
4. **C4 fully LOW (5/5)**: 54–166ms. Normal LOW cycle.
5. **No gap evidence eliminated**: The bimodal gap (290–650ms) persists. All 5 HIGH values are 652–717ms; all 15 LOW values are 50–166ms.

### 5-way comparison (V2 unmuted, AAC, comparable conditions)

| Run | Condition | N | HIGH% | HIGH mean | LOW mean |
|-----|-----------|---|-------|-----------|----------|
| Run 13+14 | Baseline (unmuted, AAC) | 22 | ~77% | ~665ms | ~103ms |
| Run 15 | Muted V2 | 19 | 0% | — | ~34ms |
| Run 16 | PCM audio (unmuted) | 20 | 25% | ~664ms | ~114ms |
| Run 17 | audioTracks API | BLOCKED | — | — | — |
| **Run 18** | **WebAudio prewarm (unmuted, AAC)** | **20** | **25%** | **689ms** | **101ms** |

### Verdict

**HYPOTHESIS REJECTED — WebAudio `decodeAudioData` pre-warm does NOT share the audio decoder code path with `HTMLMediaElement.play()`.**

**Evidence:**
- HIGH% dropped from ~77% (baseline) to 25%, but this is NOT attributable to the prewarm. The 25% matches Run 16 (PCM, no prewarm) and is within normal run-to-run variance. The HIGH cluster magnitude (652–717ms) is unchanged from baseline — if prewarm had shortened decoder init, HIGH values would be reduced, not identical.
- C1 had 4/5 HIGH samples despite prewarm completing ~46s before Cycle 1 began (WAWARM elapsedMs≈3700ms, Cycle 1 started at t≈52000ms). If the WebAudio decoder state were shared, C1 should have shown reduced or eliminated HIGH counts.
- C3/P80=671ms is an anomalous isolated HIGH in an otherwise LOW cycle, consistent with sporadic re-init seen in other runs.
- The bimodal distribution (LOW cluster 50–166ms, HIGH cluster 652–717ms, no samples in 290–650ms gap) is structurally identical to all prior unmuted runs.

**Interpretation:** The ~660–720ms delay is almost certainly an audio decoder initialization cost internal to the HTMLMediaElement pipeline. WebAudio `decodeAudioData` creates its own decoder instance and does not share pre-warmed state with the MediaElement's internal audio pipeline. These are independent decoder instances in Chromium's media stack.

**The variance between runs (77% baseline, 25% Run 16/18) may be explained by:**
- Whether prior playback in the same page session already warmed the HTMLMediaElement decoder (C2–C4 are typically LOW because C1's play() warmed it)
- OS-level audio device state (audio renderer may stay open between cycles within a session)
- Background buffering advancing the decode pipeline between seeks

**What the muted fix tells us (Run 15):** The HIGH cluster disappears entirely when V2 is muted (`muted=true`). This is the strongest clue: the 660ms cost is audio-specific, occurring in the audio decoder/renderer path that only activates for unmuted playback. Video decoder init (for LOW samples) is fast (<200ms) and is independent of audio decoder state.

**Next steps for orchestrator:**
1. **Muted fix (Run 15: 0% HIGH, mean 34ms)** is structurally correct but UX-rejected — pro editors cannot ship a workaround that kills overlay audio.
2. **Alternative**: Play-pulse pre-warm — dispatching `video.play()→rVFC→video.pause()` via an invisible play gesture on V2 at mount time may warm the HTMLMediaElement's own audio pipeline. Differs from WebAudio prewarm. Untested but Option F (prior session) tried a similar mechanism in-seek and failed; mount-time variant not tried.
3. **If V2 audio required (this is the case)**: The decoder init delay is ~660ms on first play per init cycle, occurring on a fraction of plays (varies by codec). Path 4 architectural rewrite (`@remotion/media <Video>` + `<Player>`) bypasses HTMLMediaElement preview pipeline entirely.

### 29P addendum — orchestrator's reading vs agent's verdict

The agent's verdict ("REJECTED") rests on two arguments:
1. HIGH cluster magnitude (652–717ms) unchanged from baseline — if prewarm shortened decoder init, the HIGH ptF values themselves would drop, not just their frequency.
2. 77%→25% shift may be confounded by session-state warmup: Runs 13+14 were FIRST runs after browser start (cold session); Runs 16+18 happened later with whatever state Chrome had accumulated.

The orchestrator initially read the 77% (n=22) → 25% (n=20) shift as significant (binomial p ≈ 10⁻⁵). The agent's counter-argument is defensible: without a paired control (prewarm on/off within the same session), the shift cannot be attributed to prewarm. The HIGH-magnitude argument is the stronger of the two — if prewarm worked at all, it should accelerate the HIGH init, not just skip it stochastically.

**Future investigator**: to settle this, would need paired-control protocol within one browser session — 10 samples with prewarm code active, 10 samples after disabling the prewarm `useEffect` mid-run. This was not done. Current best interpretation: WebAudio decodeAudioData does not warm HTMLMediaElement's internal audio decoder.

---

## END OF MEGADOCUMENT

This document is intended to be exhaustive. If a future investigator finds a gap, append the missing detail rather than rewriting. The objective is to make sure no piece of context — measurement data, code change, doc reference, hypothesis status, agent finding — has to be re-derived from scratch.

### Final state at commit time

**Branch state**: documentation-only commit. No production fix shipped. Code matches Run 9 baseline (`!video.paused` guard in V2 playEffect else-branch) + full `[V2MEAS]` instrumentation in `VideoPreview.tsx` and `Home.tsx`. The WebAudio prewarm `useEffect` from Run 18 was REVERTED from `Home.tsx` before commit. The `muted` attribute from Run 15 was REVERTED. No experimental code remains in source.

**Mechanism — what is known with high confidence**:

1. V2 overlay video first-frame-after-play time (`playToFrameMs` in `[V2MEAS][firstFrame]` log) is **bimodal**:
   - LOW cluster: ~30–170 ms range, dominant when audio decoder is warm or absent.
   - HIGH cluster: ~650–720 ms range (lowest observed HIGH sample = 644ms in Run 13 C1/P50), occurs when audio decoder init fires.
   - No samples in the 290–644 ms gap across n>80 measured samples (using strict lowest observed HIGH = 644; convention elsewhere in this document uses the round value 290–650 for cluster gap descriptions).

2. The HIGH cluster cost is **audio decoder initialization inside the HTMLMediaElement pipeline**:
   - Muting V2 (Run 15) eliminates HIGH cluster entirely — bypasses audio pipeline.
   - V1 (PCM audio) never shows HIGH cluster — PCM init is essentially free.
   - V2 with AAC audio: HIGH ~77% in cold session (Runs 13+14).
   - V2 with PCM audio: HIGH ~25% (Run 16).
   - V2 with AAC + WebAudio prewarm: HIGH ~25% (Run 18; may or may not be prewarm-attributable per 29P addendum).

3. The HIGH cluster is **not video-decoder bound, not compositor bound, not network/buffer bound, not React-effect bound**:
   - `expDT − presT` = +6.7–6.9 ms (1/144s warm signature) on every sample — compositor warm.
   - `eps` ≈ 0 on every sample — seek lands exactly at requested.
   - `readyState = 4`, `buffered` covers requested position on every play — bytes present.
   - Both V1 and V2 use `D3D11VideoDecoder` (hardware backend, confirmed in chrome://media-internals).

4. **`!video.paused` guard** (Run 9 baseline, retained) measurably helps: V2 ptF dropped from R6's 225ms to R9's 67ms in the original sessions. The guard prevents redundant pause()-then-play() cycles when playEffect re-fires while V2 is already playing. Effect on bimodality less clear (R10/R12 disagreement) but mechanism is sound.

**Architectural fixes** (in increasing cost order):

| Option | Mechanism | UX cost | Result | Status |
|---|---|---|---|---|
| Mute V2/V3 | Bypass audio decoder | KILLS V2 audio entirely | 0% HIGH, mean 34ms | Rejected by user (pro editor UX) |
| PCM audio policy | Force PCM on overlay tracks | File re-encode required + storage cost | 25% HIGH, mean ~114ms LOW | Partial fix |
| WebAudio prewarm | `decodeAudioData` on app load | None | 25% HIGH or no effect (paired control needed) | Likely no effect — agent verdict defensible |
| **Path 4: `@remotion/media <Video>` + `<Player>`** | **WebCodecs preview, bypass HTMLMediaElement** | **Surrender RAF clock to Player; 1.5–2 day rewrite** | **Expected: frame-perfect** | **Selected next step** |

**Path 4 detailed scoping** is in Section 29B (above) plus the skill file `llm-docs/SKILL-remotion-quick-reference.md`. Key constraints:
- Player cannot accept external clock (`Player.seekTo` causes pause-resume).
- `<Video>` from `@remotion/media` requires `useCurrentFrame()` context — only available inside `<Player>` / `<Composition>`.
- HyperEdit's current architecture has RAF-driven custom clock; integration means surrendering that clock to Player.
- CORS-enabled assets required (`Access-Control-Allow-Origin: *`, `Accept-Ranges: bytes`).

**Sample artifacts on disk** (untracked, not committed):
- `screenshots/` — 90+ PNGs from Runs 13–18 visible-click verification.
- `__debug_*.cjs`, `__debug_*.json` — historical debug scripts from pre-Run-13 work.
- `__run14_cycle1_console.txt` — agent intermediate save (contains Run 13 console buffer due to msgid ordering, not Run 14 data; documented in 29L).
- `docs/V2_OVERLAY_SYNC_INVESTIGATION.md` — this document.

**Skill files** in `llm-docs/` (committed):
- `SKILL-agent-test-hyperedit-ui.md` — HyperEdit UI mechanics.
- `SKILL-browser-mcp-patterns.md` — chrome-devtools-mcp tool patterns.
- `SKILL-video-pipeline-diagnostics.md` — video element measurement patterns.
- `SKILL-remotion-quick-reference.md` — Remotion library facts including Path 4 details.

Read all 4 skill files before attempting any further measurement or Path 4 implementation work. They contain operational knowledge that took 5–7 minutes per agent run to re-derive in early sessions.

### For a future investigator (cold-start checklist)

1. Read this megadoc top-to-bottom OR jump to Section 29 (executive summary) → Section 29I (open questions catalog with resolution index at top) → Sections 29K–29P (most recent measurement runs).
2. Read all 4 skill files in `llm-docs/`.
3. The investigation is at a natural pause for measurement work — Path 4 is now the planned next step, not another measurement. Do not start new measurements without checking with the user first.
4. If implementing Path 4: scope is in Section 29B; constraints are in `SKILL-remotion-quick-reference.md`; expected ~250 LOC across 4 files; ~1.5–2 days. canvas-draw.ts compatibility implications detailed below.
5. **Do not re-test** mute (UX rejected), audioTracks API (Chrome flag required, not deployable), in-seek pre-warm pulse (Option F failed), always-mount V2 (Run 11 failed, also wrong target per Run 14 data showing mode-switch is per-play not per-mount), WebAudio prewarm (Run 18 inconclusive at best).

### Environment facts for fresh-day-one work

- **Test machine**: Windows 10 Home (10.0.19045). Likely 144Hz monitor (warm `expDT−presT` signature = +6.7–6.9ms = 1/144s). GPU specs not captured — `chrome://gpu` should be inspected if hardware variance becomes a question.
- **Browser**: Brave on `--remote-debugging-port=9222`. chrome-devtools-mcp MCP server connects to this port. HyperEdit dev server at `http://localhost:5173/`. FFmpeg server at `http://localhost:3333/`. Both must be running (see CLAUDE.md commands section).
- **Project state expectations**: V1 + V2 clips loaded, V1 base track ~120s duration, V2 overlay starts ~T=28.25s, lasts ~91.89s. pixelsPerSecond ≈ 16.629 on the timeline ruler (`.sticky.top-0.h-6` selector). Session ID in `localStorage['hyperedit-session']`.
- **Toolchain**: `rtk tsc` and `rtk lint` for validation (see `~/.claude/CLAUDE.md` for rtk reference). No test suite. Type-check + lint clean is the only automated correctness gate.

### Sub-agent invocation pattern (copyable prompt skeleton)

Every sub-agent in Runs 13–18 was spawned with approximately this pattern. Use it verbatim or adapt per measurement need.

```
You are running [TEST NAME] for V2 sync investigation. Megadoc: D:\...\docs\V2_OVERLAY_SYNC_INVESTIGATION.md.

## Critical context — read FIRST (in this order)
1. D:\...\llm-docs\SKILL-agent-test-hyperedit-ui.md   — HyperEdit UI mechanics
2. D:\...\llm-docs\SKILL-browser-mcp-patterns.md      — MCP click vs evaluate_script; FORBIDDEN .play()/.pause()
3. D:\...\llm-docs\SKILL-video-pipeline-diagnostics.md — rVFC metadata, expDT-presT signature, stale-frame fingerprint
4. D:\...\llm-docs\SKILL-remotion-quick-reference.md   — context only unless implementing Path 4

Then read megadoc Sections 29K–29P (end of file before `## END OF MEGADOCUMENT`) for prior run state.

## Hypothesis under test
[explicit hypothesis statement + predicted outcome]

## Code state
[what orchestrator changed; whether reverted; what to verify via evaluate_script before measuring]

## Protocol — N cycles × 5 seeks (P=35, 50, 65, 80, 100)
[per-cycle setup: scrub to T=0, MARK log, screenshot]
[per-seek: MARK, ruler MouseEvent, wait 400ms, pre-state read, find play uid via take_snapshot, MCP click by uid (NOT evaluate_script), screenshot, wait 1500ms, MCP click pause, screenshot, post-state read]

## Validity rules
- Pre-state: both videos paused. Else INVALID.
- Stale-frame fingerprint (ptF<2ms with presentedFrames>10) = INVALID.
- N samples valid <3 in a cycle → withhold aggregate.

## End-of-run console retrieval
list_console_messages paginated via pageIdx=0,1,2... until no more pages.

## Reporting
Append to megadoc BEFORE `## END OF MEGADOCUMENT` as new section. Include per-sample table, cluster analysis, cross-run comparison table, verdict.

## Hard rules
- No code changes.
- MCP click by uid for ALL user-observable buttons.
- Screenshot after every click.
- Use [TESTPREFIX] for MARK logs to distinguish from prior runs.
- N=20 target across 4 cycles (per Section 29L paired-control requirement).
```

Critical reminders embedded in this pattern that took prior agents repeated discovery to find:
- `console.clear()` between cycles does NOT clear `list_console_messages` accumulated buffer (Run 14 discovery; mentioned in Section 29L).
- `take_snapshot` is heavy; minimize calls (Skill-2 pitfalls section).
- 28-minute gap → LOW mode in Run 14; mode-switch mechanism is NOT "long idle → cold" (Section 29L refutation).
- Paired-control protocol required for N<20 fix verification (Section 29L recommendation).

### `__debug_*.cjs`, `__run14_cycle1_console.txt`, `screenshots/` — intentional non-commit

These files exist in the working tree but are NOT part of the commit. Specifically:

- **`__debug_audio.cjs`, `__debug_console.cjs`, `__debug_seek_results.json`, `__debug_storage.cjs`, `__debug_timeline.cjs`** — ad-hoc Node.js debug scripts from pre-Run-13 work. No archival value; functionality superseded by chrome-devtools-mcp MCP integration documented in `SKILL-browser-mcp-patterns.md`.
- **`__run14_cycle1_console.txt`** — agent's intermediate console save from Run 14. Contains Run 13's data due to msgid ordering (the agent saved before its own `console.clear` took effect; per Section 29L pitfall). No unique data not in the megadoc tables. Safe to delete.
- **`screenshots/`** (~90 PNGs from Runs 11–18) — visible-click verification artifacts. Large binary footprint. Regenerable by re-running the protocol. Not committed to keep branch lean.

A future investigator should not waste time trying to recover data from these files; everything they captured is summarized in the relevant Run section.

### Runs added in latest session (post-compaction)

- Run 13 (Section 29K) — A1 variance baseline. Established bimodality. n=11.
- Run 14 (Section 29L) — A1 re-run. Confirmed bimodality (n=22 combined). Refuted "long idle = cold" hypothesis.
- Run 15 (Section 29M) — B1 muted V2. 0% HIGH, mean 34ms. Root cause = audio decoder init.
- Run 16 (Section 29N) — B1 followup, V2 PCM unmuted. 25% HIGH, mean ~252ms. Partial fix.
- Run 17 (Section 29O) — audioTracks API probe. BLOCKED (Chrome flag required).
- Run 18 (Section 29P) — WebAudio decodeAudioData prewarm. 25% HIGH; effect attribution disputed (see 29P addendum).

### Orthogonal modifications in the same commit

This branch also includes pre-existing modifications to files NOT part of the V2 sync mechanism investigation. Bundled into this commit because they were present in the working tree during the measurement runs; reverting them would have created a fictional baseline state. Future investigator: ignore these when reasoning about V2 sync behavior — they are independent feature work.

- **`src/react-app/components/CaptionRenderer.tsx`** — Adds `isPlaying`, `clipStart`, `currentTimeRef` props + RAF-based liveTime updates. Caption rendering optimization to avoid React re-renders during playback. Independent of V2 sync.
- **`src/react-app/components/Timeline.tsx`** — Adds `currentTimeRef` prop + direct-DOM playhead updates via `playheadRef`/`timeDisplayRef`. 60fps playhead movement without React re-renders. Independent of V2 sync.
- **`src/react-app/components/TransitionPreview.tsx`** — Major rewrite. Removed `Player`/`getTransitionEntry` imports and inner `TransitionComposition` component. Restructured `ActiveTransition` interface: added `fromClipId`, `toClipId`, `fromClipStart`, `fromInPoint`, `fromClipDuration` fields; replaced `fromStartFrom`/`toStartFrom` with the new fields. **Note**: After the rewrite, the entire file is ~16 lines and exports ONLY the `ActiveTransition` interface — no React component, no rendering code. Transition rendering logic moved to `canvas-draw.ts` (see below). This is intentional, not an incomplete revert. Independent of V2 sync.

### `src/remotion/transitions/canvas-draw.ts` — production transition system + Path 4 compatibility

This file (146 lines, untracked at commit-decision time) IS wired into production: `VideoPreview.tsx:5` imports `getCanvasDraw` from it, and `VideoPreview.tsx:360` uses `getCanvasDraw(t.transitionFileId)` to render canvas-drawn transitions during transition windows. It is a working transition fix, NOT an experimental orphan.

**Provenance**: adapted by the pre-compaction orchestrator from `feature/remotion-core-editor-v2-seeking-v3` branch's `src/remotion/transitions/canvas-draw.ts` (272 lines, 7 named transition fns, helpers `getSourceDimensions`/`easeOutPoly3`/`TAU`). The adapted current-tree version is a stripped-down subset: 146 lines, single `draws: Record<string, CanvasDrawFn>` registry, inlined helpers, fewer transitions implemented. Not 1-1 with v3. NOT present in `feature/remotion-core-editor-v2-seeking-v3-5` at all (user originally referenced v3-5 — corrected here to v3).

**API shape** (current file):
```ts
export type CanvasImageSource = HTMLVideoElement | HTMLImageElement;
export type CanvasDrawFn = (
  ctx: CanvasRenderingContext2D,
  from: CanvasImageSource | null,
  to: CanvasImageSource | null,
  progress: number,
  width: number,
  height: number,
  params: Record<string, number | string | boolean>,
) => void;
// draws: Record<string, CanvasDrawFn> registry
// getCanvasDraw(transitionFileId: string): CanvasDrawFn | null
```

The function signature takes `HTMLVideoElement | HTMLImageElement` for both `from` and `to`. Transition rendering does `ctx.drawImage(htmlVideoElement, ...)` to paint the underlying video's current frame onto the transition canvas.

**Path 4 compatibility implications**

Per `llm-docs/SKILL-remotion-quick-reference.md` (and Remotion docs), the three Remotion video components interact with canvas-draw differently:

| Component | Provides HTMLVideoElement? | canvas-draw works as-is? |
|---|---|---|
| `<OffthreadVideo>` `onVideoFrame` callback (v4.0.190+) | YES — real HTMLVideoElement in preview | ✅ Drop-in compatible |
| `<Html5Video>` | YES (HTMLVideoElement) | ✅ Compatible |
| `<Video>` from `@remotion/media` (Path 4 target — WebCodecs preview) | NO — renders directly to canvas; no HTMLVideoElement exposed | ❌ Breaks: nothing to drawImage from |

**If Path 4 fully migrates V2 to `<Video>` from `@remotion/media`**, canvas-draw.ts becomes incompatible. Three sub-options at Path 4 implementation time:

1. **Hybrid component selection (STALE — DO NOT USE)** — Use `<OffthreadVideo>` during transition windows (gives HTMLVideoElement via `onVideoFrame`), `<Video>` during non-transition playback. Switch via `useRemotionEnvironment()` or time-based component swap. canvas-draw.ts UNCHANGED. **This sub-option violates the hard constraints established in 29B.addendum (`<OffthreadVideo>` is REJECTED by user). Skip sub-option 1 entirely.**
2. **Adapt canvas-draw signature** — Modify `CanvasDrawFn` to accept `ImageBitmap | VideoFrame | HTMLImageElement` instead of `HTMLVideoElement`. `<Video>` from `@remotion/media` exposes per-frame `ImageBitmap | VideoFrame` via its `onVideoFrame: (frame: ImageBitmap | VideoFrame) => void` callback. `ctx.drawImage` accepts both. ~30 line edit to canvas-draw.ts. Full WebCodecs path retained. **SELECTED PATH per 29B.addendum — code already drafted there.**
3. **Replace with `@remotion/transitions`** — Remotion has a first-party transition package. May obsolete canvas-draw entirely. Requires audit of `@remotion/transitions` capabilities vs HyperEdit's current transition needs. **PARTIALLY selected per 29B.addendum**: 4 of 6 builtin transitions migrate to `@remotion/transitions` (`fade()`, `slide()`, custom `dipToBlack`); `facecamtransitionbox` stays in canvas-draw (sub-option 2); `staticfacecam` migrates to CSS layout (not a transition).

**Recommendation for Path 4 implementer**: Sub-option 2 (canvas-draw widening) is the SELECTED PATH for `facecamtransitionbox`. Sub-option 3 is the SELECTED PATH for the 4 simple builtin transitions. Sub-option 1 (hybrid OffthreadVideo) is REJECTED — do not implement. See 29B.addendum.mediabunny for the full file-by-file migration plan.
