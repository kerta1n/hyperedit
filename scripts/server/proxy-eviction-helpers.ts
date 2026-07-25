// Pure LRU/budget math for the ramdisk proxy warm cache (Phase 5 §7.1). Kept
// free of any I/O or server-config import so the eviction policy is unit-tested
// from plain inputs — proxy-cache-store owns the file copies and the state map.

export interface EvictionCandidate {
  sessionId: string;
  sizeBytes: number;
  lastAccess: number;
}

// Decide which of the currently-warm sessions to evict — oldest last-access
// first, skipping any touched within `guardMs` of `now` (a session someone is
// actively streaming) — to make room for `incomingBytes` under `budget`.
// `current` must exclude the incoming (active) session, so it is never evicted.
// `fits` is false when even evicting every eligible session can't free enough;
// the caller then declines to warm rather than blow the budget.
export function planEviction(
  current: EvictionCandidate[],
  incomingBytes: number,
  budget: number,
  opts: { now: number; guardMs: number },
): { evict: string[]; fits: boolean } {
  const used = current.reduce((sum, e) => sum + e.sizeBytes, 0);
  let free = budget - used;
  if (incomingBytes <= free) return { evict: [], fits: true };

  const evictable = current
    .filter((e) => opts.now - e.lastAccess >= opts.guardMs)
    .sort((a, b) => a.lastAccess - b.lastAccess); // least-recently-used first

  const evict: string[] = [];
  for (const e of evictable) {
    if (incomingBytes <= free) break;
    evict.push(e.sessionId);
    free += e.sizeBytes;
  }
  return { evict, fits: incomingBytes <= free };
}
