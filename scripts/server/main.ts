// HyperEdit local server entry: session-based FFmpeg/Remotion backend + SPA
// hosting, decomposed into scripts/server/* services (R1). Node runs this
// file directly via type stripping — no build step.
// server-config loads .dev.vars, validates the storage env, and pins temp
// dirs — it must stay the first server/* import.
import { PORT } from './server-config.ts';
import { serve } from '@hono/node-server';
import { detectCapabilities } from '../hw-detect.js';
import { cleanupStaleTempFiles, cleanupStaleRenderArtifacts, restoreSessionsFromDisk } from './session-store.ts';
import { resetWarmCache } from './proxy-cache-store.ts';
import { cancelAllActiveJobs } from './job-store.ts';
import { shutdownWorker } from './render-client.ts';
import { buildApp } from './http-app.ts';

// Run hardware detection after env vars are loaded
detectCapabilities().then((caps) => {
  console.log(`[Server] HW acceleration: preferred encoder = ${caps.preferredEncoder || 'none (software fallback)'}`);
}).catch((err) => {
  console.warn('[Server] HW detection failed, using software encoding:', err.message);
});

// EPIPE shield: writes to already-dead pipes (Remotion's compositor child
// after it exits, or a client socket after disconnect) surface as async
// 'error' events no try/catch can reach, and must not kill the only server
// process. Anything other than EPIPE keeps fail-fast crash semantics.
process.on('uncaughtException', (err: any) => {
  if (err && err.code === 'EPIPE') {
    console.warn('[Server] Ignored EPIPE from a closed pipe:', err.message);
    return;
  }
  throw err;
});

cleanupStaleTempFiles();
cleanupStaleRenderArtifacts();
// Stale warm proxy copies from a previous run are untracked ramdisk budget —
// clear them; sessions re-warm from the HDD on open.
resetWarmCache();
restoreSessionsFromDisk();

const app = buildApp();

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  // Bundle cache lives in the render worker now (lazily spawned) and starts
  // empty, so there is nothing to invalidate at supervisor startup.
  console.log(`\n🎬 Local FFmpeg server running at http://localhost:${PORT}`);
  console.log(`\n   Session Management:`);
  console.log(`   GET  /sessions - List all sessions`);
  console.log(`   PATCH /session/:id/name - Rename session`);
  console.log(`\n   Session API:`);
  console.log(`   POST /session/create - Create new editing session`);
  console.log(`   POST /session/:id/remove-dead-air - Remove silence`);
  console.log(`   POST /session/:id/chapters - Generate chapters`);
  console.log(`   DELETE /session/:id - Clean up session`);
  console.log(`\n   Multi-Asset API:`);
  console.log(`   POST /session/:id/assets - Upload asset (video/image/audio)`);
  console.log(`   GET  /session/:id/assets - List all assets`);
  console.log(`   DELETE /session/:id/assets/:assetId - Delete asset`);
  console.log(`   GET  /session/:id/assets/:assetId/thumbnail - Get thumbnail`);
  console.log(`   GET  /session/:id/assets/:assetId/stream - Stream asset`);
  console.log(`\n   Project API (Remotion-first):`);
  console.log(`   GET  /session/:id/project - Get project state`);
  console.log(`   PUT  /session/:id/project - Save project state`);
  console.log(`   GET  /session/:id/remotion-spec - Build normalized Remotion spec`);
  console.log(`   POST /session/:id/remotion-spec/variants - Generate ad variants`);
  console.log(`   POST /session/:id/render - Render project via Remotion core`);
  console.log(`   POST /session/:id/render-from-spec - Render directly from spec JSON`);
  console.log(`   POST /session/:id/render-variants - Batch render generated variants`);
  console.log(`   GET  /session/:id/renders/preview - Download preview`);
  console.log(`   GET  /session/:id/renders/export - Download export`);
  console.log(`\n   AI/Auto GIF API:`);
  console.log(`   POST /session/:id/transcribe-and-extract - Transcribe video, extract keywords, fetch GIFs`);
  console.log(`   POST /session/:id/generate-broll - Generate AI B-roll images from transcript`);
  console.log(`   POST /session/:id/generate-animation - AI-generated custom animation`);
  console.log(`   POST /session/:id/analyze-for-animation - Analyze video, return concept for approval`);
  console.log(`   POST /session/:id/generate-contextual-animation - Content-aware animation (transcribes video first)`);
  console.log(`   POST /session/:id/process-asset - Apply FFmpeg command to an asset`);
  console.log(`\n   GET /health - Health check`);
  console.log(`   GET /hwaccel-info - Hardware acceleration diagnostics\n`);
});

// Graceful shutdown (SIGTERM from `docker stop`, SIGINT from Ctrl+C): stop
// accepting new requests, cancel in-flight jobs (running renders fire their
// IPC cancel), close the render worker so its Chrome exits cleanly, then exit.
// Leaves no orphaned ffmpeg/Chrome for the next start's temp sweep to find.
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Server] ${signal} received — shutting down`);
  try { server.close(); } catch { /* already closing */ }
  cancelAllActiveJobs();
  await shutdownWorker();
  console.log('[Server] shutdown complete');
  process.exit(0);
}
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
