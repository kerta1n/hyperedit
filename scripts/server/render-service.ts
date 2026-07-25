import type { IncomingMessage, ServerResponse } from 'http';
import { createReadStream, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ensureProjectDefaults } from '../project-schema.js';
import { renderSpecInWorker, renderVariantBatchInWorker } from './render-client.ts';
import { scoreVariantBatch, writeCampaignReport } from '../remotion-core/ad-intelligence.js';
import { generateAdVariants, RemotionSpecValidationError } from '../remotion-core/spec.js';
import { parseBody, sendJSON, sendJobAccepted } from './http-helpers.ts';
import { requireSession, resolveCompositionSettings, saveAssetMetadata } from './session-store.ts';
import { generateThumbnail, runFFmpeg } from './ffmpeg-helpers.ts';
import { buildSessionRemotionSpec, parseIncomingRemotionSpec, saveSpecSnapshot, sendSpecValidationError } from './project-service.ts';
import type { SessionRoute } from './route-table.ts';
import { hasActiveJob, makeRenderProgressUpdater } from './job-store.ts';
import { enqueueJob } from './job-queue.ts';

// Remotion render lane + export-hub render management. The parameterized
// /renders/:stem/* handlers are exported for the entry's legacy dispatch
// (the flat route table has no params — the Hono slice absorbs them).
// Phase 3: every POST render route validates synchronously (400/422 stay
// immediate), then answers 202 { jobId } and runs on the job queue's render
// lane (global cap, owner-set 1). Progress/result/cancel live at
// /session/:id/jobs/:jobId — the request-scoped NDJSON stream is gone.

export const RENDER_STEM_RE = /^export-\d+$/;
export const RENDER_FILE_RE = /^export-\d+\.(mp4|webm|mkv|mov)$/;


async function handleRenderVariants(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const options = body ? JSON.parse(body) : {};

    const specResult = options.baseSpec
      ? parseIncomingRemotionSpec(options.baseSpec, `api:/session/${sessionId}/render-variants`)
      : {
        spec: buildSessionRemotionSpec(session, sessionId, {
          defaultCaptionPreset: options.defaultCaptionPreset,
        }),
        migration: { migrated: false, fromVersion: '2.0', toVersion: '2.0' },
        warnings: [],
      };

    const variants = generateAdVariants(specResult.spec, {
      count: options.count || 3,
      hooks: options.hooks,
      hookPool: options.hookPool,
      bodies: options.bodies,
      bodyPool: options.bodyPool,
      ctas: options.ctas,
      ctaPool: options.ctaPool,
      toneProfile: options.toneProfile,
      captionStyleProfile: options.captionStyleProfile,
    });

    const batchPrefix = options.prefix || 'ad-variant';

    // renderVariantBatch has no cancel seam — cancellation covers the queued
    // state only; an in-flight batch runs to completion, then settles canceled.
    const job = enqueueJob({
      sessionId,
      kind: 'render',
      lane: 'render',
      run: async (job) => {
        const results = await renderVariantBatchInWorker(job, {
          variants,
          outDir: session.rendersDir,
          prefix: batchPrefix,
          preview: options.preview === true,
          logLevel: 'warn',
        });

        const specPaths = variants.map((variant: unknown, index: number) => {
          const filename = `${batchPrefix}-${String(index + 1).padStart(2, '0')}.spec.json`;
          return saveSpecSnapshot(session, filename, variant);
        });

        let scoreReport = null;
        if (options.noScores !== true) {
          const report = scoreVariantBatch(variants, {
            batchLabel: options.campaignLabel || `session-${sessionId}-render-variants`,
          });

          scoreReport = await writeCampaignReport(session.rendersDir, report, {
            prefix: options.scoresPrefix || `${batchPrefix}-intelligence`,
          });
        }

        return {
          success: true,
          engine: 'remotion',
          count: results.length,
          renders: results,
          specPaths,
          migration: specResult.migration,
          warnings: specResult.warnings,
          scoreReport,
        };
      },
    });

    sendJobAccepted(res, sessionId, job);
  } catch (error: any) {
    if (error instanceof RemotionSpecValidationError) {
      sendSpecValidationError(res, error);
      return;
    }

    console.error(`[${sessionId}] Render variants failed:`, error.message);
    sendJSON(res, { error: error.message }, 500);
  }
}

async function handleRenderFromSpec(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const options = body ? JSON.parse(body) : {};

    if (!options.spec) {
      sendJSON(res, { error: 'spec is required' }, 400);
      return;
    }

    const specResult = parseIncomingRemotionSpec(options.spec, `api:/session/${sessionId}/render-from-spec`);
    const spec = specResult.spec;

    const preview = options.preview === true;
    const outputFilename = options.outputName
      ? options.outputName
      : preview
        ? 'preview.mp4'
        : `export-${Date.now()}.mp4`;
    const outputPath = join(session.rendersDir, outputFilename);

    const job = enqueueJob({
      sessionId,
      kind: 'render',
      lane: 'render',
      run: async (job) => {
        const renderInfo = await renderSpecInWorker(job, {
          spec,
          outputPath,
          preview,
          logLevel: 'warn',
          onProgress: makeRenderProgressUpdater(job),
        });

        const { stat } = await import('fs/promises');
        const outputStats = await stat(outputPath);
        saveSpecSnapshot(session, `${outputFilename.replace(/\.mp4$/, '')}.spec.json`, spec);

        return {
          success: true,
          engine: 'remotion',
          path: outputPath,
          size: outputStats.size,
          renderInfo,
          migration: specResult.migration,
          warnings: specResult.warnings,
          downloadUrl: `/session/${sessionId}/renders/${preview ? 'preview' : 'export'}`,
          duration: renderInfo.durationInFrames / (renderInfo.fps || 30),
        };
      },
    });

    sendJobAccepted(res, sessionId, job);
  } catch (error: any) {
    if (error instanceof RemotionSpecValidationError) {
      sendSpecValidationError(res, error);
      return;
    }

    console.error(`[${sessionId}] Render from spec failed:`, error.message);
    sendJSON(res, { error: error.message }, 500);
  }
}

// Render project to video with Remotion-first deterministic core
async function handleProjectRenderRemotion(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const options = body ? JSON.parse(body) : {};

    session.project = ensureProjectDefaults(session.project);

    const preview = options.preview === true;
    const renderOpts = options.renderOptions || {};
    const specResult = options.spec
      ? parseIncomingRemotionSpec(options.spec, `api:/session/${sessionId}/render`)
      : {
        spec: buildSessionRemotionSpec(session, sessionId, {
          title: options.title,
          brandTheme: options.brandTheme,
          adTemplate: options.adTemplate,
          defaultCaptionPreset: options.defaultCaptionPreset,
        }),
        migration: { migrated: false, fromVersion: '2.0', toVersion: '2.0' },
        warnings: [],
      };
    const spec = specResult.spec;

    // Guard both spec sources (client-supplied and server-built): an empty
    // timeline renders black frames with no audio, which is never intended.
    if ((spec.clips || []).length === 0) {
      sendJSON(res, { error: 'Timeline is empty — add at least one clip before rendering' }, 400);
      return;
    }

    // Derive file extension from renderOptions container format
    const containerExt = preview ? 'mp4' : (renderOpts.containerFormat || 'mp4');
    const outputFilename = preview
      ? 'preview.mp4'
      : `export-${Date.now()}.${containerExt}`;
    const outputPath = join(session.rendersDir, outputFilename);

    console.log(`\n[${sessionId}] === REMOTION ${preview ? 'PREVIEW' : 'EXPORT'} ===`);
    console.log(`[${sessionId}] Clips: ${spec.clips.length} | Captions: ${spec.captions.length}`);

    const job = enqueueJob({
      sessionId,
      kind: 'render',
      lane: 'render',
      run: async (job) => {
      const renderInfo = await renderSpecInWorker(job, {
        spec,
        outputPath,
        preview,
        logLevel: 'warn',
        renderOptions: renderOpts,
        onProgress: makeRenderProgressUpdater(job),
      });

      const { stat } = await import('fs/promises');
      const outputStats = await stat(outputPath);

      const renderDuration = renderInfo.durationInFrames / (renderInfo.fps || 30);
      if (!preview) {
        const thumbFilename = `${outputFilename.replace(/\.[^.]+$/, '')}_thumb.jpg`;
        const thumbPath = join(session.rendersDir, thumbFilename);
        try {
          await generateThumbnail(outputPath, thumbPath, false);
        } catch (thumbErr: any) {
          console.warn(`[${sessionId}] Render thumbnail failed:`, thumbErr.message);
        }
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const defaultTitle = `Render-${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
        spec._renderMeta = {
          title: defaultTitle,
          fileSize: outputStats.size,
          duration: renderDuration,
          codec: renderOpts.codec || 'h264',
          containerFormat: renderOpts.containerFormat || 'mp4',
          renderedAt: Date.now(),
          filename: outputFilename,
          thumbFilename: existsSync(thumbPath) ? thumbFilename : null,
        };
      }

      const specSnapshotPath = saveSpecSnapshot(session, `${outputFilename.replace(/\.[^.]+$/, '')}.spec.json`, spec);

      return {
        success: true,
        engine: 'remotion',
        path: outputPath,
        size: outputStats.size,
        duration: renderDuration,
        renderInfo,
        specPath: specSnapshotPath,
        migration: specResult.migration,
        warnings: specResult.warnings,
        downloadUrl: `/session/${sessionId}/renders/${preview ? 'preview' : 'export'}`,
      };
      },
    });

    sendJobAccepted(res, sessionId, job);
  } catch (error: any) {
    if (error instanceof RemotionSpecValidationError) {
      sendSpecValidationError(res, error);
      return;
    }

    console.error(`[${sessionId}] Remotion render error:`, error.message);
    sendJSON(res, { error: error.message }, 500);
  }
}

// Download rendered video
export async function handleRenderDownload(req: IncomingMessage, res: ServerResponse, sessionId: string, renderType: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  // Find the render file
  const files = readdirSync(session.rendersDir);

  let renderFile;
  if (renderType === 'preview') {
    renderFile = files.find(f => f === 'preview.mp4');
  } else {
    // Get most recent export (any video extension, not just .mp4)
    const videoExtensions = /\.(mp4|webm|mkv|mov)$/;
    renderFile = files
      .filter(f => f.startsWith('export-') && videoExtensions.test(f) && !f.endsWith('.spec.json'))
      .sort()
      .pop();
  }

  if (!renderFile) {
    sendJSON(res, { error: 'Render not found' }, 404);
    return;
  }

  const renderPath = join(session.rendersDir, renderFile);
  const { stat } = await import('fs/promises');
  const stats = await stat(renderPath);

  // Derive content type from extension
  const extToMime: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime' };
  const ext = renderFile.substring(renderFile.lastIndexOf('.'));
  const mime = extToMime[ext] || 'application/octet-stream';
  const filename = renderType === 'preview' ? 'preview.mp4' : `${session.originalName.replace(/\.[^.]+$/, '')}-export${ext}`;

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stats.size,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Access-Control-Allow-Origin': '*',
  });

  createReadStream(renderPath).pipe(res);
}

// ============== RENDER MANAGEMENT (Export Hub) ==============

export async function handleListRenders(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;
  const { readdir, stat } = await import('fs/promises');
  const videoExt = /\.(mp4|webm|mkv|mov)$/;
  let files;
  try { files = await readdir(session.rendersDir); } catch { files = []; }

  const videoFiles = files.filter(f => f.startsWith('export-') && videoExt.test(f));

  const renders = await Promise.all(videoFiles.map(async (filename) => {
    const videoPath = join(session.rendersDir, filename);
    const stem = filename.replace(/\.[^.]+$/, '');
    const specPath = join(session.rendersDir, `${stem}.spec.json`);
    let spec: any = null;
    try { spec = JSON.parse(readFileSync(specPath, 'utf-8')); } catch {}

    const meta = spec?._renderMeta || {};
    let fileSize = meta.fileSize;
    if (!fileSize) {
      try { fileSize = (await stat(videoPath)).size; } catch { fileSize = 0; }
    }

    return {
      id: stem,
      filename,
      title: meta.title || spec?.title || stem,
      createdAt: meta.renderedAt || null,
      fileSize,
      duration: meta.duration || null,
      codec: meta.codec || null,
      containerFormat: meta.containerFormat || null,
      thumbnailUrl: meta.thumbFilename
        ? `/session/${sessionId}/renders/${encodeURIComponent(stem)}/thumbnail`
        : null,
      downloadUrl: `/session/${sessionId}/renders/${encodeURIComponent(filename)}/download`,
    };
  }));

  renders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  sendJSON(res, { renders });
}

export async function handleDeleteRender(req: IncomingMessage, res: ServerResponse, sessionId: string, stem: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;
  if (hasActiveJob(sessionId, 'render')) {
    sendJSON(res, { error: 'Render in progress' }, 409);
    return;
  }
  const { readdir } = await import('fs/promises');
  const videoExt = /\.(mp4|webm|mkv|mov)$/;
  let files;
  try { files = await readdir(session.rendersDir); } catch { files = []; }

  const videoFile = files.find(f => f.replace(/\.[^.]+$/, '') === stem && videoExt.test(f));
  if (!videoFile) {
    sendJSON(res, { error: 'Render not found' }, 404);
    return;
  }
  const toDelete = [
    join(session.rendersDir, videoFile),
    join(session.rendersDir, `${stem}.spec.json`),
    join(session.rendersDir, `${stem}_thumb.jpg`),
  ];
  for (const p of toDelete) { try { unlinkSync(p); } catch {} }

  sendJSON(res, { success: true });
}

export async function handleRenameRender(req: IncomingMessage, res: ServerResponse, sessionId: string, stem: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;
  let body = '';
  for await (const chunk of req) body += chunk;
  const { title } = body ? JSON.parse(body) : {};
  if (!title || !title.trim()) {
    sendJSON(res, { error: 'title is required' }, 400);
    return;
  }
  const specPath = join(session.rendersDir, `${stem}.spec.json`);
  if (!existsSync(specPath)) {
    sendJSON(res, { error: 'Spec file not found' }, 404);
    return;
  }
  let spec: any = {};
  try { spec = JSON.parse(readFileSync(specPath, 'utf-8')); } catch {}

  spec.title = title.trim();
  if (spec._renderMeta) spec._renderMeta.title = title.trim();
  writeFileSync(specPath, JSON.stringify(spec, null, 2));

  sendJSON(res, { success: true, title: spec.title });
}

export async function handleRenderThumbnail(req: IncomingMessage, res: ServerResponse, sessionId: string, stem: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;
  const thumbPath = join(session.rendersDir, `${stem}_thumb.jpg`);
  if (!existsSync(thumbPath)) {
    sendJSON(res, { error: 'Thumbnail not found' }, 404);
    return;
  }
  const { stat } = await import('fs/promises');
  const stats = await stat(thumbPath);
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': stats.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
  });
  createReadStream(thumbPath).pipe(res);
}

export async function handleRenderFileDownload(req: IncomingMessage, res: ServerResponse, sessionId: string, filename: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;
  const renderPath = join(session.rendersDir, filename);
  if (!existsSync(renderPath)) {
    sendJSON(res, { error: 'File not found' }, 404);
    return;
  }
  const { stat } = await import('fs/promises');
  const stats = await stat(renderPath);
  const ext = filename.substring(filename.lastIndexOf('.'));
  const stem = filename.replace(/\.[^.]+$/, '');
  const specPath = join(session.rendersDir, `${stem}.spec.json`);
  let displayName = `${session.originalName.replace(/\.[^.]+$/, '')}-export${ext}`;
  try {
    const spec = JSON.parse(readFileSync(specPath, 'utf-8'));
    const title = spec?._renderMeta?.title || spec?.title;
    if (title) displayName = `${title}${ext}`;
  } catch {}
  const extToMime: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime' };
  res.writeHead(200, {
    'Content-Type': extToMime[ext] || 'application/octet-stream',
    'Content-Length': stats.size,
    'Content-Disposition': `attachment; filename="${displayName}"`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Disposition',
  });
  createReadStream(renderPath).pipe(res);
}

// NOTE: This is a placeholder that creates a simple text overlay video using FFmpeg
// For proper Remotion rendering, you'd need to set up @remotion/renderer with bundling
async function handleRenderMotionGraphic(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    const body = await parseBody(req);
    const { templateId, props, duration } = body;
    const { fps, width, height } = resolveCompositionSettings(session, body);

    const assetId = randomUUID();
    const outputPath = join(session.assetsDir, `${assetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);

    // Fast ffmpeg job (seconds) — shares the render lane; no in-flight cancel.
    const job = enqueueJob({
      sessionId,
      kind: 'render',
      lane: 'render',
      run: async (job) => {
        const jobId = job.id;

        console.log(`\n[${jobId}] === RENDER MOTION GRAPHIC ===`);
        console.log(`[${jobId}] Template: ${templateId}`);
        console.log(`[${jobId}] Duration: ${duration}s`);

        // Get text and styling from props
        const text = props.text || props.name || templateId;
        const color = (props.color || props.primaryColor || '#ffffff').replace('#', '');
        const bgColor = props.backgroundColor || '000000';
        const fontSize = props.fontSize || 64;

        // Create a video with text overlay using FFmpeg
        // This is a placeholder - proper Remotion rendering would generate much nicer animations
        const fontFile = '/System/Library/Fonts/Helvetica.ttc'; // macOS system font

        // FFmpeg command to create a video with text
        const ffmpegArgs = [
          '-y',
          '-f', 'lavfi',
          '-i', `color=c=0x${bgColor}:s=${width}x${height}:d=${duration}:r=${fps}`,
          '-vf', `drawtext=text='${text.replace(/'/g, "\\'")}':fontfile=${fontFile}:fontsize=${fontSize}:fontcolor=0x${color}:x=(w-text_w)/2:y=(h-text_h)/2`,
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-preset', 'fast',
          outputPath
        ];

        await runFFmpeg(ffmpegArgs, jobId);

        // Generate thumbnail
        await runFFmpeg([
          '-y', '-i', outputPath,
          '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
          '-frames:v', '1',
          thumbPath
        ], jobId);

        const { stat } = await import('fs/promises');
        const stats = await stat(outputPath);

        // Create asset entry
        const asset = {
          id: assetId,
          type: 'video',
          filename: `motion-${templateId}-${Date.now()}.mp4`,
          path: outputPath,
          thumbPath: existsSync(thumbPath) ? thumbPath : null,
          duration: duration,
          size: stats.size,
          width,
          height,
          fps,
          createdAt: Date.now(),
          // Metadata
          templateId,
          props,
        };

        session.assets.set(assetId, asset);
        saveAssetMetadata(session); // Persist asset metadata to disk

        console.log(`[${jobId}] Motion graphic rendered: ${assetId}`);
        console.log(`[${jobId}] === RENDER COMPLETE ===\n`);

        return {
          success: true,
          assetId,
          filename: asset.filename,
          duration,
          thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
          streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
        };
      },
    });

    sendJobAccepted(res, sessionId, job);

  } catch (error: any) {
    console.error('Motion graphic render error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}

export const renderRoutes: SessionRoute[] = [
  { method: 'POST', action: 'render', handler: handleProjectRenderRemotion },
  { method: 'POST', action: 'render-from-spec', handler: handleRenderFromSpec },
  { method: 'POST', action: 'render-variants', handler: handleRenderVariants },
  { method: 'POST', action: 'render-motion-graphic', handler: handleRenderMotionGraphic },
  { method: 'GET', action: 'renders', handler: handleListRenders },
];
