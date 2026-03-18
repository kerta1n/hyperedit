import { copyFile, link, mkdir } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { parseSpecInput } from './spec.js';
import { buildRemotionHardwareOptions } from '../hardware-detection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');
const remotionEntry = resolve(projectRoot, 'src/remotion/index.tsx');

let cachedBundlePromise = null;
let bundledTransitionSet = '';

export function invalidateBundleCache() {
  cachedBundlePromise = null;
  bundledTransitionSet = '';
}

async function getBundleUrl(customTransitionIds = []) {
  const key = [...customTransitionIds].sort().join(',');
  if (key !== bundledTransitionSet) {
    cachedBundlePromise = null;
    bundledTransitionSet = key;
  }
  if (!cachedBundlePromise) {
    const hasCustom = customTransitionIds.length > 0;
    cachedBundlePromise = bundle({
      entryPoint: remotionEntry,
      webpackOverride: (config) => config,
      enableCaching: !hasCustom,
      onProgress: ({ progress }) => {
        if (progress === 1) {
          console.log('[Remotion] Bundle ready');
        }
      },
    });
  }

  return cachedBundlePromise;
}

/**
 * Copy session assets into the Remotion bundle directory so the bundle server
 * can serve them directly — avoids a proxy deadlock when the FFmpeg server is
 * blocked during renderMedia().
 *
 * ONLY called when custom transitions are present in the spec.
 */
async function copyAssetsToBundle(bundlePath, spec, assetPathMap) {
  if (!assetPathMap || assetPathMap.size === 0) return;

  for (const clip of spec.clips || []) {
    if (!clip.src) continue;
    // clip.src is a full URL like "http://localhost:3333/session/{id}/assets/{assetId}/stream"
    // Extract the path portion after the origin
    let urlPath;
    try {
      urlPath = new URL(clip.src).pathname; // e.g. "/session/{id}/assets/{assetId}/stream"
    } catch {
      // Not a valid URL — might already be a relative path
      urlPath = clip.src;
    }

    const match = urlPath.match(/\/assets\/([^/]+)\//);
    if (!match) continue;
    const assetId = match[1];
    const sourcePath = assetPathMap.get(assetId);
    if (!sourcePath) continue;

    // Construct destination inside the bundle directory using the URL path
    const destPath = join(bundlePath, urlPath);
    try {
      await mkdir(dirname(destPath), { recursive: true });
      try {
        await link(sourcePath, destPath);
      } catch {
        await copyFile(sourcePath, destPath);
      }
    } catch (err) {
      // Non-fatal: the render can still try the proxy approach
      console.warn(`[Remotion] Failed to copy asset ${assetId} to bundle: ${err.message}`);
    }
  }
}

function withDefaults(spec) {
  const { spec: parsedSpec } = parseSpecInput(spec || {}, {
    source: 'renderSpecWithRemotion',
  });

  return {
    ...parsedSpec,
    settings: {
      width: parsedSpec?.settings?.width || 1920,
      height: parsedSpec?.settings?.height || 1080,
      fps: parsedSpec?.settings?.fps || 30,
      backgroundColor: parsedSpec?.settings?.backgroundColor || '#000000',
    },
    clips: parsedSpec?.clips || [],
    captions: parsedSpec?.captions || [],
    voiceover: parsedSpec?.voiceover || [],
    tracks: parsedSpec?.tracks || [],
    transitions: parsedSpec?.transitions || [],
  };
}

export async function renderSpecWithRemotion({
  spec,
  outputPath,
  compositionId = 'ProjectTimeline',
  preview = false,
  codec,
  imageFormat = 'jpeg',
  logLevel = 'info',
  concurrency,
  assetPathMap,
  hardwareOptions,
}) {
  if (!spec) {
    throw new Error('spec is required for renderSpecWithRemotion');
  }

  if (!outputPath) {
    throw new Error('outputPath is required for renderSpecWithRemotion');
  }

  const normalizedSpec = withDefaults(spec);
  await mkdir(dirname(outputPath), { recursive: true });

  const customIds = (normalizedSpec.transitions || [])
    .filter(t => t.type === 'custom' && t.customTransitionId)
    .map(t => t.customTransitionId);

  const serveUrl = await getBundleUrl(customIds);

  // Only copy assets into the bundle when custom transitions are present.
  // This prevents a proxy deadlock where Remotion's compositor tries to fetch
  // assets from the FFmpeg server while it's blocked waiting for the render.
  // For normal renders (no custom transitions), the existing proxy approach works fine.
  if (assetPathMap) {
    await copyAssetsToBundle(serveUrl, normalizedSpec, assetPathMap);
  }

  const inputProps = { spec: normalizedSpec };

  const composition = await selectComposition({
    id: compositionId,
    serveUrl,
    inputProps,
  });

  const resolvedCodec = codec || 'h264';
  const hwOpts = buildRemotionHardwareOptions(hardwareOptions, preview);

  const renderOptions = {
    serveUrl,
    composition,
    codec: resolvedCodec,
    outputLocation: outputPath,
    inputProps,
    imageFormat,
    overwrite: true,
    logLevel,
    concurrency,
    audioCodec: 'aac',
    ...hwOpts,
  };

  try {
    await renderMedia(renderOptions);
  } catch (err) {
    // Compositor EPIPE or GPU-related crash — retry with software fallback
    console.warn(`[Remotion] Render failed (${err.code || err.message}), retrying with software fallback...`);
    const fallback = { ...renderOptions, crf: preview ? 30 : 20 };
    delete fallback.chromiumOptions;
    delete fallback.hardwareAcceleration;
    delete fallback.videoBitrate;
    await renderMedia(fallback);
  }

  return {
    outputPath,
    compositionId,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames,
  };
}

export async function renderDynamicAnimation({
  sceneData,
  outputPath,
  width = 1920,
  height = 1080,
  fps = 30,
  logLevel = 'info',
  onProgress,
  hardwareOptions,
}) {
  if (!sceneData || !sceneData.scenes) {
    throw new Error('sceneData with scenes array is required for renderDynamicAnimation');
  }

  if (!outputPath) {
    throw new Error('outputPath is required for renderDynamicAnimation');
  }

  await mkdir(dirname(outputPath), { recursive: true });

  const serveUrl = await getBundleUrl();
  const inputProps = sceneData;

  const composition = await selectComposition({
    id: 'DynamicAnimation',
    serveUrl,
    inputProps,
  });

  // Override composition settings with caller-specified values
  const finalComposition = {
    ...composition,
    width,
    height,
    fps,
  };

  const hwOpts = buildRemotionHardwareOptions(hardwareOptions, false);

  const renderOptions = {
    serveUrl,
    composition: finalComposition,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps,
    imageFormat: 'jpeg',
    overwrite: true,
    logLevel,
    audioCodec: 'aac',
    ...hwOpts,
  };

  if (onProgress) {
    renderOptions.onProgress = onProgress;
  }

  try {
    await renderMedia(renderOptions);
  } catch (err) {
    console.warn(`[Remotion] Render failed (${err.code || err.message}), retrying with software fallback...`);
    const fallback = { ...renderOptions, crf: 20 };
    delete fallback.chromiumOptions;
    delete fallback.hardwareAcceleration;
    delete fallback.videoBitrate;
    await renderMedia(fallback);
  }

  return {
    outputPath,
    compositionId: 'DynamicAnimation',
    width: finalComposition.width,
    height: finalComposition.height,
    fps: finalComposition.fps,
    durationInFrames: finalComposition.durationInFrames,
    durationInSeconds: finalComposition.durationInFrames / finalComposition.fps,
  };
}

export async function renderVariantBatch({
  variants,
  outDir,
  prefix = 'variant',
  preview = false,
  compositionId = 'ProjectTimeline',
  logLevel = 'info',
  hardwareOptions,
}) {
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error('variants must be a non-empty array');
  }

  const results = [];

  for (let i = 0; i < variants.length; i += 1) {
    const spec = variants[i];
    const outputPath = resolve(outDir, `${prefix}-${String(i + 1).padStart(2, '0')}.mp4`);
    const result = await renderSpecWithRemotion({
      spec,
      outputPath,
      compositionId,
      preview,
      logLevel,
      hardwareOptions,
    });
    results.push(result);
  }

  return results;
}
