import type { IncomingMessage, ServerResponse } from 'http';
import formidable from 'formidable';
import { MAX_UPLOAD_BYTES, UPLOAD_STAGING_DIR } from './server-config.ts';
import type { JobRecord } from './job-store.ts';

// Send a JSON response. CORS headers are already applied globally per-request
// in the server's request handler.
export function sendJSON(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// 202 submit response — uniform across every job-model lane.
export function sendJobAccepted(res: ServerResponse, sessionId: string, job: JobRecord): void {
  sendJSON(res, { success: true, jobId: job.id, statusUrl: `/session/${sessionId}/jobs/${job.id}` }, 202);
}

// Error carrying an HTTP-status-equivalent. Job lanes throw these so a
// mid-work 4xx (user-addressable outcome) keeps its meaning through the
// polled error state instead of flattening into a server failure.
export function httpError(statusCode: number, message: string): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export async function parseBody(req: IncomingMessage): Promise<any> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

// Parse a multipart upload. Files stage to UPLOAD_STAGING_DIR by default so the
// post-parse move into a session directory is a same-volume rename. Override
// uploadDir only for direct-to-destination (session assets) or tiny transient
// files where the ramdisk is the right home.
export function parseMultipartForm(req: IncomingMessage, options: { maxFileSize?: number; uploadDir?: string } = {}) {
  const form = formidable({
    maxFileSize: options.maxFileSize ?? MAX_UPLOAD_BYTES,
    uploadDir: options.uploadDir ?? UPLOAD_STAGING_DIR,
    keepExtensions: true,
  });
  return form.parse(req);
}
