import { link, copyFile, mkdir, rm } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { parseSpecInput } from './spec.js';
import { getRenderMediaOptions } from '../hwaccel-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');
const remotionEntry = resolve(projectRoot, 'src/remotion/index.tsx');

// ---- Directory layout ----
//
// IMPORTANT: Resolved lazily because this module is a static import — its body
// runs BEFORE local-ffmpeg-server.js calls loadEnvVars() to populate
// process.env from .dev.vars.
//
// Two directories, both on the same drive as session assets (D:):
//   bundleDir  — webpack bundle output + hard-linked session assets
//   tempDir    — Remotion's intermediate files (frame captures, pre-encode)
//
// The ramdisk (HYPEREDIT_TEMP_DIR) is NOT used here — Remotion's frame
// extraction and pre-encode can easily exceed ramdisk capacity with large
// source videos. Only Chrome cache/profiles go on the ramdisk (via hwaccel-config).

let _dirs = null;

function getDirs() {
  if (_dirs) return _dirs;

  // Put Remotion temp files next to the project (same drive as sessions)
  // so there's no space pressure from large video frame extractions
  const tempDir = join(projectRoot, '.remotion-temp');
  const bundleDir = join(projectRoot, '.remotion-bundles');

  for (const dir of [tempDir, bundleDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Override TMPDIR/TEMP/TMP so Remotion's internal temp file creation
  // (frame JPEGs, pre-encode MP4, etc.) goes to the project drive
  process.env.TMPDIR = tempDir;
  process.env.TEMP = tempDir;
  process.env.TMP = tempDir;

  console.log(`[Remotion] Temp directory: ${tempDir}`);
  console.log(`[Remotion] Bundle directory: ${bundleDir}`);

  _dirs = { tempDir, bundleDir };
  return _dirs;
}

let cachedBundlePromise = null;
let cachedBundlePath = null;
let bundledTransitionSet = '';

export function invalidateBundleCache() {
  const oldPath = cachedBundlePath;
  cachedBundlePromise = null;
  cachedBundlePath = null;
  bundledTransitionSet = '';

  // Clean up old bundle directory asynchronously
  if (oldPath) {
    rm(oldPath, { recursive: true, force: true }).catch((err) => {
      console.warn('[Remotion] Failed to clean up old bundle:', err.message);
    });
  }
}

async function getBundleUrl(customTransitionIds = []) {
  const key = [...customTransitionIds].sort().join(',');
  if (key !== bundledTransitionSet) {
    invalidateBundleCache();
    bundledTransitionSet = key;
  }
  if (!cachedBundlePromise) {
    const hasCustom = customTransitionIds.length > 0;
    cachedBundlePromise = bundle({
      entryPoint: remotionEntry,
      outDir: join(getDirs().bundleDir, `bundle-${Date.now()}`),
      webpackOverride: (config) => config,
      enableCaching: !hasCustom,
      onProgress: ({ progress }) => {
        if (progress === 1) {
          console.log('[Remotion] Bundle ready');
        }
      },
    }).then((bundlePath) => {
      cachedBundlePath = bundlePath;
      return bundlePath;
    });
  }

  return cachedBundlePromise;
}

/**
 * Hard-link (or copy) session assets into the Remotion bundle directory, then
 * rewrite clip src URLs to relative paths so the bundle server serves them.
 *
 * This is REQUIRED because the FFmpeg server is single-threaded — it blocks on
 * the renderMedia() call, so Remotion cannot fetch assets from localhost:3333.
 * The bundle dir lives on the same drive as session assets (D:), so hard links
 * are instant and use zero extra disk space.
 */
async function copyAssetsToBundle(bundlePath, spec, assetPathMap) {
  if (!assetPathMap || assetPathMap.size === 0) return;

  let copiedCount = 0;

  // Process both clips and voiceover entries — both have src URLs that
  // Remotion will try to download, causing deadlock if they point at :3333
  const allSrcEntries = [
    ...(spec.clips || []),
    ...(spec.voiceover || []),
  ];

  for (const clip of allSrcEntries) {
    if (!clip.src) continue;

    // clip.src is a full URL like "http://localhost:3333/session/{id}/assets/{assetId}/stream"
    let urlPath;
    try {
      urlPath = new URL(clip.src).pathname;
    } catch {
      urlPath = clip.src;
    }

    const match = urlPath.match(/\/assets\/([^/]+)\//);
    if (!match) continue;
    const assetId = match[1];
    const sourcePath = assetPathMap.get(assetId);
    if (!sourcePath) continue;

    // Build destination inside bundle — use the source file's extension so
    // Remotion's bundle server sets the correct Content-Type and the compositor
    // can identify the codec from the filename.
    const ext = sourcePath.match(/\.[^.]+$/)?.[0] || '.mp4';
    const segments = urlPath.split('/').filter(Boolean);
    // Replace the last segment (e.g. "stream") with "stream.mp4"
    segments[segments.length - 1] += ext;
    const destPath = join(bundlePath, ...segments);
    const rewrittenUrl = '/' + segments.join('/');

    try {
      await mkdir(dirname(destPath), { recursive: true });
      try {
        await link(sourcePath, destPath);
      } catch {
        await copyFile(sourcePath, destPath);
      }
      // Rewrite src to relative path — Remotion's bundle server serves it
      clip.src = rewrittenUrl;
      copiedCount++;
      console.log(`[Remotion] Asset ${assetId}: ${sourcePath} → ${destPath}`);
    } catch (err) {
      console.warn(`[Remotion] Failed to copy asset ${assetId}: ${err.message}`);
    }
  }

  if (copiedCount > 0) {
    console.log(`[Remotion] Copied ${copiedCount} assets into bundle, rewrote src to relative paths`);
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

  // Hard-link assets into the bundle so Remotion's bundle server serves them.
  // The FFmpeg server is blocked during renderMedia(), so Remotion can't fetch
  // from localhost:3333. Bundle is on the same drive → hard links are free.
  if (assetPathMap) {
    await copyAssetsToBundle(serveUrl, normalizedSpec, assetPathMap);
  }

  const inputProps = { spec: normalizedSpec };

  const composition = await selectComposition({
    id: compositionId,
    serveUrl,
    inputProps,
    timeoutInMilliseconds: 120000,
  });

  const resolvedCodec = codec || 'h264';

  // Build hardware-accelerated options (falls back to software if unavailable)
  let hwOptions = {};
  try {
    hwOptions = getRenderMediaOptions(preview);
    console.log(`[Remotion] HW accel config:`, JSON.stringify({
      hardwareAcceleration: hwOptions.hardwareAcceleration || 'disabled',
      videoBitrate: hwOptions.videoBitrate || 'N/A',
      crf: hwOptions.crf ?? 'N/A',
      gl: hwOptions.chromiumOptions?.gl || 'default',
      chromeMode: hwOptions.chromeMode || 'headless-shell',
      headless: hwOptions.chromiumOptions?.headless ?? true,
      concurrency: hwOptions.concurrency,
      offthreadVideoThreads: hwOptions.offthreadVideoThreads,
      offthreadVideoCacheMB: hwOptions.offthreadVideoCacheSizeInBytes
        ? Math.round(hwOptions.offthreadVideoCacheSizeInBytes / (1024 * 1024))
        : 'default',
      jpegQuality: hwOptions.jpegQuality || 'default',
    }));
  } catch (err) {
    console.warn('[Remotion] HW detection not ready, using software defaults:', err.message);
    hwOptions = { crf: preview ? 30 : 20 };
  }

  const renderOptions = {
    serveUrl,
    composition,
    codec: resolvedCodec,
    outputLocation: outputPath,
    inputProps,
    imageFormat,
    overwrite: true,
    logLevel,
    concurrency: concurrency ?? hwOptions.concurrency,
    audioCodec: 'aac',
    timeoutInMilliseconds: 120000,
    // Spread HW options (hardwareAcceleration, videoBitrate or crf, chromiumOptions, ffmpegOverride, x264Preset)
    ...hwOptions,
  };
  // Remove concurrency from hwOptions spread to prefer explicit param
  if (concurrency != null) renderOptions.concurrency = concurrency;

  await renderMedia(renderOptions);

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
    timeoutInMilliseconds: 120000,
  });

  // Override composition settings with caller-specified values
  const finalComposition = {
    ...composition,
    width,
    height,
    fps,
  };

  // Build hardware-accelerated options for dynamic animation renders
  let hwOptions = {};
  try {
    hwOptions = getRenderMediaOptions(false);
  } catch {
    hwOptions = { crf: 20 };
  }

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
    timeoutInMilliseconds: 120000,
    concurrency: hwOptions.concurrency,
    ...hwOptions,
  };

  if (onProgress) {
    renderOptions.onProgress = onProgress;
  }

  await renderMedia(renderOptions);

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
    });
    results.push(result);
  }

  return results;
}
