# Fix: Transitions Don't Render in Exported Video

## Problem

When a user applies a transition (e.g., crossfade) between two clips and exports, the transition is invisible. The video renders but with no visual transition effect — clips just hard-cut or overlap without the transition.

The data flow is correct: transitions ARE stored in frontend state, ARE sent to the server via `renderProject()`, ARE passed through `timelineToRemotionSpec()`, and DO arrive in the Remotion spec. However, `resolveJunctionTransitions()` in `ProjectTimeline.tsx` **silently discards them** due to two validation checks that fail.

## Root Causes (both must be fixed)

### Bug 1: Cross-track transitions are silently rejected for built-in types

In `ProjectTimeline.tsx`, inside `resolveJunctionTransitions()`, there's a check:
```typescript
if (fromClip.trackId !== toClip.trackId && transition.type !== 'custom') {
  continue; // Silently drops ALL built-in transitions between different tracks
}
```

This means crossfade, slide-left, slide-right, and dip-to-black transitions ONLY work when both clips are on the **same track**. If the user places clips on V1 and V2 and applies a crossfade, it's silently dropped. No error, no warning.

**Fix:** Remove or relax the cross-track restriction. The overlay rendering pattern (standalone `<Sequence>` at z-index 3500, like `DipToBlackOverlay`) already works regardless of track assignment — the overlay doesn't care what tracks the clips are on. Built-in transitions should work cross-track just like custom transitions.

### Bug 2: addTransition() doesn't create physical clip overlap

In `ProjectTimeline.tsx`, `resolveJunctionTransitions()` requires clips to **physically overlap in time**:
```typescript
const fromEndSec = fromClip.startSec + fromClip.durationSec;
const overlapSec = fromEndSec - toClip.startSec;
if (overlapSec <= 0) {
  continue; // Silently drops transition when clips don't physically overlap
}
```

But in `useProject.ts`, `addTransition()` only creates a transition entry in state — it does NOT modify clip positions to create overlap. When clips are placed head-to-tail (Clip A ends at 5.0s, Clip B starts at 5.0s), `overlapSec = 0`, and the transition is silently skipped.

**Fix:** When `addTransition()` is called with a `durationSec` (e.g., 0.5s), it must:
1. Shift `toClip.start` backward by `durationSec` (so it overlaps with the end of fromClip)
2. If both clips are on the **same track**, ripple-shift all subsequent clips on that track backward by the same amount to maintain spacing
3. This ensures `overlapSec > 0` when `resolveJunctionTransitions()` processes it during rendering

Similarly, when a transition is **removed** via `removeTransition()`, reverse the overlap shift — move the toClip forward by the transition's `durationSec` and ripple subsequent clips accordingly.

## Files to Modify

1. **`src/remotion/ProjectTimeline.tsx`** — In `resolveJunctionTransitions()`, remove or relax the cross-track check so built-in transitions work between clips on different tracks
2. **`src/react-app/hooks/useProject.ts`** — Modify `addTransition()` to shift toClip backward and create physical overlap. Also modify `removeTransition()` to undo the shift.

## Verification

After fixing:
1. **Same-track test**: Place two clips on V1, head-to-tail. Apply a crossfade (0.5s). Export. The crossfade should be visible in the rendered video.
2. **Cross-track test**: Place one clip on V1, another on V2. Apply a crossfade (0.5s). Export. The crossfade should be visible.
3. **Remove transition test**: After applying a transition, remove it. Verify clips return to their original positions (overlap is undone).
4. **Duration test**: Apply a transition with different durations (0.3s, 1.0s). Verify the overlap amount matches the requested duration.

## What NOT to Change

- Don't modify the data flow (it works correctly — transitions flow from frontend through `timelineToRemotionSpec` to the spec)
- Don't modify `resolveJunctionTransitions()` logic for calculating `resolvedDurationSec` or `startFrame` — those are correct
- Don't modify `VideoVisualClip` opacity/translateX logic for built-in transitions — that's correct
- Don't touch the dead air removal workflow
- Don't touch the Ollama/LLM abstraction
