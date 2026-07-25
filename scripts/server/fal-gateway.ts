import { readFileSync, writeFileSync } from 'fs';
import { fal } from '@fal-ai/client';

// Generative-media provider gateway (image-gen / video-gen / bg-removal).
// The only server module (besides provider/gateway peers) allowed to name
// this vendor; call sites speak task vocabulary.

export async function falUpload(filePath: string, mimeType: string, jobId: string): Promise<string> {
  const buffer = readFileSync(filePath);
  console.log(`[${jobId}] Uploading ${(buffer.length / (1024 * 1024)).toFixed(1)} MB to provider storage...`);
  const url = await fal.storage.upload(new Blob([buffer], { type: mimeType }));
  console.log(`[${jobId}] Uploaded: ${url.substring(0, 50)}...`);
  return url;
}

// Generative model call; resolves with the SDK's { data, requestId }.
// Queue-managed by default; queue: false for short synchronous models.
// onRequestId fires when the provider queue accepts the request — the seam
// the job model uses to make a remote cancel attempt on DELETE.
export function callFal(model: string, input: any, jobId: string, { queue = true, onRequestId }: { queue?: boolean; onRequestId?: (requestId: string) => void } = {}): Promise<any> {
  if (!queue) return fal.run(model, { input });
  return fal.subscribe(model, {
    input,
    logs: true,
    onEnqueue: (requestId: string) => {
      onRequestId?.(requestId);
    },
    onQueueUpdate: (update: any) => {
      if (update.status === 'IN_QUEUE') {
        console.log(`[${jobId}] Queued at position ${update.position || '?'}`);
      } else if (update.status === 'IN_PROGRESS') {
        console.log(`[${jobId}] Processing...`);
      }
    },
  });
}

// Best-effort remote cancel for a queued/running generative request. The
// paid path is untestable here (owner-accepted); failures only log.
export function cancelGenerativeRequest(model: string, requestId: string, jobId: string): void {
  fal.queue.cancel(model, { requestId }).then(
    () => console.log(`[${jobId}] Remote cancel accepted for ${requestId}`),
    (err: any) => console.warn(`[${jobId}] Remote cancel failed:`, err.message),
  );
}

// Download a generated artifact URL to a local file.
export async function downloadArtifact(url: string, outputPath: string, label = 'artifact'): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${label}: ${response.status}`);
  writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
}
