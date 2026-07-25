import { existsSync } from 'fs';
import { join } from 'path';
import type { JobRecord } from './job-store.ts';
import { updateJobProgress } from './job-store.ts';
import { enqueueJob } from './job-queue.ts';
import { getMediaInfo, generateThumbnail } from './ffmpeg-helpers.ts';
import { saveAssetMetadata, type Session } from './session-store.ts';

// Per-asset ingest pipeline on the `ingest` lane. One declared job graph —
// probe → conform flags → proxy → waveform peaks → thumbnail — instead of each
// step bolted where someone once needed it (Phase 5 §7.2). Steps degrade by
// asset type and are failure-isolated: a later step's failure keeps the earlier
// artifacts. Proxy (step 4) and waveform peaks (step 7) are declared here and
// filled in by their own slices; today the pipeline conforms metadata and
// (re)builds the thumbnail.
//
// `force` = the asset's bytes changed in place (dead-air): redo everything.
// Otherwise steps skip what already exists (backfill / fresh upload).

async function runIngest(job: JobRecord, session: Session, assetId: string, force: boolean): Promise<unknown> {
  const asset = session.assets.get(assetId);
  if (!asset) return { assetId, skipped: 'asset-gone' };

  const done: string[] = [];
  const step = (name: string) => updateJobProgress(job, { step: name, steps: done });

  const isAudio = asset.type === 'audio';
  const hasFile = !!asset.path && existsSync(asset.path);

  // ── probe → conform flags ──
  if (!isAudio && hasFile) {
    step('probe');
    try {
      const info = await getMediaInfo(asset.path);
      // Conform flags are the probe's to own — always refresh them (dead-air
      // output is CFR/SDR, so this correctly clears stale VFR/HDR after an edit).
      asset.vfr = info.vfr;
      asset.hdr = info.hdr;
      asset.rotation = info.rotation;
      // Dimensions/duration: only fill if missing — never clobber a value the
      // caller already set (dead-air owns the post-trim duration).
      if (!asset.width) asset.width = info.width;
      if (!asset.height) asset.height = info.height;
      if (!asset.duration) asset.duration = info.duration;
      saveAssetMetadata(session);
      done.push('probe');
    } catch (e) {
      console.warn(`[Ingest] probe failed for ${assetId}: ${(e as Error).message}`);
    }
  }

  // ── proxy (video) — Phase 5 step 4 ──
  // TODO: encode the 960x540 dense-GOP proxy to sessions/{id}/proxies/{assetId}.mp4.

  // ── waveform peaks (video/audio) — Phase 5 step 7 ──
  // TODO: emit ~20 peaks/sec JSON for the timeline waveform strip.

  // ── thumbnail (video/image) — last step, folded out of the inline paths ──
  if (!isAudio && hasFile) {
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
    if (force || !existsSync(thumbPath)) {
      step('thumbnail');
      try {
        await generateThumbnail(asset.path, thumbPath, asset.type === 'image');
        asset.thumbPath = thumbPath;
        saveAssetMetadata(session);
        done.push('thumbnail');
      } catch (e) {
        console.warn(`[Ingest] thumbnail failed for ${assetId}: ${(e as Error).message}`);
      }
    }
  }

  console.log(`[Ingest] ${assetId} (${asset.type}${force ? ', force' : ''}) → ${done.join(' + ') || 'nothing to do'}`);
  return { assetId, steps: done };
}

// Enqueue an ingest job for one asset. Returns the JobRecord (202 { jobId }).
export function enqueueIngest(session: Session, assetId: string, opts: { force?: boolean } = {}): JobRecord {
  return enqueueJob({
    sessionId: session.id,
    kind: 'ingest',
    lane: 'ingest',
    run: (job) => runIngest(job, session, assetId, opts.force === true),
  });
}
