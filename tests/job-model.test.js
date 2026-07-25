import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// server-config refuses to boot without the storage env vars; point them at a
// throwaway dir before the job modules (which import it) load. On a dev
// machine .dev.vars wins inside loadEnvVars — also fine, the mirror writes are
// tiny, best-effort, and land in the ramdisk's jobs dir.
process.env.HYPEREDIT_TEMP_DIR ??= mkdtempSync(join(tmpdir(), 'hyperedit-jobs-'));
process.env.HYPEREDIT_SESSIONS_DIR ??= mkdtempSync(join(tmpdir(), 'hyperedit-jobs-'));

const {
  cancelJob,
  completeJob,
  createJob,
  failJob,
  getJob,
  hasActiveJob,
  serializeJob,
  updateJobProgress,
} = await import('../scripts/server/job-store.ts');
const { enqueueJob, getQueuePosition } = await import('../scripts/server/job-queue.ts');

// Manually resolvable promise so tests control when a job settles.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// The queue settles jobs in .then callbacks — yield the microtask queue.
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('job-store', () => {
  it('creates jobs queued with the API serialization shape', () => {
    const job = createJob('sess-shape', 'render');
    expect(job.state).toBe('queued');
    const out = serializeJob(job);
    expect(out).toMatchObject({ jobId: job.id, kind: 'render', state: 'queued', progress: null });
    expect(out).not.toHaveProperty('result');
    expect(out).not.toHaveProperty('error');
  });

  it('exposes result only on done and error only on error', () => {
    const done = createJob('sess-shape', 'render');
    completeJob(done, { ok: 1 });
    expect(serializeJob(done)).toMatchObject({ state: 'done', result: { ok: 1 } });

    const failed = createJob('sess-shape', 'render');
    failJob(failed, 'boom');
    expect(serializeJob(failed)).toMatchObject({ state: 'error', error: 'boom' });
    expect(serializeJob(failed)).not.toHaveProperty('result');
  });

  it('only accepts progress while running', () => {
    const job = createJob('sess-progress', 'render');
    updateJobProgress(job, { pct: 10 });
    expect(job.progress).toBeNull();
    job.state = 'running';
    updateJobProgress(job, { pct: 10 });
    expect(job.progress).toEqual({ pct: 10 });
  });

  it('converts a post-cancel failure into canceled, not error', () => {
    const job = createJob('sess-cancel-fail', 'render');
    job.state = 'running';
    job.cancelRequested = true;
    failJob(job, 'renderMedia() got cancelled');
    expect(job.state).toBe('canceled');
    expect(job.error).toBeUndefined();
  });

  it('tracks active jobs per session and kind', () => {
    const job = createJob('sess-active', 'render');
    expect(hasActiveJob('sess-active', 'render')).toBe(true);
    expect(hasActiveJob('sess-active', 'transcribe')).toBe(false);
    expect(hasActiveJob('other-session', 'render')).toBe(false);
    completeJob(job, {});
    expect(hasActiveJob('sess-active', 'render')).toBe(false);
  });

  it('drops finished jobs beyond the newest 50 per session', () => {
    const jobs = [];
    for (let i = 0; i < 55; i++) {
      const job = createJob('sess-retention', 'render');
      completeJob(job, { index: i });
      jobs.push(job);
    }
    const surviving = jobs.filter(j => getJob(j.id));
    expect(surviving.length).toBe(50);
    // Oldest finished jobs are the ones dropped
    expect(getJob(jobs[0].id)).toBeUndefined();
    expect(getJob(jobs[54].id)).toBeDefined();
  });
});

describe('job-queue', () => {
  it('runs the render lane at concurrency 1 and reports queue position', async () => {
    const first = deferred();
    const second = deferred();
    const jobA = enqueueJob({ sessionId: 's-lane', kind: 'render', lane: 'render', run: () => first.promise });
    const jobB = enqueueJob({ sessionId: 's-lane', kind: 'render', lane: 'render', run: () => second.promise });

    expect(jobA.state).toBe('running');
    expect(jobB.state).toBe('queued');
    // One running ahead — matches the old "waiting for 1 earlier render"
    expect(getQueuePosition(jobB.id)).toBe(1);

    first.resolve({ out: 'a' });
    await tick();
    expect(jobA.state).toBe('done');
    expect(jobA.result).toEqual({ out: 'a' });
    expect(jobB.state).toBe('running');

    second.resolve({ out: 'b' });
    await tick();
    expect(jobB.state).toBe('done');
  });

  it('marks a rejected run as error with the message', async () => {
    const gate = deferred();
    const job = enqueueJob({ sessionId: 's-err', kind: 'render', lane: 'render', run: () => gate.promise });
    gate.reject(new Error('encoder exploded'));
    await tick();
    expect(job.state).toBe('error');
    expect(job.error).toBe('encoder exploded');
  });

  it('cancels a queued job immediately and never runs it', async () => {
    const blocker = deferred();
    let ran = false;
    enqueueJob({ sessionId: 's-cancel-q', kind: 'render', lane: 'render', run: () => blocker.promise });
    const queued = enqueueJob({
      sessionId: 's-cancel-q', kind: 'render', lane: 'render',
      run: async () => { ran = true; },
    });

    cancelJob(queued);
    expect(queued.state).toBe('canceled');

    blocker.resolve({});
    await tick();
    expect(ran).toBe(false);
    expect(queued.state).toBe('canceled');
  });

  it('invokes the cancel hook on a running job and settles it canceled', async () => {
    const gate = deferred();
    let hookCalled = false;
    const job = enqueueJob({
      sessionId: 's-cancel-r', kind: 'render', lane: 'render',
      run: async (job) => {
        job.cancel = () => {
          hookCalled = true;
          gate.reject(new Error('renderMedia() got cancelled'));
        };
        return gate.promise;
      },
    });
    await tick();
    expect(job.state).toBe('running');

    cancelJob(job);
    await tick();
    expect(hookCalled).toBe(true);
    expect(job.state).toBe('canceled');
  });

  it('rejects unknown lanes', () => {
    expect(() => enqueueJob({ sessionId: 's', kind: 'x', lane: 'nope', run: async () => {} }))
      .toThrow(/Unknown job lane/);
  });
});
