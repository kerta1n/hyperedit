import type { IncomingMessage, ServerResponse } from 'http';
import { createReadStream, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { parseMultipartForm, sendJSON } from './http-helpers.ts';
import { requireSession, saveAssetMetadata } from './session-store.ts';
import { generateThumbnail, getMediaInfo, getVideoDuration } from './ffmpeg-helpers.ts';
import { hasBlockingJob, cancelIngestJobs } from './job-store.ts';
import { enqueueIngest } from './ingest-service.ts';
import { touch as touchProxyCache, evictAssetProxy, getWarmProxyPath } from './proxy-cache-store.ts';
import type { SessionRoute } from './route-table.ts';

// Asset storage + serving: upload, list, delete, thumbnails, range-request
// streaming. Transformation endpoints (process-asset, extract-audio, ...)
// live in asset-processing-service. The parameterized /assets/:id/* handlers
// are exported for the entry's dispatch until the Hono slice absorbs params.

// Upload asset to session
async function handleAssetUpload(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    // Direct-to-destination: the asset's final home, so the move is a same-dir rename.
    const [, files] = await parseMultipartForm(req, { uploadDir: session.assetsDir });
    const uploadedFile = files.file?.[0] || files.video?.[0];

    if (!uploadedFile) {
      sendJSON(res, { error: 'Missing file' }, 400);
      return;
    }

    const assetId = randomUUID();
    const originalName = uploadedFile.originalFilename || 'file';
    const ext = originalName.split('.').pop()?.toLowerCase() || 'mp4';
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    const isAudio = ['mp3', 'wav', 'aac', 'm4a', 'ogg'].includes(ext);
    const type = isImage ? 'image' : isAudio ? 'audio' : 'video';

    // Move file to proper location
    const assetPath = join(session.assetsDir, `${assetId}.${ext}`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);

    const { rename, stat } = await import('fs/promises');
    await rename(uploadedFile.filepath, assetPath);

    // Get media info
    let duration = 0;
    let width = 0;
    let height = 0;
    let fps = 0;
    // Ingest conform flags — the render/proxy pipeline consults these for
    // hostile source media (VFR screen recordings, iPhone HLG, rotated phone clips).
    let vfr = false;
    let hdr = false;
    let rotation = 0;

    if (!isAudio) {
      const info = await getMediaInfo(assetPath);
      duration = info.duration;
      width = info.width;
      height = info.height;
      // Source frame rate only meaningful for videos (images report a bogus rate)
      if (type === 'video' && info.fps) fps = Math.round(info.fps);
      vfr = info.vfr;
      hdr = info.hdr;
      rotation = info.rotation;
    } else {
      duration = await getVideoDuration(assetPath);
    }

    // Generate thumbnail (for video/image)
    if (!isAudio) {
      try {
        await generateThumbnail(assetPath, thumbPath, isImage);
      } catch (e: any) {
        console.warn(`[${sessionId}] Thumbnail generation failed:`, e.message);
      }
    }

    const stats = await stat(assetPath);

    const asset = {
      id: assetId,
      type,
      filename: originalName,
      path: assetPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: isImage ? 5 : duration, // Default 5s for images
      size: stats.size,
      width,
      height,
      fps: fps || undefined,
      vfr,
      hdr,
      rotation,
      createdAt: Date.now(),
    };

    session.assets.set(assetId, asset);
    saveAssetMetadata(session); // Persist asset metadata to disk

    console.log(`[${sessionId}] Asset uploaded: ${assetId} (${type}, ${(stats.size / 1024 / 1024).toFixed(1)} MB)`);

    // Background ingest: probe + thumbnail already ran inline for this response,
    // so the ingest job's real work is the 540p proxy build (video) and the
    // waveform peaks (video + audio, step 7). The proxy/peaks are optional, so
    // the upload succeeds regardless of ingest outcome and we don't await it.
    // Images have no ingest work beyond the inline thumbnail — no job spawned.
    // Return the jobId so the client can poll it and switch the preview from the
    // raw source to the proxy once it's built (a fresh upload's preview otherwise
    // stays committed to the unscrubbable source until a manual reload).
    let ingestJobId: string | undefined;
    if (type === 'video' || type === 'audio') ingestJobId = enqueueIngest(session, assetId).id;

    sendJSON(res, {
      success: true,
      asset: {
        id: asset.id,
        type: asset.type,
        filename: asset.filename,
        duration: asset.duration,
        size: asset.size,
        width: asset.width,
        height: asset.height,
        fps: asset.fps,
        thumbnailUrl: asset.thumbPath ? `/session/${sessionId}/assets/${assetId}/thumbnail` : null,
      },
      ingestJobId,
    });

  } catch (error: any) {
    console.error(`[${sessionId}] Asset upload error:`, error.message);
    sendJSON(res, { error: error.message }, 500);
  }
}

// List all assets in session
function handleAssetList(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  const assets = Array.from(session.assets.values()).map(asset => ({
    id: asset.id,
    type: asset.type,
    filename: asset.filename,
    duration: asset.duration,
    size: asset.size,
    width: asset.width,
    height: asset.height,
    fps: asset.fps,
    thumbnailUrl: asset.thumbPath ? `/session/${sessionId}/assets/${asset.id}/thumbnail` : null,
    aiGenerated: asset.aiGenerated || false, // True for Remotion-generated animations
  }));

  sendJSON(res, { assets });
}

// Delete asset
export async function handleAssetDelete(req: IncomingMessage, res: ServerResponse, sessionId: string, assetId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  const asset = session.assets.get(assetId);
  if (!asset) {
    sendJSON(res, { error: 'Asset not found' }, 404);
    return;
  }

  // A user-initiated job (render/transcribe/dead-air/…) may be reading this
  // asset — refuse rather than corrupt it. The background ingest (proxy build)
  // is disposable and was never user-requested, so it does NOT block; we cancel
  // just this asset's ingest below and wait for the ffmpeg child to release the
  // file before unlinking (M1).
  if (hasBlockingJob(sessionId)) {
    sendJSON(res, {
      error: 'A job is still running for this session',
      hint: 'Wait for in-flight renders/transcriptions to finish (or cancel them via DELETE /session/:id/jobs/:jobId) before deleting assets.',
    }, 409);
    return;
  }
  await cancelIngestJobs(sessionId, assetId);

  // Remove files (source, thumbnail, the now-orphaned proxy and waveform peaks)
  try {
    if (existsSync(asset.path)) unlinkSync(asset.path);
    if (asset.thumbPath && existsSync(asset.thumbPath)) unlinkSync(asset.thumbPath);
    const proxyPath = join(session.dir, 'proxies', `${assetId}.mp4`);
    if (existsSync(proxyPath)) unlinkSync(proxyPath);
    const peaksPath = join(session.dir, 'peaks', `${assetId}.json`);
    if (existsSync(peaksPath)) unlinkSync(peaksPath);
  } catch (e: any) {
    console.warn(`[${sessionId}] Asset file cleanup failed:`, e.message);
  }
  evictAssetProxy(sessionId, assetId); // drop the ramdisk warm copy too



  // Remove from session
  session.assets.delete(assetId);
  saveAssetMetadata(session); // Update metadata file

  // Remove any clips using this asset
  session.project.clips = session.project.clips.filter((clip: any) => clip.assetId !== assetId);

  console.log(`[${sessionId}] Asset deleted: ${assetId}`);

  sendJSON(res, { success: true });
}

// Get asset thumbnail
export async function handleAssetThumbnail(req: IncomingMessage, res: ServerResponse, sessionId: string, assetId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  const asset = session.assets.get(assetId);
  if (!asset || !asset.thumbPath || !existsSync(asset.thumbPath)) {
    sendJSON(res, { error: 'Thumbnail not found' }, 404);
    return;
  }

  const { stat } = await import('fs/promises');
  const stats = await stat(asset.thumbPath);

  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': stats.size,
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  });

  createReadStream(asset.thumbPath).pipe(res);
}

// Stream asset
export async function handleAssetStream(req: IncomingMessage, res: ServerResponse, sessionId: string, assetId: string, url: URL) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  // Active stream = keep this session's warm proxies from being evicted (§7.1).
  touchProxyCache(sessionId);

  const asset = session.assets.get(assetId);
  if (!asset || !existsSync(asset.path)) {
    sendJSON(res, { error: 'Asset not found' }, 404);
    return;
  }

  // Stream tier resolution (§7.4): an explicit ?tier=proxy prefers the 540p
  // preview proxy — R: warm copy → HDD canonical → source; a bare /stream
  // always serves the source, so the render path (its spec URLs carry no tier
  // param) reads sources by construction. The proxy is video-only and an
  // optimization, never a dependency: any miss (not yet built, ingest failed,
  // evicted, non-video) silently falls back to the source — never 404/error —
  // so preview works from the moment of upload. Coexists with ?v= cache-bust.
  // The `status === 'ready'` gate is load-bearing: a proxy that is still
  // encoding (fresh upload) or mid-rebuild (dead-air force, marked `building`
  // by onAssetMutated) must NOT be served — the file on disk is partial or
  // stale — so we fall through to the always-complete source until it settles.
  let servePath = asset.path;
  if (url.searchParams.get('tier') === 'proxy' && asset.type === 'video' && asset.proxy?.status === 'ready') {
    const warm = getWarmProxyPath(sessionId, assetId);
    if (warm) {
      servePath = warm;
    } else {
      const hddProxy = join(session.dir, 'proxies', `${assetId}.mp4`);
      if (existsSync(hddProxy)) servePath = hddProxy;
    }
  }

  const { stat } = await import('fs/promises');
  const stats = await stat(servePath);
  const fileSize = stats.size;

  // Get proper MIME type for the asset
  const getContentType = () => {
    if (asset.type === 'image') {
      const ext = asset.path.split('.').pop()?.toLowerCase();
      const mimeTypes: Record<string, string> = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
      };
      return mimeTypes[ext!] || 'image/jpeg';
    }
    if (asset.type === 'audio') {
      const ext = asset.path.split('.').pop()?.toLowerCase();
      const mimeTypes: Record<string, string> = {
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'ogg': 'audio/ogg',
        'm4a': 'audio/mp4',
        'aac': 'audio/aac',
      };
      return mimeTypes[ext!] || 'audio/mpeg';
    }
    return 'video/mp4';
  };
  const contentType = getContentType();

  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    let start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    // Clamp values to valid range (prevents crash if file size changed)
    if (start >= fileSize) {
      // Requested range is completely outside file - return 416
      res.writeHead(416, {
        'Content-Range': `bytes */${fileSize}`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end();
      return;
    }
    if (end >= fileSize) {
      end = fileSize - 1;
    }
    if (start > end) {
      start = end;
    }

    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });

    createReadStream(servePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(servePath).pipe(res);
  }
}

export const assetRoutes: SessionRoute[] = [
  { method: 'POST', action: 'assets', handler: handleAssetUpload },
  { method: 'GET', action: 'assets', handler: handleAssetList },
];
