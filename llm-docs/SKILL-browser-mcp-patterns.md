# Browser MCP Patterns (chrome-devtools-mcp)

Generic patterns for driving any web app through `mcp__plugin_chrome-devtools-mcp__*` tools. Read this BEFORE doing any browser automation.

## Connection model

- Brave/Chrome started with `--remote-debugging-port=9222`. Tab list is shared CDP namespace.
- Always start by `mcp__plugin_chrome-devtools-mcp__list_pages` → `select_page` with `pageId`. Subsequent tool calls operate on the selected page.
- When opening a new tab for unrelated work (e.g., docs research while a test page is active in another tab), use `new_page` with the URL — this opens AND selects the new tab. Don't call `navigate_page` on the existing tab unless you want to lose its state.
- Selecting a page does NOT bring it to front by default — pass `bringToFront: true` if you need it visually focused. Generally not needed.

## Click vs evaluate_script for user actions

Two click mechanisms, use the right one:

| Action | Tool | Reason |
|---|---|---|
| Visible button click that user must see | `mcp__plugin_chrome-devtools-mcp__click` by uid | Dispatches real CDP-driven mouse event. Cursor moves visibly, button visibly depresses, React onClick fires. |
| Internal click that doesn't need to be visible (e.g., timeline ruler at computed pixel) | `evaluate_script` dispatching `MouseEvent` with `bubbles: true, cancelable: true, clientX, clientY` | Fires React handlers but invisible to user. Useful for fine-positioned clicks. |
| Selecting tree-items in chrome://media-internals or other no-role-attribute elements | `evaluate_script` MouseEvent | The MCP `click` tool may not honor elements without proper accessibility attributes. |

**Critical pitfall**: a prior measurement session had to discard data because the agent used `evaluate_script` MouseEvent dispatch on a play button. The user observing the session reported audibly hearing only ~2 of 5 supposed plays. Programmatic clicks may not be honored consistently by React in some cases, AND the user can't visually confirm.

**Rule**: any user-observable button (play/pause, primary action buttons) — use MCP `click` by uid. Other clicks — `evaluate_script` MouseEvent is fine.

## take_snapshot vs take_screenshot

- `take_snapshot`: returns accessibility tree as text with `uid` for each interactable. Use this to find elements to click. Heavy — slow on complex pages.
- `take_screenshot`: returns image. Use this AFTER each visible click to confirm the UI changed state (button icon flipped, etc.).
- Pattern for visible click verification:
  ```
  1. take_snapshot → find target uid
  2. click with uid
  3. take_screenshot → confirm visual change
  ```

## evaluate_script idioms

### Function-as-string

`evaluate_script` takes `function:` as a string of JS source. NOT a function reference.

```js
// Correct
evaluate_script({ function: '() => document.title' })

// Correct with closure values embedded
evaluate_script({ function: '() => document.querySelectorAll("video").length' })
```

### args parameter is awkward

The `args` parameter exists but expects element uids, not arbitrary values. To pass values, embed them in the function source directly:

```js
// Awkward (don't do this with primitive args):
evaluate_script({ function: '(n) => seekTo(n)', args: ['35'] })

// Better — embed value directly:
const target = 35;
evaluate_script({ function: `() => seekTo(${target})` })
```

### Return value must be JSON-serializable

`evaluate_script` returns the function's return value via JSON. Functions, DOM elements, Symbols are not serializable. Extract primitives or plain object structures.

```js
// Wrong — returns DOM node, won't serialize:
() => document.querySelector('video')

// Right — extract serializable fields:
() => {
  const v = document.querySelector('video');
  if (!v) return null;
  return { src: v.src, currentTime: v.currentTime, paused: v.paused };
}
```

### Async functions work

```js
async () => {
  const result = await fetch('http://localhost:3333/some-endpoint');
  return await result.json();
}
```

### Multiple state reads — single eval call when possible

Reading state once via `evaluate_script` is faster than doing N separate reads. Bundle related queries:

```js
() => {
  const videos = Array.from(document.querySelectorAll('video')).map(v => ({
    src: v.src.slice(-40), paused: v.paused, currentTime: v.currentTime, readyState: v.readyState
  }));
  const buttons = Array.from(document.querySelectorAll('button[aria-label]')).map(b => ({
    label: b.getAttribute('aria-label'), disabled: b.disabled
  }));
  return { videos, buttons };
}
```

## Console message capture

- `list_console_messages` returns all messages since last navigation, with integer `msgid`.
- `get_console_message({ msgid: N })` returns one specific message.
- Use `console.log('[MARK] some-label')` from `evaluate_script` to insert markers for segmenting logs.
- Filter logs by prefix in code, not in tool — pull them all then filter strings.

```js
// Insert console marker from JS
() => { console.log('[V2MEAS][MARK] BEGIN cycle=' + 1); return 'ok'; }
```

## Network inspection

- `list_network_requests` shows pending + completed.
- `get_network_request({ ... })` returns details.
- Useful for confirming CORS preflight behavior, byte-range request patterns, response headers.

## Forbidden patterns

Things that bypass user-observable state and silently break tests:

- DO NOT call `videoElement.play()` / `.pause()` / `.currentTime = X` directly via `evaluate_script` for USER actions. These bypass React `isPlaying` state, which means React effects don't fire, instrumentation doesn't run, telemetry desyncs from reality.
- DO NOT use `button.click()` programmatically for buttons the user wants to see clicked. Use MCP `click` by uid.
- DO NOT rely on `take_snapshot` alone to confirm clicks happened. Take a screenshot too.

## chrome://media-internals navigation

Special-case quirks:
- Open as new tab via `new_page({ url: 'chrome://media-internals/' })`. Don't `navigate_page` an existing tab.
- Player tree-items don't accept MCP `click` (no proper a11y roles). Use `evaluate_script` MouseEvent dispatch on `.tree-item-header.selectable-button`.
- `body` element loses class `no-players-selected` after successful selection. Verify selection via `document.body.classList.contains('no-players-selected') === false`.
- `window.media` global exposes handler functions only (no cached state accessible). Real data requires selecting a player.
- "Destroyed" players are unselectable. Only `active-player` class works.
- Player URLs in `.player-name` text are TRUNCATED. Full URL is in the `title` attribute. Read via `el.title` not `el.textContent`.

## Sleep / wait

- `evaluate_script` with `await new Promise(r => setTimeout(r, N))` works but Vite HMR or React state updates may extend wall time.
- Native `mcp__plugin_chrome-devtools-mcp__wait_for` accepts a selector predicate. Cleaner when waiting for specific UI state.
- For mid-test pauses (between user actions), simple `setTimeout` is fine.

## Tab demotion / visibility quirks

- Switching tabs (e.g., to media-internals) marks the source tab as hidden briefly.
- Chrome demotes hidden tabs (throttles timers, deprioritizes decoders).
- For tight measurement runs, minimize tab switches — capture everything from the active tab in one pass.

## Pattern templates

### Pre-action state verification
```js
() => Array.from(document.querySelectorAll('video')).map(v => ({
  paused: v.paused, currentTime: v.currentTime, readyState: v.readyState
}))
```

### Post-click state verification (with retry guard)
```js
async () => {
  await new Promise(r => setTimeout(r, 500));
  return Array.from(document.querySelectorAll('video')).map(v => ({
    paused: v.paused, currentTime: v.currentTime
  }));
}
```

### Find button by label, return uid (via DOM traversal — alternative to take_snapshot when you know the structure)
```js
() => {
  const btn = Array.from(document.querySelectorAll('button')).find(
    b => b.getAttribute('aria-label') === 'Play' || b.getAttribute('aria-label') === 'Pause'
  );
  if (!btn) return null;
  return { label: btn.getAttribute('aria-label'), rect: btn.getBoundingClientRect().toJSON() };
}
```
(Then use coordinate-click via MCP if needed, but generally take_snapshot is more reliable.)
