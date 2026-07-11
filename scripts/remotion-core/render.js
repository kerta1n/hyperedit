import { link, copyFile, mkdir, rm } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import { bundle } from '@remotion/bundler';
import { parseSpecInput } from './spec.js';
import { getRenderMediaOptions } from '../hwaccel-config.js';
import { ensureNvencBinariesDir } from './render-binaries-helpers.js';
import { installDownloadShim, registerLocalRenderAssets } from './render-download-helpers.js';

// CJS build deliberately (not `import`): the Windows NVENC path patches
// Remotion's internal audio-codec module (see render-binaries-helpers.js),
// which is only reachable through the CJS module registry — the ESM entry
// is a single pre-bundled, immutable file.
const require = createRequire(import.meta.url);
const { openBrowser, renderMedia, selectComposition } = require('@remotion/renderer');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');
const remotionEntry = resolve(projectRoot, 'src/remotion/index.tsx');

function makeProgressLogger(totalFrames, onProgressCallback) {
  const start = Date.now();
  return ({ renderedFrames, progress }) => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = String(elapsed % 60).padStart(2, '0');
    const pct = Math.round(progress * 100);
    process.stdout.write(
      `\r[Remotion] Rendering: ${pct}% (${renderedFrames}/${totalFrames} frames) [${min}:${sec} elapsed]`
    );
    if (progress === 1) process.stdout.write('\n');
    if (onProgressCallback) {
      onProgressCallback({ pct, renderedFrames, totalFrames, elapsed });
    }
  };
}

// ---- Directory layout ----
//
// IMPORTANT: Resolved lazily because this module is a static import — its body
// runs BEFORE local-ffmpeg-server.js calls loadEnvVars() to populate
// process.env from .dev.vars.
//
// HYPEREDIT_OUTPUT (env var, default: {projectRoot}/.output):
//   {HYPEREDIT_OUTPUT}/cache/bundles — webpack bundle output + hard-linked session assets
//   {HYPEREDIT_OUTPUT}/cache/temp    — Remotion's intermediate files (frame captures, pre-encode)
//
// Must be on the same drive as HYPEREDIT_SESSIONS_DIR so hard links work.
// Chrome profiles go on the ramdisk (HYPEREDIT_TEMP_DIR) via the TEMP swap in getBrowser().

let _dirs = null;

function getDirs() {
  if (_dirs) return _dirs;

  // Every render path passes through here — make sure session-asset URLs are
  // hard-linked instead of downloaded (animation renders never register a map)
  installDownloadShim();

  const outputRoot = process.env.HYPEREDIT_OUTPUT || join(projectRoot, '.output');
  const tempDir = join(outputRoot, 'cache', 'temp');
  const bundleDir = join(outputRoot, 'cache', 'bundles');

  for (const dir of [tempDir, bundleDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Override TMPDIR/TEMP/TMP so Remotion's internal temp file creation
  // (frame JPEGs, pre-encode MP4, etc.) goes to the output drive
  process.env.TMPDIR = tempDir;
  process.env.TEMP = tempDir;
  process.env.TMP = tempDir;

  const ramdisk = process.env.HYPEREDIT_TEMP_DIR;
  console.log(`[Remotion] Output root: ${outputRoot}`);
  console.log(`[Remotion] Temp directory: ${tempDir}`);
  console.log(`[Remotion] Bundle directory: ${bundleDir}`);
  console.log(`[Remotion] Chrome profile: ${ramdisk || tempDir}`);

  _dirs = { outputRoot, tempDir, bundleDir };
  return _dirs;
}

// Renders must run one at a time: two concurrent renderMedia calls sharing this
// module's cached browser crash the Rust compositor with an out-of-memory abort
// (verified with two parallel 5s renders). Frame capture is CPU-bound, so
// serializing loses no throughput. The chain swallows failures so one failed
// render never blocks the next.
let renderQueue = Promise.resolve();

function serializeRender(fn) {
  const run = renderQueue.then(fn, fn);
  renderQueue = run.catch(() => {});
  return run;
}

// Windows NVENC: Remotion's bundled FFmpeg lacks NVENC, so hardware-accelerated
// renders must spawn from a merged binaries dir (system FFmpeg + compositor).
// macOS/Linux use the bundled binaries as-is. Mutates and returns the options.
function withHwBinaries(opts) {
  if (opts.hardwareAcceleration && process.platform === 'win32') {
    const binDir = ensureNvencBinariesDir(getDirs().outputRoot);
    if (binDir) {
      opts.binariesDirectory = binDir;
    } else {
      // No NVENC-capable FFmpeg to spawn — probing the bundled one is pointless.
      // Restore the fast preset so the software fallback doesn't run at
      // ffmpeg's slower default (medium).
      delete opts.hardwareAcceleration;
      if (!opts.x264Preset && opts.codec === 'h264') {
        opts.x264Preset = 'fast';
      }
    }
  }
  return opts;
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
  // The bundle dir can be deleted underneath a running server (disk cleanup) —
  // a memoized path would then serve renders from nothing until restart, the
  // same staleness class as the binaries-dir memo. Revalidate before reuse.
  if (cachedBundlePath && !existsSync(cachedBundlePath)) {
    console.warn('[Remotion] Cached bundle is gone from disk — rebundling');
    cachedBundlePromise = null;
    cachedBundlePath = null;
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

// ---- Cached browser instance ----
//
// Reuse a single Chrome instance across renders. The TEMP env var is swapped to
// HYPEREDIT_TEMP_DIR (ramdisk) before openBrowser() so Chrome's user-data profile
// lands on fast storage. After launch, TEMP is restored to the output cache/temp
// dir so Remotion's frame captures (which can be gigabytes) go to the project drive.

let cachedBrowserPromise = null;
let cachedBrowserInstance = null;
let browserConfigKey = '';

export function invalidateBrowserCache() {
  const old = cachedBrowserInstance;
  cachedBrowserPromise = null;
  cachedBrowserInstance = null;
  browserConfigKey = '';
  if (old) old.close({ silent: true }).catch(() => {});
}

function getBrowserConfigKey(hw) {
  return JSON.stringify({
    chromeMode: hw.chromeMode,
    gl: hw.chromiumOptions?.gl,
    headless: hw.chromiumOptions?.headless,
  });
}

// A cached browser whose Chrome process died (crash, external kill, GPU reset)
// leaves a resolved promise wrapping a dead CDP socket — selectComposition then
// hangs FOREVER (no timeout covers a dead socket; verified by killing Chrome
// between renders). Probe liveness before reuse with a real CDP roundtrip —
// browser.pages() is NOT sufficient, it resolves from locally cached targets.
async function isBrowserAlive(browser) {
  try {
    await Promise.race([
      browser.connection.send('Browser.getVersion'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('browser liveness probe timed out')), 3000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function getBrowser(hwOptions) {
  const key = getBrowserConfigKey(hwOptions);
  if (key !== browserConfigKey) {
    invalidateBrowserCache();
    browserConfigKey = key;
  }
  if (cachedBrowserInstance && !(await isBrowserAlive(cachedBrowserInstance))) {
    console.warn('[Remotion] Cached browser is dead — relaunching');
    invalidateBrowserCache();
    browserConfigKey = key;
  }
  if (!cachedBrowserPromise) {
    cachedBrowserPromise = (async () => {
      const { tempDir } = getDirs();
      const ramdisk = process.env.HYPEREDIT_TEMP_DIR;

      // Swap TEMP to ramdisk so Chrome profile lands there (small, ephemeral)
      if (ramdisk) {
        process.env.TMPDIR = ramdisk;
        process.env.TEMP = ramdisk;
        process.env.TMP = ramdisk;
      }

      try {
        const browser = await openBrowser('chrome', {
          chromiumOptions: hwOptions.chromiumOptions || {},
          chromeMode: hwOptions.chromeMode || 'headless-shell',
          logLevel: 'warn',
        });
        cachedBrowserInstance = browser;
        console.log(`[Remotion] Browser opened (profile on ${ramdisk || tempDir})`);
        return browser;
      } finally {
        // Restore TEMP so frame captures go to cache/temp (large files, not ramdisk)
        process.env.TMPDIR = tempDir;
        process.env.TEMP = tempDir;
        process.env.TMP = tempDir;
      }
    })();
  }
  return cachedBrowserPromise;
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

export function renderSpecWithRemotion(args) {
  return serializeRender(() => renderSpecInner(args));
}

async function renderSpecInner({
  spec,
  outputPath,
  compositionId = 'ProjectTimeline',
  preview = false,
  codec,
  imageFormat = 'jpeg',
  logLevel = 'info',
  concurrency,
  assetPathMap,
  renderOptions: userRenderOptions,
  onProgress,
}) {
  if (!spec) {
    throw new Error('spec is required for renderSpecWithRemotion');
  }

  if (!outputPath) {
    throw new Error('outputPath is required for renderSpecWithRemotion');
  }

  const normalizedSpec = withDefaults(spec);

  // Apply fps override BEFORE selectComposition so calculateMetadata in the
  // Remotion composition sees the correct fps and computes durationInFrames
  // accordingly. Overriding after selectComposition truncates the video.
  if (userRenderOptions?.outputFps) {
    normalizedSpec.settings.fps = userRenderOptions.outputFps;
  }

  await mkdir(dirname(outputPath), { recursive: true });

  const customIds = (normalizedSpec.transitions || [])
    .filter(t => t.type === 'custom' && t.customTransitionId)
    .map(t => t.customTransitionId);

  const serveUrl = await getBundleUrl(customIds);

  // Hard-link assets into the bundle so Remotion's bundle server serves them.
  // The FFmpeg server is blocked during renderMedia(), so Remotion can't fetch
  // from localhost:3333. Bundle is on the same drive → hard links are free.
  // Also register them with the download shim so Remotion's download-map gets
  // hard links instead of multi-GB HTTP copies (see render-download-helpers).
  if (assetPathMap) {
    registerLocalRenderAssets(assetPathMap);
    await copyAssetsToBundle(serveUrl, normalizedSpec, assetPathMap);
  }

  const inputProps = { spec: normalizedSpec };

  // Resolve final codec: explicit param → user renderOptions → default
  const resolvedCodec = codec || userRenderOptions?.codec || 'h264';

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

  // Reuse cached browser (Chrome profile on ramdisk, frames on output drive)
  const browser = await getBrowser(hwOptions);

  const composition = await selectComposition({
    id: compositionId,
    serveUrl,
    inputProps,
    timeoutInMilliseconds: 120000,
    puppeteerInstance: browser,
  });

  // Override composition dimensions from user renderOptions if provided.
  // fps is already applied to normalizedSpec above, so calculateMetadata
  // has already computed the correct durationInFrames — no post-hoc override.
  const finalComposition = { ...composition };
  if (userRenderOptions) {
    if (userRenderOptions.outputWidth && userRenderOptions.outputHeight) {
      finalComposition.width = userRenderOptions.outputWidth;
      finalComposition.height = userRenderOptions.outputHeight;
    }
  }

  const renderOpts = {
    serveUrl,
    composition: finalComposition,
    codec: resolvedCodec,
    outputLocation: outputPath,
    inputProps,
    imageFormat,
    overwrite: true,
    logLevel,
    concurrency: concurrency ?? hwOptions.concurrency,
    audioCodec: 'aac',
    timeoutInMilliseconds: 120000,
    puppeteerInstance: browser,
    // Spread HW options (hardwareAcceleration, videoBitrate or crf, chromiumOptions, ffmpegOverride, x264Preset)
    ...hwOptions,
  };
  // Remove concurrency from hwOptions spread to prefer explicit param
  if (concurrency != null) renderOpts.concurrency = concurrency;
  // Ensure puppeteerInstance isn't overwritten by hwOptions spread
  renderOpts.puppeteerInstance = browser;

  // ── Apply user renderOptions overrides (take precedence over hwOptions) ──
  if (userRenderOptions && typeof userRenderOptions === 'object') {
    console.log('[Remotion] Applying user render options:', JSON.stringify(userRenderOptions));

    // Quality mode: CRF vs Bitrate (mutually exclusive in Remotion)
    if (userRenderOptions.qualityMode === 'bitrate' && userRenderOptions.videoBitrate) {
      renderOpts.videoBitrate = userRenderOptions.videoBitrate;
      delete renderOpts.crf;
    } else if (userRenderOptions.crf != null) {
      renderOpts.crf = userRenderOptions.crf;
      delete renderOpts.videoBitrate;
    }

    // Audio codec
    if (userRenderOptions.audioCodec) {
      renderOpts.audioCodec = userRenderOptions.audioCodec;
    }

    // Audio bitrate
    if (userRenderOptions.audioBitrate) {
      renderOpts.audioBitrate = userRenderOptions.audioBitrate;
    }

    // Mute audio
    if (userRenderOptions.muted === true) {
      renderOpts.muted = true;
    }

    // Hardware acceleration — CRF is incompatible with Remotion HW accel,
    // so force-disable to avoid noisy fallback warning
    if (userRenderOptions.qualityMode === 'crf') {
      delete renderOpts.hardwareAcceleration;
    } else if (userRenderOptions.hardwareAcceleration) {
      renderOpts.hardwareAcceleration = userRenderOptions.hardwareAcceleration;
    }

    // Encoder speed (x264 preset) — x264-only concept. NVENC merely aliases
    // fast/medium/slow and ERRORS on the rest (ultrafast, placebo, ...), so
    // never pass it alongside hardware acceleration.
    if (userRenderOptions.x264Preset && !renderOpts.hardwareAcceleration) {
      renderOpts.x264Preset = userRenderOptions.x264Preset;
    }

    // ProRes profile
    if (resolvedCodec === 'prores' && userRenderOptions.proResProfile) {
      renderOpts.proResProfileName = userRenderOptions.proResProfile;
    }

    // Concurrency (parallel Chrome instances)
    if (userRenderOptions.concurrency && userRenderOptions.concurrency > 0) {
      renderOpts.concurrency = userRenderOptions.concurrency;
    }

    // Render scale
    if (userRenderOptions.scale && userRenderOptions.scale !== 1) {
      renderOpts.scale = userRenderOptions.scale;
    }

    // Pixel format
    if (userRenderOptions.pixelFormat) {
      renderOpts.pixelFormat = userRenderOptions.pixelFormat;
    }

    // Custom FFmpeg flags (appended via ffmpegOverride callback)
    if (userRenderOptions.enableCustomFfmpegFlags && userRenderOptions.customFfmpegFlags) {
      const customFlags = userRenderOptions.customFfmpegFlags.trim().split(/\s+/);
      const existingOverride = renderOpts.ffmpegOverride;
      renderOpts.ffmpegOverride = ({ args, type }) => {
        // Apply any existing hwaccel ffmpeg overrides first
        let result = existingOverride ? existingOverride({ args, type }) : args;
        // Then append user's custom flags (only to the final encoding pass)
        if (type === 'stitcher') {
          result = [...result, ...customFlags];
        }
        return result;
      };
    }

    // Sample rate — not a direct Remotion param, inject via ffmpegOverride -ar flag
    if (userRenderOptions.sampleRate && userRenderOptions.sampleRate !== 48000) {
      const existingOverride = renderOpts.ffmpegOverride;
      renderOpts.ffmpegOverride = ({ args, type }) => {
        let result = existingOverride ? existingOverride({ args, type }) : args;
        if (type === 'stitcher') {
          result = [...result, '-ar', String(userRenderOptions.sampleRate)];
        }
        return result;
      };
    }
  }

  // x264Preset is only valid with the h264 codec — Remotion throws otherwise.
  // Both the software hwOptions branch and the modal set it unconditionally,
  // which silently broke every non-h264 software render (vp9/av1/prores/h265).
  if (resolvedCodec !== 'h264') {
    delete renderOpts.x264Preset;
  }

  // After user overrides so a user-forced hardwareAcceleration also gets binaries
  withHwBinaries(renderOpts);

  renderOpts.onProgress = makeProgressLogger(finalComposition.durationInFrames, onProgress);

  await renderMedia(renderOpts);

  return {
    outputPath,
    compositionId,
    width: finalComposition.width,
    height: finalComposition.height,
    fps: finalComposition.fps,
    durationInFrames: finalComposition.durationInFrames,
  };
}

export function renderDynamicAnimation(args) {
  return serializeRender(() => renderDynamicAnimationInner(args));
}

async function renderDynamicAnimationInner({
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

  // Build hardware-accelerated options for dynamic animation renders
  let hwOptions = {};
  try {
    hwOptions = getRenderMediaOptions(false);
  } catch {
    hwOptions = { crf: 20 };
  }

  // Reuse cached browser (Chrome profile on ramdisk, frames on output drive)
  const browser = await getBrowser(hwOptions);

  const composition = await selectComposition({
    id: 'DynamicAnimation',
    serveUrl,
    inputProps,
    timeoutInMilliseconds: 120000,
    puppeteerInstance: browser,
  });

  // Override composition settings with caller-specified values
  const finalComposition = {
    ...composition,
    width,
    height,
    fps,
  };

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
    puppeteerInstance: browser,
    ...hwOptions,
  };
  // Ensure puppeteerInstance isn't overwritten by hwOptions spread
  renderOptions.puppeteerInstance = browser;

  withHwBinaries(renderOptions);

  renderOptions.onProgress = makeProgressLogger(finalComposition.durationInFrames, onProgress);

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
