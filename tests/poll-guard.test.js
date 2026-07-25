import { afterEach, describe, expect, it } from 'vitest';
import { pollJob, setActivePollSession } from '../src/react-app/utils/api-helpers.ts';

// The session/abort guard added to pollJob so a long job that outlives a
// session switch (or an unmounted caller) abandons its stale result instead of
// applying it to the wrong project.

afterEach(() => setActivePollSession(null));

describe('pollJob session/abort guard', () => {
  it('abandons a poll whose session is no longer the active one (AbortError)', async () => {
    setActivePollSession('session-A');
    await expect(pollJob('session-B', 'job-1')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('respects an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(pollJob('session-A', 'job-1', { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves normally when the active session matches', async () => {
    setActivePollSession('session-A');
    const orig = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ state: 'done', result: { ok: 1 } }), { status: 200 });
    try {
      await expect(pollJob('session-A', 'job-1')).resolves.toEqual({ ok: 1 });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('abandons any poll when no session is active (null active session)', async () => {
    // A poll only starts once a session exists, so null means the session was
    // cleared (404/invalid) — its in-flight polls must be abandoned, not applied.
    setActivePollSession(null);
    await expect(pollJob('any-session', 'job-1')).rejects.toMatchObject({ name: 'AbortError' });
  });
});
