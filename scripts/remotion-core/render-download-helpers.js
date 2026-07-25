/**
 * render-download-helpers.js — Short-circuits Remotion's asset downloads for
 * session files that are already local.
 *
 * Remotion downloads every http(s) media src into its per-render download-map
 * before frame extraction (OffthreadVideo) and audio mixing — for HyperEdit
 * that means a full copy of each session asset (multi-GB long-form sources) on
 * EVERY render, written to the same drive that is absorbing frame captures.
 * Slow and wears the disk.
 *
 * The shim patches downloadFile in Remotion's CJS module registry (render.js
 * consumes the CJS build for exactly this reason): session-asset :3333 URLs are
 * hard-linked into the download dir instead of streamed over HTTP — instant,
 * zero extra disk (same volume). Everything else (GIPHY, remote media) passes
 * through untouched.
 *
 * Phase 4 §6.6 note: this is NO LONGER a deadlock workaround (the render worker
 * runs off the event loop, so the supervisor can serve :3333 during a render).
 * It is kept purely as the perf optimization above — without it every render
 * re-copies its source assets over HTTP. The registration path was dropped:
 * URLs resolve straight from the sessions directory (assetId prefix), so no
 * per-render assetId→path map is threaded through the render call anymore.
 */

import { createRequire } from 'module';
import { existsSync, linkSync, copyFileSync, mkdirSync, statSync, readdirSync } from 'fs';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);

let installed = false;

// Session assets are referenced by :3333 URL; resolve straight from the
// sessions directory: /session/{sid}/assets/{aid}/... → {sessionsDir}/{sid}/assets/{aid}.*
function resolveFromSessionsDir(pathname) {
  const match = pathname.match(/\/session\/([^/]+)\/assets\/([^/]+)\//);
  if (!match) return null;
  const sessionsDir = process.env.HYPEREDIT_SESSIONS_DIR;
  if (!sessionsDir) return null;
  const assetsDir = join(sessionsDir, match[1], 'assets');
  if (!existsSync(assetsDir)) return null;
  const prefix = `${match[2]}.`;
  const file = readdirSync(assetsDir).find((f) => f.startsWith(prefix));
  return file ? join(assetsDir, file) : null;
}

function resolveLocalPath(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return null;
  return resolveFromSessionsDir(parsed.pathname);
}

export function installDownloadShim() {
  if (installed) return;
  installed = true;

  const internalRequire = createRequire(require.resolve('@remotion/renderer'));
  const downloadFileModule = internalRequire('./assets/download-file.js');
  const originalDownloadFile = downloadFileModule.downloadFile;
  if (typeof originalDownloadFile !== 'function') {
    console.warn('[Remotion] download-file module shape changed — local-asset shim disabled');
    return;
  }

  downloadFileModule.downloadFile = async (options, ...rest) => {
    const localPath = resolveLocalPath(options.url);
    if (!localPath) return originalDownloadFile(options, ...rest);

    // Same signature Remotion uses: to(contentDisposition, contentType).
    const to = options.to(null, null);
    mkdirSync(dirname(to), { recursive: true });
    if (!existsSync(to)) {
      try {
        linkSync(localPath, to); // same volume — instant, zero extra disk
      } catch {
        copyFileSync(localPath, to); // cross-volume fallback
      }
    }
    const sizeInBytes = statSync(to).size;
    if (options.onProgress) {
      options.onProgress({ downloaded: sizeInBytes, percent: 1, totalSize: sizeInBytes });
    }
    // Leading newline: this fires mid-render, interleaved with the \r-based
    // progress line from makeProgressLogger
    console.log(`\n[Remotion] Local asset link (no download): ${options.url} -> ${to}`);
    return { sizeInBytes, to };
  };
}
