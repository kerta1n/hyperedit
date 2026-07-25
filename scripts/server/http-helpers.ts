import type { IncomingMessage, ServerResponse } from 'http';
import formidable from 'formidable';
import { getRenderQueueDepth } from '../remotion-core/render.js';
import { MAX_UPLOAD_BYTES, UPLOAD_STAGING_DIR } from './server-config.ts';

// Send a JSON response. CORS headers are already applied globally per-request
// in the server's request handler.
export function sendJSON(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
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

// Stream render progress as NDJSON, then write final result
export async function streamRender(res: ServerResponse, renderFn: (onProgress: (p: any) => void) => Promise<any>): Promise<void> {
  // A disconnecting client must not crash the server: writes to a destroyed
  // socket emit async 'error' events that try/catch around res.write can't see.
  res.on('error', (err) => {
    console.warn('[Render] Response stream error (client gone?):', err.message);
  });
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Transfer-Encoding': 'chunked',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });

  // Renders serialize through a global queue; a queued request would otherwise
  // stream nothing until it reaches the front — tell the client it is waiting.
  const queueDepth = getRenderQueueDepth();
  if (queueDepth > 0) {
    try {
      res.write(JSON.stringify({ type: 'queued', position: queueDepth }) + '\n');
    } catch (e) { /* client disconnected */ }
  }

  const onProgress = ({ pct, renderedFrames, totalFrames, elapsed }: any) => {
    const min = Math.floor(elapsed / 60);
    const sec = String(elapsed % 60).padStart(2, '0');
    try {
      res.write(JSON.stringify({
        type: 'progress', pct, frames: renderedFrames, total: totalFrames, elapsed: `${min}:${sec}`,
      }) + '\n');
    } catch (e) { /* client disconnected */ }
  };

  try {
    const result = await renderFn(onProgress);
    res.write(JSON.stringify({ type: 'result', ...result }) + '\n');
    res.end();
  } catch (err: any) {
    try {
      res.write(JSON.stringify({ type: 'error', message: err.message }) + '\n');
      res.end();
    } catch (e) { res.end(); }
  }
}
