// Phase 4 supervisor-side render client: owns the single warm render worker
// (child_process.fork, spawned lazily on first render), routes
// run/cancel/progress/done/error over IPC, and reaps a crashed worker by
// rejecting its in-flight jobs (each rejection flows through the job queue's
// failJob → the crashed job settles 'error', the queue pumps on). Services call
// the render*InWorker functions instead of importing remotion-core/render.js
// directly — the worker is the only server-side importer of render.js now.
// See docs/fable-phase4-execution-plan.md.

import { fork, type ChildProcess } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { JobRecord } from './job-store.ts';

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'render-worker.ts');

type ProgressFn = (data: any) => void;
interface PendingRender {
  resolve: (value: any) => void;
  reject: (err: any) => void;
  onProgress?: ProgressFn;
}

let worker: ChildProcess | null = null;
let readyPromise: Promise<void> | null = null;
const pending = new Map<string, PendingRender>();

function spawnWorker(): void {
  const child = fork(WORKER_PATH, [], { env: process.env });
  worker = child;

  // Single handler for the whole channel: 'ready' resolves readiness, the rest
  // route by jobId to the pending render's resolver / progress callback.
  readyPromise = new Promise<void>((resolveReady) => {
    child.on('message', (msg: any) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') { resolveReady(); return; }
      const entry = msg.jobId ? pending.get(msg.jobId) : undefined;
      if (!entry) return;
      if (msg.type === 'progress') { entry.onProgress?.(msg.data); return; }
      if (msg.type === 'done') { pending.delete(msg.jobId); entry.resolve(msg.result); return; }
      if (msg.type === 'error') {
        pending.delete(msg.jobId);
        const err: any = new Error(msg.message || 'render worker error');
        if (msg.errorStatus != null) err.statusCode = msg.errorStatus;
        entry.reject(err);
      }
    });
  });

  // Crash-reap: a worker that exits/errors mid-render rejects every in-flight
  // job (500-class) and clears the handle so the next render respawns cold.
  const reap = (reason: string) => {
    if (worker === child) { worker = null; readyPromise = null; }
    const err: any = new Error(`render worker exited (${reason})`);
    err.statusCode = 500;
    for (const [jobId, entry] of pending) { pending.delete(jobId); entry.reject(err); }
  };
  child.on('exit', (code, signal) => reap(`code=${code} signal=${signal}`));
  child.on('error', (e) => reap(e.message));
}

async function ensureWorker(): Promise<ChildProcess> {
  if (!worker) spawnWorker();
  await readyPromise;
  return worker!;
}

async function runInWorker(
  job: JobRecord,
  renderKind: string,
  payload: any,
  onProgress?: ProgressFn,
): Promise<any> {
  const child = await ensureWorker();
  const jobId = job.id;
  // Install the cancel hook before dispatching so a cancel that races the
  // render still reaches the worker's live cancelSignal (fires immediately).
  job.cancel = () => { try { child.send({ type: 'cancel', jobId }); } catch { /* worker gone */ } };
  return new Promise((resolve, reject) => {
    pending.set(jobId, { resolve, reject, onProgress });
    child.send({ type: 'run', renderKind, jobId, payload });
  });
}

export function renderSpecInWorker(job: JobRecord, args: any): Promise<any> {
  const { spec, outputPath, preview, logLevel, renderOptions, onProgress } = args;
  return runInWorker(job, 'spec', { spec, outputPath, preview, logLevel, renderOptions }, onProgress);
}

export function renderDynamicInWorker(job: JobRecord, args: any): Promise<any> {
  const { sceneData, outputPath, width, height, fps, logLevel, onProgress } = args;
  return runInWorker(job, 'dynamic', { sceneData, outputPath, width, height, fps, logLevel }, onProgress);
}

export function renderVariantBatchInWorker(job: JobRecord, args: any): Promise<any> {
  const { variants, outDir, prefix, preview, compositionId, logLevel } = args;
  return runInWorker(job, 'variant', { variants, outDir, prefix, preview, compositionId, logLevel });
}

export function invalidateBundleInWorker(): void {
  // No worker yet = nothing cached; the fresh worker starts with an empty bundle cache.
  if (worker) { try { worker.send({ type: 'invalidate-bundle' }); } catch { /* worker gone */ } }
}

// Graceful shutdown: ask the worker to close Chrome and exit; wait briefly for
// a clean exit, then hard-kill as last resort. Used by the supervisor's
// SIGTERM/SIGINT handler so `docker stop` leaves no orphaned Chrome.
export async function shutdownWorker(timeoutMs = 4000): Promise<void> {
  const child = worker;
  if (!child) return;
  worker = null;
  readyPromise = null;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    child.once('exit', finish);
    try { child.send({ type: 'shutdown' }); } catch { finish(); return; }
    setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(); }, timeoutMs);
  });
}
