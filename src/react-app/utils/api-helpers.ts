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

// Poll a job until it settles. Resolves with the job result on 'done';
// throws on 'error'/'canceled' and on 404 (a server restart loses job state).
export async function pollJob(
  sessionId: string,
  jobId: string,
  opts: { onUpdate?: (job: JobStatus) => void; intervalMs?: number } = {},
): Promise<unknown> {
  const intervalMs = opts.intervalMs ?? 1000;
  for (;;) {
    const res = await fetch(`${API_BASE}/session/${sessionId}/jobs/${jobId}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.hint || data.error || `Job poll failed (${res.status})`);
    }
    const job: JobStatus = await res.json();
    opts.onUpdate?.(job);
    if (job.state === 'done') return job.result;
    if (job.state === 'error') {
      const err = new Error(job.error || 'Job failed') as Error & { status?: number };
      if (job.errorStatus != null) err.status = job.errorStatus;
      throw err;
    }
    if (job.state === 'canceled') throw new Error('Job canceled');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
