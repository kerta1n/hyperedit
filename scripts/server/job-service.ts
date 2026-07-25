import type { IncomingMessage, ServerResponse } from 'http';
import { sendJSON } from './http-helpers.ts';
import { requireSession } from './session-store.ts';
import { cancelJob, getJob, serializeJob } from './job-store.ts';
import { getQueuePosition } from './job-queue.ts';

// The polled job-status surface (owner decree: no websockets — 202 { jobId }
// on submit, 1-2s polling here, DELETE cancels on the same identity). These
// are parameterized routes (/jobs/:jobId), mounted directly in the Hono layer
// like the assets/:id and renders/:stem branches.

const JOB_NOT_FOUND = {
  error: 'Job not found',
  hint: 'Unknown or expired jobId. If the server restarted, job state was lost — re-trigger the operation if needed.',
};

function lookupJob(res: ServerResponse, sessionId: string, jobId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return undefined;
  const job = getJob(jobId);
  if (!job || job.sessionId !== sessionId) {
    sendJSON(res, JOB_NOT_FOUND, 404);
    return undefined;
  }
  return job;
}

export async function handleJobStatus(req: IncomingMessage, res: ServerResponse, sessionId: string, jobId: string) {
  const job = lookupJob(res, sessionId, jobId);
  if (!job) return;
  const out = serializeJob(job);
  if (job.state === 'queued') {
    const position = getQueuePosition(job.id);
    if (position != null) out.queuePosition = position;
  }
  sendJSON(res, out);
}

export async function handleJobCancel(req: IncomingMessage, res: ServerResponse, sessionId: string, jobId: string) {
  const job = lookupJob(res, sessionId, jobId);
  if (!job) return;
  cancelJob(job);
  sendJSON(res, serializeJob(job));
}
