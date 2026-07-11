/**
 * render-download-helpers.js — Short-circuits Remotion's asset downloads for
 * files that are already local.
 *
 * Remotion downloads every http(s) media src into its per-render download-map
 * before frame extraction (OffthreadVideo) and audio mixing — for HyperEdit
 * that means a full copy of each session asset (multi-GB sources) on EVERY
 * render, written to the same HDD that is absorbing frame captures, streamed
 * through the same Node event loop that drives the render. Slow, wears the
 * disk, and when the copy outlasts the delayRender window the render dies
 * with the cryptic "delayRender was called but not cleared after 118000ms".
 *
 * The shim patches downloadFile in Remotion's CJS module registry (render.js
 * consumes the CJS build for exactly this reason): session-asset URLs
 * registered via registerLocalRenderAssets() are hard-linked into the
 * download dir instead of streamed over HTTP — instant, zero extra disk
 * (same volume). Everything else (GIPHY, remote media) passes through.
 */

import { createRequire } from 'module';
import { existsSync, linkSync, copyFileSync, mkdirSync, statSync, readdirSync } from 'fs';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);

/** assetId → absolute path of the already-local source file */
const localAssets = new Map();
let installed = false;

/**
 * Register the assetId → local path map for the upcoming render and make sure
 * the download shim is installed. Safe to call once per render; entries
 * accumulate (asset ids are unique per session).
 */
export function registerLocalRenderAssets(assetPathMap) {
  for (const [assetId, path] of assetPathMap) {
    localAssets.set(assetId, path);
  }
  installDownloadShim();
}

// Animation renders (media scenes) reference session assets by :3333 URL
// without a registration step, so also resolve straight from the sessions
// directory: /session/{sid}/assets/{aid}/... → {sessionsDir}/{sid}/assets/{aid}.*
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
  const match = parsed.pathname.match(/\/assets\/([^/]+)\//);
  if (!match) return null;
  const registered = localAssets.get(match[1]);
  if (registered && existsSync(registered)) return registered;
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
    // contentType is only consulted when the pathname has no extension —
    // rewritten session srcs always carry one (e.g. stream.mp4).
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
