# Video Pipeline Diagnostics

Patterns for diagnosing HTML5 `<video>` decoder + compositor pipeline performance. Use this when investigating playback latency, sync drift, decoder cold-start, or any "video doesn't behave as expected" problem.

## The three latency dimensions

When `video.play()` is called, three pipelines must align before the first frame appears on screen:

1. **Demuxer / network** — bytes fetched, container parsed, codec frames extracted.
2. **Decoder** — encoded frames → decoded pixel buffers (NV12 / YUV420P).
3. **Compositor** — decoded buffer → GPU texture → screen.

Each can be warm (recently active) or cold (just initialized). Cold compositor has no frame lookahead. Cold decoder must walk forward from prior IDR. Cold demuxer must issue HTTP range requests and wait for bytes.

Most "video is slow to start" bugs trace to ONE of these being cold. Knowing which is cold is the diagnosis.

## requestVideoFrameCallback (rVFC) is the primary tool

`HTMLVideoElement.prototype.requestVideoFrameCallback(callback)` registers a one-shot callback for the next presented frame. The callback receives `(now, metadata)` where:

- `now`: `DOMHighResTimeStamp` (same clock as `performance.now()`).
- `metadata`: a `VideoFrameCallbackMetadata` object exposing:
  - `mediaTime` — the decoded frame's position in media time
  - `presentationTime` — wall-clock when frame was presented to compositor
  - `expectedDisplayTime` — wall-clock when frame is expected to reach screen (compositor lookahead)
  - `processingDuration` — decoder pipeline time for this frame
  - `presentedFrames` — cumulative count of frames presented by this video element
  - `captureTime` — for live capture, source time (usually `undefined` for files)

### Pattern: measure first-frame after play

```ts
const playT0 = performance.now();
video.play().catch(() => {});
video.requestVideoFrameCallback((now, meta) => {
  console.log(`firstFrame ms=${(now - playT0).toFixed(0)} expDT=${meta.expectedDisplayTime.toFixed(2)} presT=${meta.presentationTime.toFixed(2)} processing=${meta.processingDuration.toFixed(4)} pF=${meta.presentedFrames}`);
});
```

### Pattern: dedupe across effect re-runs

If `playEffect` re-fires (e.g., layers prop instability), multiple rVFC may queue. Use a session counter:

```ts
const measSessionRef = useRef(0);
// On play start:
measSessionRef.current += 1;
const session = measSessionRef.current;
const playT0 = performance.now();
video.play();
video.requestVideoFrameCallback((now, meta) => {
  if (session !== measSessionRef.current) return; // stale
  // log
});
```

## The compositor warm/cold signature

`expectedDisplayTime − presentationTime` is the compositor's frame-presentation lookahead. The values you'll see:

- **0.0 ms** = no lookahead. Frame is being presented synchronously with decoder output. Compositor pipeline is COLD. Either this is the very first frame of the session, OR the decoder just resumed from suspend, OR something flushed the pipeline.
- **+6.9 ms** (1/144 s) = warm pipeline on a 144 Hz monitor. Compositor has next-frame ready and can predict its presentation time.
- **+16.7 ms** (1/60 s) = warm pipeline on 60 Hz monitor.
- **Other** = test machine has unusual refresh rate. Lookahead = 1 / display_hz.

This signature is the most reliable "is the pipeline warm" indicator. If both V1 and V2 show `+lookahead` after play, compositor is fine. If V2 shows 0.0 while V1 shows `+lookahead`, V2's pipeline cold-started but V1's didn't.

## presentedFrames as decoder lifecycle signal

`metadata.presentedFrames` is cumulative per video element instance. It tells you whether the decoder is:
- **Same as before** (high number, monotonically increasing): decoder kept alive, just delivering frames as normal.
- **Reset to small number** (single digits): fresh decoder instance. The video element was either remounted in DOM, or Chrome re-initialized the decoder (e.g., after navigation, after suspend that exceeded an internal timeout).

Use this instead of mount/unmount logs (which are unreliable — see Pitfall section below) when you need to know if the decoder restarted.

## rVFC stale-frame fingerprint

`playToFrameMs` values of -2, -1, 0, 1 ms are a fingerprint of rVFC firing on an already-presented frame. This happens when:
- rVFC was scheduled while video was NOT paused at scheduling time
- The next frame was already in the compositor queue from prior playback

If you see these tiny values, the measurement is invalid — the video wasn't actually transitioning paused → playing. Re-check pre-state.

## mediaCapabilities — pre-runtime capability check

`navigator.mediaCapabilities.decodingInfo({type, video})` is async, returns `{supported, smooth, powerEfficient}` for a given codec spec.

```ts
const spec = {
  contentType: 'video/mp4; codecs="avc1.4D402A"', // h264 Main level 4.2
  width: 1920, height: 1080,
  bitrate: 723093, framerate: 60
};
const result = await navigator.mediaCapabilities.decodingInfo({ type: 'file', video: spec });
// { supported: true, smooth: true, powerEfficient: true }
```

`smooth: false` means Chrome expects choppy playback. `powerEfficient: false` means software decode fallback likely. Use to rule out codec-level rejection BEFORE diving into decoder pipeline details.

## played TimeRanges

`video.played` returns a `TimeRanges` object representing all media-time intervals that have been played. Use it to:
- Check whether audio decoder is keeping up with video — `played` advances with audio playback, not just video frame presentation.
- Detect A/V skew — compare `played` end against current `mediaTime`. If `played` ends at media-time T but `mediaTime` is T+200ms, video has presented frames that audio hasn't yet decoded.

```ts
const ranges = [];
for (let i = 0; i < video.played.length; i++) {
  ranges.push([video.played.start(i), video.played.end(i)]);
}
```

## chrome://media-internals deep dive

The browser exposes a per-tab media player diagnostic page at `chrome://media-internals`. Each `<video>` and `<audio>` element creates a Player entry with full pipeline state and event log.

### Navigation

```
1. mcp__plugin_chrome-devtools-mcp__new_page({ url: 'chrome://media-internals/' })
2. Switch back to your test tab and trigger video activity
3. select_page back to media-internals
4. Inspect player tree
```

### Reading player list

```js
() => Array.from(document.querySelectorAll('.tree-item')).map((el, i) => ({
  idx: i,
  classes: el.className, // 'active-player' or 'ended-player'
  text: el.textContent?.trim().slice(0, 200),
  fullUrl: el.querySelector('.player-name')?.title // truncated visible text; full URL in title attribute
}))
```

### Selecting a player

DON'T use MCP `click` — tree-items lack proper a11y roles. Use MouseEvent:

```js
() => {
  const target = document.querySelectorAll('.tree-item-header.selectable-button')[N]; // pick by index
  if (!target) return { error: 'no target' };
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { selected: !document.body.classList.contains('no-players-selected') };
}
```

After selection, `body` element loses class `no-players-selected`.

### Reading properties + event log

After selection, the properties panel and event log become available. Read via:

```js
() => {
  const props = {};
  document.querySelectorAll('.player-property-row, [class*="property"]').forEach(row => {
    const k = row.querySelector('[class*="key"], td:first-child')?.textContent?.trim();
    const v = row.querySelector('[class*="value"], td:last-child')?.textContent?.trim();
    if (k) props[k] = v;
  });
  const log = Array.from(document.querySelectorAll('.player-log-row, [class*="log-row"], tr')).map(
    r => r.textContent?.trim()
  ).filter(s => s && s.match(/^\d\d:\d\d:\d\d/));
  return { props, log };
}
```

### Key fields to capture

For decoder backend identification:
- `kVideoDecoderName` — string like `"D3D11VideoDecoder"` (hardware on Windows), `"MojoVideoDecoder"` (hardware abstraction), `"FFmpegVideoDecoder"` (software fallback).
- `kIsPlatformVideoDecoder` — boolean, `true` = hardware.
- `kAudioDecoderName` — `"FFmpegAudioDecoder"` is the standard for most codecs.

For pipeline state transitions in event log:
- `kStarting`, `kPlaying`, `kSeeking`, `kSuspended`, `kSuspending`, `kResuming` — pipeline state machine.
- `kPlay`, `kPause` — user-initiated events.
- `Effective playback rate changed from X to Y` — rate change observations.
- `dimensions` — frame size confirmation.
- `pipeline_buffering_state` — `BUFFERING_HAVE_ENOUGH` is the target state.

### Destroyed players

Players with class `ended-player` are unselectable. Their data is gone. Only `active-player` is inspectable.

## Common diagnostic patterns

### Is V2 in software decode fallback?

1. Open `chrome://media-internals/` in new tab.
2. Trigger V2 playback in test tab.
3. Select V2 player.
4. Read `kVideoDecoderName` and `kIsPlatformVideoDecoder`.

If `kVideoDecoderName === "FFmpegVideoDecoder"` → software fallback. Trigger codec/profile/level/bitrate that's incompatible with hardware decoder.

### Does the pipeline suspend between cycles?

Look in event log for `kSuspending` → `kSuspended` → `kResuming` transitions. If V2 suspends and V1 doesn't, that's the asymmetry.

### Is the buffer empty at play time?

Capture `[V2MEAS][playPrep]`-style log just before play():
```ts
const tr = video.buffered;
const ranges = [];
for (let i = 0; i < tr.length; i++) ranges.push([tr.start(i), tr.end(i)]);
console.log('readyState=' + video.readyState + ' buffered=' + JSON.stringify(ranges));
```

`readyState`:
- 0 = HAVE_NOTHING
- 1 = HAVE_METADATA
- 2 = HAVE_CURRENT_DATA
- 3 = HAVE_FUTURE_DATA
- 4 = HAVE_ENOUGH_DATA (target)

If buffered ranges don't include the playhead target time, byte fetch happens during play.

## Pitfalls

### Inline ref callback false positives

React calls inline `ref={(el) => {...}}` callbacks with `null` then the new element on EVERY render where the function identity changes. An inline lambda's identity changes every render. Therefore:

```tsx
<video ref={(el) => {
  if (el) console.log('mount');
  else console.log('unmount');
}} />
```

This logs many "mounts" and "unmounts" per session without any actual React mount/unmount happening. The DOM element is the same instance throughout.

For RELIABLE lifecycle logging, use a child component with `useEffect`:

```tsx
function VideoWithLifecycleLog({ src }) {
  useEffect(() => {
    console.log('REAL mount');
    return () => console.log('REAL unmount');
  }, []);
  return <video src={src} />;
}
```

OR use `useCallback` for the ref:

```tsx
const refCb = useCallback((el) => {
  if (el) console.log('mount');
  else console.log('unmount');
}, []); // stable identity
<video ref={refCb} />
```

### Test machine refresh rate matters

`expectedDisplayTime − presentationTime` warm value is `1 / display_hz`. Document the test machine's refresh rate when comparing measurements across sessions or hardware.

### Vite HMR can perturb tests

If Vite hot-reloads during a measurement, React tree updates, components may unmount/remount. Disable HMR for the dev server during long measurement sessions if necessary (rare — usually not an issue).

### Audio decoder init can mask video decoder cost

If video shows late first frame BUT compositor is warm (expDT−presT > 0), suspect audio decoder init blocking video. Test by temporarily muting (`video.muted = true`) and re-measuring. If first-frame latency drops, audio was the bottleneck.

## When the data disagrees with intuition

- Trust `presentedFrames` over mount/unmount logs.
- Trust `expDT − presT` over presentationTime alone.
- Trust `chrome://media-internals` event log timestamps over inferred state.
- Distrust any single measurement — Chrome decoder variance is 5–10× across runs. Always require 3+ baseline samples before comparing fixes.

## References

- W3C VideoFrameCallback spec: https://wicg.github.io/video-rvfc/
- W3C MediaCapabilities spec: https://www.w3.org/TR/media-capabilities/
- Chrome `chrome://media-internals` source: Chromium codebase `chrome/browser/media/...`
