import { existsSync, mkdirSync, unlinkSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { SESSIONS_DIR, TEMP_DIR } from './server-config.ts';

// One job model for every long-running lane (render first; transcription /
// dead-air / generative lanes follow in later Phase-3 slices). Owner-locked
// semantics (R1 doc §5.3(3)): the registry is in-memory only, mirrored to the
// ramdisk for crash forensics — no HDD persistence. After a server restart the
// registry is empty; pollers of an unknown jobId get 404 with a hint and treat
// the job as failed. Finished jobs beyond the newest ~50 per session are
// dropped so the registry cannot grow without limit. Append-only JSONL history
// is opt-in via HYPEREDIT_JOB_HISTORY=1.

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'canceled';

export interface JobRecord {
  id: string;
  sessionId: string;
  kind: string;
  // Subject asset for asset-scoped jobs (ingest) — lets a targeted cancel find
  // just this asset's background work. Absent for session-scoped jobs.
  assetId?: string;
  state: JobState;
  progress: Record<string, unknown> | null;
  result?: unknown;
  error?: string;
  // HTTP-status-equivalent for errors (a lane throws with err.statusCode set):
  // 4xx = user-addressable outcome (e.g. no speech in range), else server
  // failure. Clients keep the old sync-response semantics through this.
  errorStatus?: number;
  // Free-text caveat a lane attaches (e.g. remote-cancel attempted, untested).
  note?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  cancelRequested: boolean;
  // In-flight cancel hook installed by the running lane (never serialized).
  cancel?: () => void;
}

const FINISHED_STATES: ReadonlySet<JobState> = new Set(['done', 'error', 'canceled']);
const FINISHED_KEEP_PER_SESSION = 50;
const MIRROR_DIR = join(TEMP_DIR, 'jobs');
const HISTORY_ENABLED = process.env.HYPEREDIT_JOB_HISTORY === '1';
const HISTORY_PATH = join(SESSIONS_DIR, 'job-history.jsonl');
// Progress ticks arrive per frame batch — throttle mirror writes per job.
const MIRROR_PROGRESS_INTERVAL_MS = 1000;

const jobs = new Map<string, JobRecord>();
const lastMirrorWrite = new Map<string, number>();
// Resolvers awaiting a job reaching a finished state (see whenJobSettled).
const settleWaiters = new Map<string, Array<() => void>>();

export function createJob(sessionId: string, kind: string, assetId?: string): JobRecord {
  const job: JobRecord = {
    id: randomUUID(),
    sessionId,
    kind,
    ...(assetId ? { assetId } : {}),
    state: 'queued',
    progress: null,
    createdAt: Date.now(),
    cancelRequested: false,
  };
  jobs.set(job.id, job);
  writeMirror(job);
  return job;
}

export function getJob(jobId: string): JobRecord | undefined {
  return jobs.get(jobId);
}

// Queued or running job of the given kind for a session (undefined = none).
export function hasActiveJob(sessionId: string, kind: string): boolean {
  for (const job of jobs.values()) {
    if (job.sessionId === sessionId && job.kind === kind && !FINISHED_STATES.has(job.state)) {
      return true;
    }
  }
  return false;
}

// Active job that must BLOCK a destructive op (delete asset/session). Excludes
// the background `ingest` lane (proxy build): it's disposable and the user never
// requested it, so delete handlers cancel it instead of refusing (M1/M2 — an
// invisible upload-spawned ingest must not 409 an otherwise-safe delete).
export function hasBlockingJob(sessionId: string): boolean {
  for (const job of jobs.values()) {
    if (job.sessionId === sessionId && job.kind !== 'ingest' && !FINISHED_STATES.has(job.state)) return true;
  }
  return false;
}

// Resolves when a job reaches a finished state (immediately if it already has,
// or is unknown). Lets a caller cancel a job and await the underlying process
// actually exiting — so a Windows unlink won't hit EBUSY on a file an ffmpeg
// child still holds open.
function whenJobSettled(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job || FINISHED_STATES.has(job.state)) return Promise.resolve();
  return new Promise((resolve) => {
    const arr = settleWaiters.get(jobId) || [];
    arr.push(resolve);
    settleWaiters.set(jobId, arr);
  });
}

// Cancel (and await the settling of) background ingest jobs for a session, or
// just one asset's. Delete handlers call this: an ingest proxy-encode holds the
// source file open, so we stop it and wait for the child to exit before
// unlinking — rather than refusing the delete. A 5s cap keeps a wedged job from
// blocking the delete forever (the unlink is best-effort and guarded anyway).
export async function cancelIngestJobs(sessionId: string, assetId?: string): Promise<void> {
  const targets: JobRecord[] = [];
  for (const job of jobs.values()) {
    if (job.sessionId === sessionId && job.kind === 'ingest' && !FINISHED_STATES.has(job.state)
      && (assetId === undefined || job.assetId === assetId)) {
      targets.push(job);
    }
  }
  if (targets.length === 0) return;
  for (const job of targets) cancelJob(job);
  const settled = Promise.all(targets.map((j) => whenJobSettled(j.id)));
  const cap = new Promise<void>((r) => setTimeout(r, 5000));
  await Promise.race([settled, cap]);
}

export function markJobRunning(job: JobRecord): void {
  job.state = 'running';
  job.startedAt = Date.now();
  writeMirror(job);
}

export function updateJobProgress(job: JobRecord, progress: Record<string, unknown>): void {
  if (job.state !== 'running') return;
  job.progress = progress;
  const last = lastMirrorWrite.get(job.id) || 0;
  if (Date.now() - last >= MIRROR_PROGRESS_INTERVAL_MS) {
    writeMirror(job);
  }
}

// Remotion-render onProgress adapter — progress shape parity with the
// retired NDJSON stream ({ pct, frames, total, elapsed }), now polled.
export function makeRenderProgressUpdater(job: JobRecord) {
  return ({ pct, renderedFrames, totalFrames, elapsed }: { pct: number; renderedFrames: number; totalFrames: number; elapsed: number }) => {
    const min = Math.floor(elapsed / 60);
    const sec = String(elapsed % 60).padStart(2, '0');
    updateJobProgress(job, { pct, frames: renderedFrames, total: totalFrames, elapsed: `${min}:${sec}` });
  };
}

export function completeJob(job: JobRecord, result: unknown): void {
  if (FINISHED_STATES.has(job.state)) return;
  job.state = 'done';
  job.result = result;
  finalizeJob(job);
}

// A rejection after a cancel request counts as the cancel taking effect, not a
// failure — Remotion's cancelSignal surfaces as a rejected render.
export function failJob(job: JobRecord, message: string, statusCode?: number): void {
  if (FINISHED_STATES.has(job.state)) return;
  if (job.cancelRequested) {
    job.state = 'canceled';
  } else {
    job.state = 'error';
    job.error = message;
    if (statusCode != null) job.errorStatus = statusCode;
  }
  finalizeJob(job);
}

// Immediate cancel for jobs that never started (the queue skips them).
function markJobCanceled(job: JobRecord): void {
  if (FINISHED_STATES.has(job.state)) return;
  job.state = 'canceled';
  finalizeJob(job);
}

// Best-effort cancellation: queued jobs finalize immediately; running jobs get
// their lane's cancel hook (if the lane installed one) and settle when the
// underlying work aborts. Finished jobs are a no-op.
export function cancelJob(job: JobRecord): void {
  if (FINISHED_STATES.has(job.state)) return;
  job.cancelRequested = true;
  if (job.state === 'queued') {
    markJobCanceled(job);
    return;
  }
  try {
    job.cancel?.();
  } catch (e: any) {
    console.warn(`[Jobs] Cancel hook for ${job.id} threw:`, e.message);
  }
}

// Cancel every queued/running job (graceful shutdown). Running render jobs fire
// their IPC cancel hook; lanes without an in-flight cancel just settle canceled.
export function cancelAllActiveJobs(): void {
  for (const job of jobs.values()) {
    if (!FINISHED_STATES.has(job.state)) cancelJob(job);
  }
}

// API shape per the R1 dual-audience mandate: flat, few fields, enum state.
export function serializeJob(job: JobRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    jobId: job.id,
    kind: job.kind,
    state: job.state,
    progress: job.progress,
    createdAt: job.createdAt,
  };
  if (job.startedAt != null) out.startedAt = job.startedAt;
  if (job.finishedAt != null) out.finishedAt = job.finishedAt;
  if (job.state === 'done') out.result = job.result;
  if (job.state === 'error') {
    out.error = job.error;
    if (job.errorStatus != null) out.errorStatus = job.errorStatus;
  }
  if (job.note != null) out.note = job.note;
  return out;
}

function finalizeJob(job: JobRecord): void {
  job.finishedAt = Date.now();
  job.cancel = undefined;
  writeMirror(job);
  appendHistory(job);
  pruneFinished(job.sessionId);
  const waiters = settleWaiters.get(job.id);
  if (waiters) {
    settleWaiters.delete(job.id);
    for (const w of waiters) w();
  }
}

function pruneFinished(sessionId: string): void {
  const finished: JobRecord[] = [];
  for (const job of jobs.values()) {
    if (job.sessionId === sessionId && FINISHED_STATES.has(job.state)) finished.push(job);
  }
  if (finished.length <= FINISHED_KEEP_PER_SESSION) return;
  finished.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  for (const job of finished.slice(FINISHED_KEEP_PER_SESSION)) {
    jobs.delete(job.id);
    lastMirrorWrite.delete(job.id);
    try { unlinkSync(join(MIRROR_DIR, `${job.id}.json`)); } catch {}
  }
}

// Ramdisk mirror is forensics only — a failed write must never break a job.
function writeMirror(job: JobRecord): void {
  try {
    if (!existsSync(MIRROR_DIR)) mkdirSync(MIRROR_DIR, { recursive: true });
    writeFileSync(join(MIRROR_DIR, `${job.id}.json`), JSON.stringify(serializeJob(job)));
    lastMirrorWrite.set(job.id, Date.now());
  } catch {}
}

function appendHistory(job: JobRecord): void {
  if (!HISTORY_ENABLED) return;
  try {
    appendFileSync(HISTORY_PATH, JSON.stringify({ sessionId: job.sessionId, ...serializeJob(job) }) + '\n');
  } catch (e: any) {
    console.warn('[Jobs] History append failed:', e.message);
  }
}
