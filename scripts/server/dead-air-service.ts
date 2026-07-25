import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { calculateKeepSegments, detectSilence, getVideoDuration, runFFmpeg } from './ffmpeg-helpers.ts';
import { sendJSON, sendJobAccepted } from './http-helpers.ts';
import { onAssetMutated, requireSession } from './session-store.ts';
import { enqueueIngest } from './ingest-service.ts';
import { enqueueJob } from './job-queue.ts';
import type { SessionRoute } from './route-table.ts';

// STABLE WORKFLOW — DO NOT MODIFY (see CLAUDE.md "Dead Air Removal").
// The segment-based extract + re-encode + concat approach is required;
// single-pass filter approaches (select/aselect, trim/atrim) drop audio
// streams. This file's boundary IS the decree's scope. (Phase 3 changed the
// response envelope only — 202 { jobId } + polled status; the workflow
// mechanics inside the job are untouched.)

// Remove dead air within a session
async function handleSessionRemoveDeadAir(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    // Parse options from body
    let body = '';
    for await (const chunk of req) body += chunk;
    const options = body ? JSON.parse(body) : {};

    const silenceThreshold = options.silenceThreshold || -30;
    const minSilenceDuration = options.minSilenceDuration || 0.3;

    // Explicit target only — library-order guessing is nondeterministic after restarts
    if (!options.assetId) {
      sendJSON(res, {
        error: 'assetId is required',
        hint: 'Pass the id of the video asset to process; GET /session/:id/assets lists assets.',
      }, 400);
      return;
    }
    const videoAsset = session.assets.get(options.assetId);
    if (!videoAsset || videoAsset.type !== 'video') {
      sendJSON(res, {
        error: `No video asset with id ${options.assetId} in session`,
        hint: 'GET /session/:id/assets lists available assets.',
      }, 400);
      return;
    }

    // Verify the video file exists on disk
    if (!existsSync(videoAsset.path)) {
      console.error(`[${sessionId}] Video file missing: ${videoAsset.path}`);
      sendJSON(res, {
        error: 'Video file no longer exists. Your session may have expired. Please re-upload your video.',
        code: 'VIDEO_FILE_MISSING'
      }, 410);
      return;
    }

    const job = enqueueJob({
      sessionId,
      kind: 'dead-air',
      lane: 'ffmpeg',
      run: async (job) => {
    const jobId = job.id;
    const outputPath = join(session.dir, `deadair-output-${Date.now()}.mp4`);
    const concatListPath = join(session.dir, `concat-${Date.now()}.txt`);
    const segmentPaths: string[] = [];

    try {
    console.log(`\n[${jobId}] === DEAD AIR REMOVAL (Session) ===`);
    console.log(`[${jobId}] Using video asset: ${videoAsset.filename} (${videoAsset.path})`);

    const totalDuration = await getVideoDuration(videoAsset.path);
    console.log(`[${jobId}] Video duration: ${totalDuration.toFixed(2)}s`);

    const silencePeriods = await detectSilence(videoAsset.path, jobId, {
      silenceThreshold,
      minSilenceDuration,
    });

    if (silencePeriods.length === 0) {
      console.log(`[${jobId}] No silence detected`);
      return {
        success: true,
        duration: totalDuration,
        removedDuration: 0,
        message: 'No silence detected',
      };
    }

    const keepSegments = calculateKeepSegments(silencePeriods, totalDuration);
    console.log(`[${jobId}] Keeping ${keepSegments.length} segments`);

    const totalKeptDuration = keepSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
    const removedDuration = totalDuration - totalKeptDuration;
    console.log(`[${jobId}] Removing ${removedDuration.toFixed(2)}s of dead air (${((removedDuration / totalDuration) * 100).toFixed(1)}%)`);

    // Extract segments
    console.log(`[${jobId}] Extracting segments...`);
    for (let i = 0; i < keepSegments.length; i++) {
      const seg = keepSegments[i];
      const segmentPath = join(session.dir, `segment-${Date.now()}-${i}.mp4`);
      segmentPaths.push(segmentPath);

      // -ss before -i (input seeking): jumps to the segment instead of decoding the
      // whole file up to it — O(n) instead of O(n²) across segments. Frame-accurate
      // here because every segment is re-encoded.
      const args = [
        '-y',
        '-ss', seg.start.toString(),
        '-i', videoAsset.path,
        '-t', (seg.end - seg.start).toString(),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k',
        segmentPath
      ];

      await runFFmpeg(args, jobId);
      console.log(`\n[${jobId}] Segment ${i + 1}/${keepSegments.length}`);
    }

    // Concatenate
    const concatList = segmentPaths.map(p => `file '${p}'`).join('\n');
    writeFileSync(concatListPath, concatList);

    console.log(`[${jobId}] Concatenating...`);
    await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', '-movflags', '+faststart', outputPath], jobId);

    console.log(`\n[${jobId}] Dead air removal complete`);

    // Cleanup segments
    segmentPaths.forEach(p => { try { unlinkSync(p); } catch { } });
    try { unlinkSync(concatListPath); } catch { }

    // Replace the video asset file
    const { rename, stat } = await import('fs/promises');
    unlinkSync(videoAsset.path);
    await rename(outputPath, videoAsset.path);

    const newStats = await stat(videoAsset.path);

    // Update the video asset metadata
    videoAsset.duration = totalKeptDuration;
    videoAsset.size = newStats.size;

    // Envelope-only bookkeeping AFTER the do-not-modify extract/concat/replace
    // mechanics (Phase 5 §7.5, decree-2 exception): persist the new duration/size
    // (dead-air updated them in memory only — a restart restored the pre-edit
    // duration) + invalidate the cached transcript, then re-ingest the rewritten
    // bytes to rebuild the thumbnail (and later proxy/peaks) off the ffmpeg lane.
    onAssetMutated(session, options.assetId);
    const ingestJob = enqueueIngest(session, options.assetId, { force: true });

    session.editCount++;

    console.log(`\n[${jobId}] === DEAD AIR REMOVAL COMPLETE ===`);

    return {
      success: true,
      duration: totalKeptDuration,
      originalDuration: totalDuration,
      removedDuration,
      size: newStats.size,
      editCount: session.editCount,
      // The post-edit thumbnail (+ proxy) rebuild runs on this async ingest job;
      // the client polls it to refresh the otherwise-stale pre-edit thumbnail.
      ingestJobId: ingestJob.id,
    };

    } catch (error: any) {
      console.error(`[${jobId}] Error:`, error.message);
      segmentPaths.forEach(p => { try { unlinkSync(p); } catch { } });
      try { unlinkSync(concatListPath); } catch { }
      throw error;
    }
      },
    });

    sendJobAccepted(res, sessionId, job);
  } catch (error: any) {
    console.error(`[${sessionId}] Error:`, error.message);
    sendJSON(res, { error: error.message }, 500);
  }
}

export const deadAirRoutes: SessionRoute[] = [
  { method: 'POST', action: 'remove-dead-air', handler: handleSessionRemoveDeadAir },
];
