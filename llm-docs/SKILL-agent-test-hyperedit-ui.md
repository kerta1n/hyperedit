# HyperEdit Agent UI Testing Skill

Reference for agents driving HyperEdit through Chrome DevTools MCP. Read this BEFORE attempting UI automation — saves the discovery pass that takes 5–7 minutes per cold agent.

## Companion skill files (in same `llm-docs/` directory)

- `SKILL-browser-mcp-patterns.md` — generic chrome-devtools-mcp patterns (click vs evaluate_script, take_snapshot, etc.). Read this if you're new to the MCP tooling.
- `SKILL-video-pipeline-diagnostics.md` — video element measurement patterns (rVFC metadata, mediaCapabilities, chrome://media-internals deep dive). Read this if investigating playback timing.
- `SKILL-remotion-quick-reference.md` — Remotion library facts. Read this when evaluating Remotion-based fixes.

This file is the HyperEdit-specific knowledge: where things are on screen, how to read project state, what makes HyperEdit different from a generic web app.

## Connection

- Brave runs with remote debugging on `localhost:9222`.
- Tooling: `mcp__plugin_chrome-devtools-mcp__*` only.
- Sequence: `list_pages` → identify HyperEdit tab (Vite dev server URL, typically `localhost:5173` or `localhost:5174`) → `select_page`.
- Reload: `evaluate_script` with `() => location.reload()`. Wait 3s for project auto-load.

## DOM landmarks (verified)

| Element | Selector / locator | Notes |
|---|---|---|
| V1 base video element | First `<video>` with `key="base-video"`; first in `document.querySelectorAll('video')` | Audio source. Always mounted when V1 clip in scene. |
| V2/V3 overlay video elements | Subsequent `<video>` elements in `document.querySelectorAll('video')` | Keyed by `${layer.id}-${layer.url}`. Unmount when out of scene (pre-mount window = 2s before clip.start, ends at clip.start+duration). |
| Timeline ruler | `.sticky.top-0.h-6` (verified more reliable than `[class*="ruler"]`) | Left edge x ≈ **268**, top y ≈ **694**, height = **24**. Re-confirm on each session — geometry shifts on resize. |
| Timeline scroll container | Parent of ruler | Right edge x ≈ **1462** (AI panel overlaps beyond this). Positions > 70s require `scrollLeft` adjustment first. |
| Playhead triangle | A `position:absolute` element on top of ruler | **BLOCKS `elementFromPoint` at its x position.** Workaround: dispatch MouseEvents directly on ruler element via `querySelector`, NOT via `document.elementFromPoint`. |
| Play/pause toolbar button | aria-label `Play` / `Pause`. Find via `take_snapshot`, locate the entry. | uid changes per snapshot. Single button toggles play/pause. |
| Timeline clip blocks | `[data-clip-id]`, or `[class*="clip"]` / `[class*="Clip"]` | Have `getBoundingClientRect`, sometimes dataset attrs. |

## Timeline coordinate math

Pixels-per-second on the ruler ≈ **16.629** (most common) — but Run 10 agent observed **16.667** in a session. Variance depends on aspect ratio toggle / panel resize. **Always re-measure per session.**

```js
// Verify on each session:
() => {
  const ruler = document.querySelector('.sticky.top-0.h-6');
  return ruler ? ruler.getBoundingClientRect().toJSON() : null;
}
```

To click ruler at project time `T` seconds:
```
x = rulerRect.left + T * pixelsPerSecond     // typically 268 + T*16.629
y = rulerRect.top + rulerRect.height / 2     // typically 694 + 12 = 706
```

Cross-check via a known clip: a clip with project-time `start = S` has `clipEl.rect.left ≈ rulerRect.left + S * pixelsPerSecond`. Compute pixelsPerSecond from two reference clips if you don't trust the default.

### Scrolling for positions >70s

The timeline scroll container's right edge is around x=1462 (AI panel begins beyond). For seeking to positions past about T=70s, the target pixel falls outside the visible area and `elementFromPoint` returns nothing useful. Before dispatching the click:

```js
((targetX) => {
  const scrollContainer = document.querySelector('.sticky.top-0.h-6').closest('[class*="overflow"]') ||
                          document.querySelector('.sticky.top-0.h-6').parentElement.parentElement;
  // adjust scrollLeft so target is within visible area
  const visibleCenter = scrollContainer.scrollLeft + scrollContainer.clientWidth / 2;
  if (targetX > scrollContainer.scrollLeft + scrollContainer.clientWidth - 100) {
    scrollContainer.scrollLeft = targetX - scrollContainer.clientWidth / 2;
  }
  return scrollContainer.scrollLeft;
})(targetXPixel)
```

Then dispatch the click after the scroll settles (one event loop tick, no setTimeout needed in evaluate_script).

### Seek dispatch pattern (works around playhead-blocking)

DO NOT use `document.elementFromPoint(x, y)` — at positions where playhead triangle overlaps, it returns the playhead element, not the ruler. Dispatch directly on the ruler:

```js
((x, y) => {
  const ruler = document.querySelector('.sticky.top-0.h-6');
  if (!ruler) return { error: 'no ruler' };
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
  ruler.dispatchEvent(new MouseEvent('mousedown', opts));
  ruler.dispatchEvent(new MouseEvent('mouseup', opts));
  ruler.dispatchEvent(new MouseEvent('click', opts));
  return { dispatched: true, rect: ruler.getBoundingClientRect().toJSON() };
})(targetX, targetY)
```

## Reading state

Master read for video elements (paste verbatim into `evaluate_script`):
```js
() => Array.from(document.querySelectorAll('video')).map((v, i) => ({
  index: i,
  src: v.src.slice(-40),
  paused: v.paused,
  currentTime: v.currentTime,
  readyState: v.readyState,
  buffered: Array.from({length: v.buffered.length}, (_, k) => [v.buffered.start(k), v.buffered.end(k)]),
  duration: v.duration,
}))
```

Read timeline clips:
```js
() => Array.from(document.querySelectorAll('[data-clip-id], [class*="clip"], [class*="Clip"]'))
  .slice(0, 30)
  .map(el => ({
    classes: el.className,
    rect: el.getBoundingClientRect().toJSON(),
    dataset: { ...el.dataset },
    text: (el.textContent || '').slice(0, 60),
  }))
```

## Reading project state without UI navigation

### localStorage session

The session ID is stored in `localStorage` under key `clipwise-session` as a JSON string:

```js
() => {
  const raw = localStorage.getItem('clipwise-session');
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return { sessionId: parsed.sessionId, name: parsed.name, createdAt: parsed.createdAt };
}
```

### Direct FFmpeg server query for full project state

The FFmpeg server at `localhost:3333` exposes the session's project state. Useful for verifying clip IDs, asset IDs, transitions, render settings without UI nav:

```bash
curl -s "http://localhost:3333/session/{SESSION_ID}/project"
```

Returns JSON:
```json
{
  "tracks": [{...}],
  "clips": [{ "id": "...", "assetId": "...", "trackId": "V2", "start": 28.26, "duration": 92.01, "inPoint": 0, ... }],
  "settings": { "width": 1920, "height": 1080, "fps": 30 },
  "transitions": [...],
  "timelineTransitions": [{ "id": "...", "startTime": 95.28, "durationSec": 2, "fromClipId": "...", "toClipId": "...", "transitionFileId": "facecamtransitionbox", ... }],
  "renderOptions": {...}
}
```

### Project duration vs source duration distinction

CRITICAL gotcha: Home.tsx's `duration` is `max(clip.start + clip.duration)` across all clips. The SOURCE video file's duration is often much longer:
- V1 source `C0001.MP4` = 21:52
- V2 source `2026-01-21 15-11-10 remotion.mp4` = 21:27
- Project duration (Home.tsx) = 2:00

The project stops at duration (`setIsPlaying(false)` in RAF loop). The source videos still have plenty of footage past that point. When agent observes "V1 looped to 0", that's not a real loop — likely a misread, or HyperEdit's handlePlayPause resetting on play-after-end.

### Reading agent's clipBoundaries

`Home.tsx` exposes nothing publicly, but `clipBoundaries` are computed from clips + transitions:
```
boundaries = [
  c.start for each clip,
  c.start + c.duration for each clip,
  c.start - 2 (PREMOUNT_SECS) for V2/V3 clips,
  t.startTime for each transition,
  t.startTime + t.durationSec for each transition
]
```

When predicting at what boundary `setCurrentTime` will fire during playback, compute from project state JSON.

## Actions

### Seek (timeline ruler click)

Programmatic dispatch via `evaluate_script` is acceptable for seeks — user does not need to visually see them:

```js
((x, y) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return { error: 'no element at coords' };
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  return { dispatched: true, tag: el.tagName, class: el.className };
})(X, Y)
```

Pass actual numbers (e.g. `(850, 705)`) — don't use `args`, embed directly. Wait ~800ms after dispatch. **Always verify** with a `<video>` state read that `V1.currentTime` moved to within ±1s of expected (`expected = T + V1.clipStart - V1.inPoint`, usually just T).

If `MouseEvent` dispatch doesn't move the playhead, fall back to:
- `mcp__plugin_chrome-devtools-mcp__click` on the ruler if a `uid` is available
- `mcp__plugin_chrome-devtools-mcp__drag` from the playhead's current x to the target x

### Play / pause (CRITICAL — visible click required)

**Use `mcp__plugin_chrome-devtools-mcp__click` with the button's `uid` from `take_snapshot`. NEVER use `evaluate_script` MouseEvent dispatch on the play button** — the user is observing the browser visually and cannot see programmatic clicks; a prior agent's data was discarded for exactly this reason.

```
1. take_snapshot
2. Find play button entry (label "Play" or "Pause")
3. click with uid
4. take_screenshot
5. Verify icon flipped (Play→Pause means now playing)
```

Single button toggles state. After clicking play, verify with two state reads ~1s apart that both V1.paused === false AND V2.paused === false AND both `currentTime` advanced ≥0.5s.

### Forbidden direct calls

DO NOT, via `evaluate_script` or otherwise:
- Call `video.play()` / `video.pause()` directly
- Set `video.currentTime = X` directly
- Call `.click()` programmatically on the play/pause button

All of these bypass React's `isPlaying` state, which means the `playEffect` (and the instrumentation it contains) won't fire. Telemetry will silently desync from actual playback.

## Verification patterns

### Pre-action (paused) check
```
read videos → assert all paused === true → if not, click pause via MCP click, screenshot, recheck
```

### Post-seek check
```
read videos after 800ms wait
assert V1.currentTime within ±1s of expected
assert all videos still paused === true (seek shouldn't auto-play)
```

### Post-play check
```
wait 1500ms → read videos (snapshot A)
wait 1000ms → read videos (snapshot B)
assert both videos paused === false at A AND B
assert V1.currentTime(B) - V1.currentTime(A) >= 0.5
assert V2.currentTime(B) - V2.currentTime(A) >= 0.5
```

If any assertion fails, the play click did not register — sample invalid.

### Post-pause check
```
wait 500ms
read videos
assert all paused === true
```

## Common pitfalls

| Symptom | Likely cause | Fix |
|---|---|---|
| `playToFrameMs ≈ -2, -1, 0, 1` in `[V2MEAS][firstFrame]` log | rVFC fired on already-presented frame; video wasn't actually paused→played | Verify `video.paused === true` BEFORE play click |
| `seekReq` for one video but not the other | Seek effect's threshold (0.1s) skipped the seek because video was already close to target | Not a bug; just means seek logged for the video that drifted further |
| V2 element absent from `document.querySelectorAll('video')` | V2 clip is currently out of scene (currentTime before V2 start − 2s pre-mount, or after V2 end) | Choose seek positions inside V2 active window |
| Reload doesn't pick up new code | Vite HMR cache, browser cache | Force reload: `() => location.reload(true)` (Chrome ignores arg, but try anyway). If still stale, restart `npm run dev` |
| `pixelsPerSecond` off by ~1% | Aspect ratio toggle, panel resize between captures | Re-measure per session by cross-checking two clip positions |
| Click on ruler doesn't seek | Click landed on a clip block instead of ruler bg | Adjust y to ruler strip only (NOT track area); or click with `mousedown`/`mouseup` events directly on the ruler element via `evaluate_script` using `el = document.elementFromPoint`, find first ancestor with `class*="ruler"` |

## Project state notes

- V1 (base) clip typically a long camera file (e.g., `C0001.MP4`, ≥21 min).
- V2 (overlay) typically the OBS/screen recording (e.g., `2026-01-21 15-11-10 remotion.mp4`, ~92s).
- V2 active window: `[V2.clip.start, V2.clip.start + V2.clip.duration]`, often `[28.26, 120.15]`.
- Project duration ≈ 120s — playback past end wraps to 0 (V2 unmounts, then re-mounts as project loops).
- Cross-check the V2 window by reading clip blocks on each session before picking seek positions.

## Instrumentation in code (current)

`VideoPreview.tsx` emits `[V2MEAS]` logs at 4 sites when isPlaying flips true and seeks fire:

| Log tag | Fields | Source |
|---|---|---|
| `[V2MEAS][seekReq]` | requested, immediate, eps_immediate | seekEffect (overlays) + V1 seek effect |
| `[V2MEAS][seekSettled]` | requested, settled, eps, elapsedMs | `seeked` event listener post-assignment |
| `[V2MEAS][playPrep]` | readyState, buffered, requested, isPremounted | playEffect, before `play()` call |
| `[V2MEAS][firstFrame]` | playToFrameMs, mediaTime, expectedClipTime/expectedCT | `requestVideoFrameCallback` after `play()`, first frame |

Also `[V2DBG]` logs for the prior debug pass — usually safe to ignore unless cross-correlating.

Use `[V2MEAS][MARK] BEGIN seek=P` / `[V2MEAS][MARK] END seek=P valid=...` console.log calls (via `evaluate_script`) to segment per-sample data unambiguously.

## Sample read-back template

After test run:
```
list_console_messages → filter to lines starting with [V2MEAS]
Segment by MARK pairs
Per sample: extract seekReq / seekSettled / playPrep / firstFrame
Report only samples where post-play verification passed
```

## Time budgets (observed)

- Page load + project ready: ~3s after reload
- Seek (in-buffer): `seeked` fires 100-500ms after `currentTime` assignment
- Seek (out-of-buffer): can take 1-2s, sometimes triggers V2 unmount/remount cycle
- Play→first frame (warm): 5-40ms
- Play→first frame (cold V2): 70-200ms
- Total per-sample wall-clock: ~6-8s (pre-state + seek + verify + play + 2.5s observation + pause + verify)
- 5 samples end-to-end: ~5-7 min including snapshots

## Hard limits

- Code is read-only: NO `Write` / `Edit` on `.ts` / `.tsx` / `.js` / `.json` etc.
- FFmpeg server (`localhost:3333`) is read-only: do not POST mutating endpoints during tests.
- All findings are observational: report what's measured, never extrapolate or fabricate. If N valid samples < 3, report individual rows and stop — do not aggregate.
