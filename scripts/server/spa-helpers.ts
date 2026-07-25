import type { ServerResponse } from 'http';
import { createReadStream, existsSync, statSync } from 'fs';
import { join } from 'path';
import { sendJSON } from './http-helpers.ts';

// Production hosting moved here from Cloudflare: serve the built SPA out of
// dist/. Content-hashed bundles cache immutably (tiny, read-mostly); index.html
// is always revalidated. Media/asset streams are handled by their own routes.
const DIST_DIR = join(process.cwd(), 'dist');
const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export function serveSpa(res: ServerResponse, urlPath: string): void {
  let rel;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  } catch {
    rel = 'index.html';
  }
  let filePath = join(DIST_DIR, rel);
  // Guard traversal, and fall back to index.html for SPA routes
  if (!filePath.startsWith(DIST_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(DIST_DIR, 'index.html');
    if (!existsSync(filePath)) {
      sendJSON(res, { error: 'Not found (run `npm run build` to serve the app from this server)' }, 404);
      return;
    }
  }
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const hashedAsset = filePath.replace(/\\/g, '/').includes('/assets/');
  res.writeHead(200, {
    'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
    'Cache-Control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}
