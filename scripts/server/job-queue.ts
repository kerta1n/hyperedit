import type { JobRecord } from './job-store.ts';
import { completeJob, createJob, failJob, markJobRunning } from './job-store.ts';
import { isLLMProviderLocal } from './llm-gateway.ts';

// Lane scheduling over the job store. Owner-locked concurrency caps
// (R1 doc §5.3(5)), env-overridable. llm lane: 3 when the resolved provider
// URL is remote (cloud or LAN box), 1 when localhost — an agent hammering an
// LLM-backed endpoint can overwhelm any target. ffmpeg lane covers CPU-bound
// asset work (dead-air, audio-sync, create-gif).

function envCap(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const LANE_CAPS: Record<string, number> = {
  render: envCap('HYPEREDIT_RENDER_CONCURRENCY', 1),
  transcribe: envCap('HYPEREDIT_TRANSCRIBE_CONCURRENCY', 1),
  ffmpeg: envCap('HYPEREDIT_FFMPEG_CONCURRENCY', 1),
  llm: envCap('HYPEREDIT_LLM_CONCURRENCY', isLLMProviderLocal() ? 1 : 3),
  fal: envCap('HYPEREDIT_FAL_CONCURRENCY', 4),
};

interface QueueEntry {
  job: JobRecord;
  run: (job: JobRecord) => Promise<unknown>;
}

const laneQueues = new Map<string, QueueEntry[]>();
const laneRunning = new Map<string, number>();

export function enqueueJob(args: {
  sessionId: string;
  kind: string;
  lane: string;
  run: (job: JobRecord) => Promise<unknown>;
}): JobRecord {
  if (!(args.lane in LANE_CAPS)) {
    throw new Error(`Unknown job lane: ${args.lane}`);
  }
  const job = createJob(args.sessionId, args.kind);
  let queue = laneQueues.get(args.lane);
  if (!queue) {
    queue = [];
    laneQueues.set(args.lane, queue);
  }
  queue.push({ job, run: args.run });
  pump(args.lane);
  return job;
}

// Waiting entries ahead of a queued job plus the lane's running count — the
// "N earlier renders" number the old NDJSON queued message carried.
export function getQueuePosition(jobId: string): number | null {
  for (const [lane, queue] of laneQueues) {
    const index = queue.findIndex(e => e.job.id === jobId && e.job.state === 'queued');
    if (index === -1) continue;
    const ahead = queue.slice(0, index).filter(e => e.job.state === 'queued').length;
    return ahead + (laneRunning.get(lane) || 0);
  }
  return null;
}

function pump(lane: string): void {
  const queue = laneQueues.get(lane);
  if (!queue) return;
  const cap = LANE_CAPS[lane];
  while ((laneRunning.get(lane) || 0) < cap && queue.length > 0) {
    const entry = queue.shift()!;
    // Canceled while waiting — already finalized by the store, never runs.
    if (entry.job.state !== 'queued') continue;
    laneRunning.set(lane, (laneRunning.get(lane) || 0) + 1);
    markJobRunning(entry.job);
    entry.run(entry.job)
      .then(
        (result) => completeJob(entry.job, result),
        (err: any) => failJob(entry.job, err?.message || String(err), err?.statusCode),
      )
      .finally(() => {
        laneRunning.set(lane, (laneRunning.get(lane) || 0) - 1);
        pump(lane);
      });
  }
}
