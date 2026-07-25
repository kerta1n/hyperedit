// FFmpeg-server origin. In production the SPA is served by the server itself,
// so same-origin keeps LAN/VPN access working; the explicit localhost fallback
// exists only for the Vite dev server (:5173), which is a different origin.
export const API_BASE = import.meta.env.DEV
  ? 'http://localhost:3333'
  : window.location.origin;

// Job-model endpoints answer 202 { jobId }; state lives at
// GET /session/:id/jobs/:jobId until the job settles (DELETE cancels).
export interface JobStatus {
  jobId: string;
  kind: string;
  state: 'queued' | 'running' | 'done' | 'error' | 'canceled';
  progress: Record<string, unknown> | null;
  queuePosition?: number;
  result?: unknown;
  error?: string;
  // HTTP-status-equivalent for job errors: 4xx = user-addressable outcome
  // (kept from the old synchronous-response semantics), else server failure.
  errorStatus?: number;
}

// The session the UI is currently showing. A long job (whisper, render,
// animation) can outlive a session switch; when it settles, the result must NOT
// be applied to whatever session is now active. pollJob abandons any poll whose
// session is no longer the active one, so the stale result rejects (AbortError)
// instead of landing in the wrong project. Set from useProject on session change.
let activePollSessionId: string | null = null;
export function setActivePollSession(sessionId: string | null): void {
  activePollSessionId = sessionId;
}

// Poll a job until it settles. Resolves with the job result on 'done';
// throws on 'error'/'canceled' and on 404 (a server restart loses job state).
// Throws AbortError (err.name === 'AbortError') if the caller's signal aborts
// or the active session changes out from under the job — callers may treat that
// as "discard, don't surface as a failure".
export async function pollJob(
  sessionId: string,
  jobId: string,
  opts: { onUpdate?: (job: JobStatus) => void; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  const intervalMs = opts.intervalMs ?? 1000;
  const bailIfAbandoned = () => {
    if (opts.signal?.aborted) throw new DOMException('Poll aborted', 'AbortError');
    // Abandon whenever this poll's session is not the active one — including
    // when the active session is null (a session cleared on a 404/invalid path).
    // A `!== null &&` short-circuit here left a hole: during a switch through
    // null, an old-session poll would slip past and misapply its result.
    if (activePollSessionId !== sessionId) {
      throw new DOMException('Poll abandoned — active session changed', 'AbortError');
    }
  };
  for (;;) {
    bailIfAbandoned();
    const res = await fetch(`${API_BASE}/session/${sessionId}/jobs/${jobId}`, opts.signal ? { signal: opts.signal } : undefined);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.hint || data.error || `Job poll failed (${res.status})`);
    }
    const job: JobStatus = await res.json();
    opts.onUpdate?.(job);
    if (job.state === 'done') { bailIfAbandoned(); return job.result; }
    if (job.state === 'error') {
      const err = new Error(job.error || 'Job failed') as Error & { status?: number };
      if (job.errorStatus != null) err.status = job.errorStatus;
      throw err;
    }
    if (job.state === 'canceled') throw new Error('Job canceled');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
