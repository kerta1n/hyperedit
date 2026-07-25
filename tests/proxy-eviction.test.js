import { describe, expect, it } from 'vitest';
import { planEviction } from '../scripts/server/proxy-eviction-helpers.ts';

// now/guard fixed so ages are explicit: lastAccess >= now-guard is "recent".
const NOW = 1000;
const GUARD = 300; // sessions touched within 300 of NOW are protected
const opts = { now: NOW, guardMs: GUARD };

describe('planEviction', () => {
  it('warms without eviction when it already fits the budget', () => {
    const current = [{ sessionId: 'A', sizeBytes: 30, lastAccess: 500 }];
    expect(planEviction(current, 40, 100, opts)).toEqual({ evict: [], fits: true });
  });

  it('treats exactly-fills-free as fitting (no eviction)', () => {
    const current = [{ sessionId: 'A', sizeBytes: 30, lastAccess: 500 }];
    expect(planEviction(current, 70, 100, opts)).toEqual({ evict: [], fits: true });
  });

  it('evicts only the oldest session, and only as many as needed', () => {
    const current = [
      { sessionId: 'A', sizeBytes: 40, lastAccess: 500 }, // oldest
      { sessionId: 'B', sizeBytes: 40, lastAccess: 600 },
    ];
    // used=80, free=20, need 50 -> evict A (oldest) frees to 60, B kept
    expect(planEviction(current, 50, 100, opts)).toEqual({ evict: ['A'], fits: true });
  });

  it('evicts multiple sessions LRU-first until it fits', () => {
    const current = [
      { sessionId: 'C', sizeBytes: 30, lastAccess: 700 },
      { sessionId: 'A', sizeBytes: 30, lastAccess: 500 }, // oldest
      { sessionId: 'B', sizeBytes: 30, lastAccess: 600 },
    ];
    // used=90, free=10, need 70 -> evict A then B (oldest first), C kept
    expect(planEviction(current, 70, 100, opts)).toEqual({ evict: ['A', 'B'], fits: true });
  });

  it('never evicts a session streamed within the guard window', () => {
    const current = [{ sessionId: 'A', sizeBytes: 80, lastAccess: 900 }]; // age 100 < 300
    // needs room but A is protected -> cannot fit, nothing evicted
    expect(planEviction(current, 50, 100, opts)).toEqual({ evict: [], fits: false });
  });

  it('evicts the old session but leaves a recently-streamed one, reporting no fit', () => {
    const current = [
      { sessionId: 'A', sizeBytes: 50, lastAccess: 500 }, // evictable
      { sessionId: 'B', sizeBytes: 50, lastAccess: 900 }, // protected (age 100)
    ];
    // used=100, free=0, need 60 -> evict A frees 50 (<60); B protected -> no fit
    expect(planEviction(current, 60, 100, opts)).toEqual({ evict: ['A'], fits: false });
  });

  it('reports no fit when the incoming set exceeds the whole budget', () => {
    const current = [{ sessionId: 'A', sizeBytes: 40, lastAccess: 500 }];
    // evict everything eligible, still 120 > 100 budget
    expect(planEviction(current, 120, 100, opts)).toEqual({ evict: ['A'], fits: false });
  });

  it('handles an empty cache: fits when under budget, not when over', () => {
    expect(planEviction([], 80, 100, opts)).toEqual({ evict: [], fits: true });
    expect(planEviction([], 150, 100, opts)).toEqual({ evict: [], fits: false });
  });
});
