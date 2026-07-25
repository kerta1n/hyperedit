// Phase 4 render worker: hosts the in-process Remotion render family
// (renderSpecWithRemotion / renderDynamicAnimation / renderVariantBatch) in a
// forked child so renderMedia() no longer blocks the supervisor's event loop.
// render-client.ts is the ONLY thing that talks to this file, over the fork
// IPC channel. render.js and its module-level bundle/browser caches +
// serializeRender OOM guard live here now; the supervisor keeps sessions /
// jobs / HTTP. See docs/fable-phase4-execution-plan.md.

import { detectCapabilities } from '../hw-detect.js';
import {
  closeRenderBrowser,
  invalidateBundleCache,
  makeRenderCancelSignal,
  renderDynamicAnimation,
  renderSpecWithRemotion,
  renderVariantBatch,
} from '../remotion-core/render.js';

// In-flight cancel hooks, keyed by jobId; a belt Set for a cancel that races
// ahead of its run (IPC on one channel is ordered, so this is defensive only).
const cancels = new Map<string, () => void>();
const canceledBeforeRun = new Set<string>();

// Per-job progress throttle — renderMedia's onProgress fires per frame; an
// unthrottled IPC flood is self-inflicted lag the supervisor then "debugs".
const lastProgressAt = new Map<string, number>();
const PROGRESS_MIN_INTERVAL_MS = 250;

function send(msg: unknown): void {
  process.send?.(msg);
}

function makeProgress(jobId: string) {
  return (data: any) => {
    const now = Date.now();
    const isFinal = data?.pct === 100;
    if (!isFinal && now - (lastProgressAt.get(jobId) || 0) < PROGRESS_MIN_INTERVAL_MS) return;
    lastProgressAt.set(jobId, now);
    send({ type: 'progress', jobId, data });
  };
}

async function runJob(renderKind: string, jobId: string, payload: any): Promise<void> {
  // Cancel arrived before the run — settle immediately (supervisor's failJob
  // converts this 'error' to 'canceled' because cancelRequested is set).
  if (canceledBeforeRun.delete(jobId)) {
    send({ type: 'error', jobId, message: 'canceled' });
    return;
  }
  const { cancelSignal, cancel } = makeRenderCancelSignal();
  cancels.set(jobId, cancel);
  const onProgress = makeProgress(jobId);
  try {
    let result: unknown;
    if (renderKind === 'spec') {
      const { spec, outputPath, preview, logLevel, renderOptions } = payload;
      result = await renderSpecWithRemotion({
        spec,
        outputPath,
        preview,
        logLevel,
        renderOptions,
        onProgress,
        cancelSignal,
      });
    } else if (renderKind === 'dynamic') {
      const { sceneData, outputPath, width, height, fps, logLevel } = payload;
      result = await renderDynamicAnimation({
        sceneData,
        outputPath,
        width,
        height,
        fps,
        logLevel,
        onProgress,
        cancelSignal,
      });
    } else if (renderKind === 'variant') {
      const { variants, outDir, prefix, preview, compositionId, logLevel } = payload;
      result = await renderVariantBatch({ variants, outDir, prefix, preview, compositionId, logLevel });
    } else {
      throw new Error(`render-worker: unknown renderKind '${renderKind}'`);
    }
    send({ type: 'done', jobId, result });
  } catch (err: any) {
    // Do NOT label cancellations here — the supervisor owns that decision.
    send({ type: 'error', jobId, message: err?.message || String(err), errorStatus: err?.statusCode });
  } finally {
    cancels.delete(jobId);
    lastProgressAt.delete(jobId);
  }
}

process.on('message', (msg: any) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'run':
      // Fire-and-forget: render.js's serializeRender chain queues concurrent runs.
      void runJob(msg.renderKind, msg.jobId, msg.payload);
      return;
    case 'cancel': {
      const cancel = cancels.get(msg.jobId);
      if (cancel) {
        try { cancel(); } catch { /* signal already settled */ }
      } else {
        canceledBeforeRun.add(msg.jobId);
      }
      return;
    }
    case 'invalidate-bundle':
      invalidateBundleCache();
      return;
    case 'shutdown':
      // Close Chrome (awaited) before exiting so it isn't orphaned.
      void closeRenderBrowser().finally(() => process.exit(0));
      return;
  }
});

// Boot: prime THIS process's hw-detect cache BEFORE signaling ready.
// getCapabilities() throws unprimed → render.js falls back to software AND
// skips the NVENC/aac CJS patch; post-4.0.491 the bundled ffmpeg lacks
// libfdk_aac, so that path FAILS on audio. Detection failing is not fatal
// (renders degrade to software) — signal ready anyway so the supervisor
// never hangs, but log it loudly.
detectCapabilities()
  .then(() => send({ type: 'ready' }))
  .catch((err: any) => {
    console.warn('[render-worker] detectCapabilities failed (software fallback):', err?.message);
    send({ type: 'ready' });
  });
