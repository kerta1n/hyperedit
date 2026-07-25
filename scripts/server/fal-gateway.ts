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
export function callFal(model: string, input: any, jobId: string, { queue = true }: { queue?: boolean } = {}): Promise<any> {
  if (!queue) return fal.run(model, { input });
  return fal.subscribe(model, {
    input,
    logs: true,
    onQueueUpdate: (update: any) => {
      if (update.status === 'IN_QUEUE') {
        console.log(`[${jobId}] Queued at position ${update.position || '?'}`);
      } else if (update.status === 'IN_PROGRESS') {
        console.log(`[${jobId}] Processing...`);
      }
    },
  });
}

// Download a generated artifact URL to a local file.
export async function downloadArtifact(url: string, outputPath: string, label = 'artifact'): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${label}: ${response.status}`);
  writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
}
