/**
 * hwaccel-config.js — Translates HW capabilities + env var toggles into
 * concrete option objects for Remotion renderMedia() and raw FFmpeg calls.
 *
 * Environment variable toggles (set in .dev.vars):
 *
 *   HWACCEL_REMOTION=true|false          (default: true)
 *     Enable Remotion hardware-accelerated encoding. Only effective on macOS
 *     (VideoToolbox). Uses videoBitrate instead of CRF when active.
 *     On Windows/Linux, Remotion's bundled FFmpeg lacks GPU encoders, so this
 *     controls rendering-phase optimizations (concurrency, offthread threads, GL).
 *
 *   HWACCEL_FFMPEG=true|false            (default: true)
 *     Enable GPU encoder for direct FFmpeg spawn() calls (dead air removal, etc.).
 *     Uses the SYSTEM FFmpeg which has NVENC/VAAPI/QSV/AMF support.
 *
 *   HWACCEL_HEADFUL=true|false           (default: auto — true on Win/macOS, false on Linux)
 *     Use headful (visible) browser for rendering instead of headless shell.
 *     Headful mode uses real GPU drivers for faster CSS/WebGL rendering.
 *     Requires a display server (always available on Windows/macOS).
 */

import { getCapabilities, pickGlBackend } from './hw-detect.js';

// --------------- env helpers ---------------

function envBool(key, fallback = true) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

// --------------- encoder arg helpers ---------------

/** Per-encoder preset/quality flags for direct FFmpeg calls. */
const ENCODER_ARGS = {
  h264_nvenc: {
    preview: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', '6M'],
    final: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-b:v', '10M'],
    max: ['-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-b:v', '20M'],
  },
  h264_amf: {
    preview: ['-c:v', 'h264_amf', '-quality', 'speed', '-b:v', '6M'],
    final: ['-c:v', 'h264_amf', '-quality', 'balanced', '-b:v', '10M'],
    max: ['-c:v', 'h264_amf', '-quality', 'quality', '-b:v', '20M'],
  },
  h264_qsv: {
    preview: ['-c:v', 'h264_qsv', '-preset', 'faster', '-b:v', '6M'],
    final: ['-c:v', 'h264_qsv', '-preset', 'medium', '-b:v', '10M'],
    max: ['-c:v', 'h264_qsv', '-preset', 'slow', '-b:v', '20M'],
  },
  h264_vaapi: {
    preview: ['-c:v', 'h264_vaapi', '-b:v', '6M'],
    final: ['-c:v', 'h264_vaapi', '-b:v', '10M'],
    max: ['-c:v', 'h264_vaapi', '-b:v', '20M'],
  },
  h264_videotoolbox: {
    preview: ['-c:v', 'h264_videotoolbox', '-b:v', '6M'],
    final: ['-c:v', 'h264_videotoolbox', '-b:v', '10M'],
    max: ['-c:v', 'h264_videotoolbox', '-b:v', '20M'],
  },
};

const SOFTWARE_ARGS = {
  preview: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18'],
  final: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20'],
  max: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'],
};

// --------------- public API ---------------

/**
 * Build renderMedia() option overrides for Remotion.
 *
 * @param {boolean} isPreview - true for preview renders (faster, lower quality)
 * @returns {object} — spread into the renderMedia() options object
 */
export function getRenderMediaOptions(isPreview = false) {
  const caps = getCapabilities();
  const useRemotionHW = envBool('HWACCEL_REMOTION');
  const encoder = caps.preferredEncoder;

  const userConcurrency = caps.concurrency;

  const result = {};

  // Headful rendering — resolve this first so GL backend selection can use it
  // Default: true on Windows/macOS (always have a display), false on Linux
  const headfulDefault = caps.platform !== 'linux';
  const useHeadful = envBool('HWACCEL_HEADFUL', headfulDefault);

  // GL backend depends on OS + GPU presence + headful mode.
  // Resolved at render time (not cached) because HWACCEL_HEADFUL is an env toggle.
  const gl = pickGlBackend(caps.platform, caps.gpuName, useHeadful);
  if (gl) {
    result.chromiumOptions = { gl };
  }

  if (useHeadful) {
    // chrome-for-testing = full Chrome with GPU, visible window
    // headless-shell = stripped headless binary, no real GPU
    result.chromeMode = 'chrome-for-testing';
    if (!result.chromiumOptions) result.chromiumOptions = {};
    result.chromiumOptions.headless = false;
  }

  // Always cap concurrency to prevent thundering herd at frame 0.
  // Remotion's auto-detect (50% of CPU cores) is too aggressive for the single
  // Node.js event loop that also serves the bundle/proxy HTTP server.
  // REMOTION_CONCURRENCY env var overrides this default.
  result.concurrency = userConcurrency;

  // ---- RENDERING-PHASE optimizations (reduces CPU during frame capture) ----

  // OffthreadVideo thread pool — parallelizes video frame extraction
  // Remotion docs: NOT GPU-accelerated, but more threads = more CPU overlap
  // Use ~40% of cores for video decoding, leave rest for Chromium rendering
  const videoThreads = Math.max(2, Math.floor(caps.cpuCores * 0.4));
  result.offthreadVideoThreads = videoThreads;

  // Video frame cache — avoids re-decoding the same frames across browser pages
  // 512 MB default; scale with available RAM (cap at 2 GB)
  const cacheGB = Math.min(2, Math.max(0.5, caps.totalMemoryGB * 0.06));
  result.offthreadVideoCacheSizeInBytes = Math.round(cacheGB * 1024 * 1024 * 1024);

  // Lower JPEG quality for intermediate frames (75 vs Chromium's default 80)
  // Reduces disk I/O between render and encode phases — negligible visual difference
  result.jpegQuality = isPreview ? 70 : 80;

  // ---- ENCODING-PHASE optimizations (GPU offloading) ----
  //
  // IMPORTANT: Remotion bundles its own FFmpeg with a LIMITED set of encoders
  // (libx264, libx265, libvpx, prores_ks, etc.) — NO NVENC, AMF, QSV, or VAAPI.
  // The ffmpegOverride approach CANNOT inject GPU encoders into Remotion's FFmpeg.
  //
  // Native HW acceleration only works on macOS (VideoToolbox is built into FFmpeg).
  // On Windows/Linux, Remotion encoding stays on software (libx264) but we
  // compensate with rendering-phase optimizations above.
  //
  // Direct FFmpeg calls in local-ffmpeg-server.js use the SYSTEM FFmpeg which
  // DOES have NVENC/VAAPI/etc — those continue to use GPU encoding.

  const hasNativeHW = (caps.platform === 'darwin' && encoder === 'h264_videotoolbox');

  if (useRemotionHW && hasNativeHW) {
    // macOS VideoToolbox — natively supported by Remotion's FFmpeg
    result.hardwareAcceleration = 'if-possible';
    result.videoBitrate = isPreview ? '6M' : '10M';
    // Do NOT set crf — it conflicts with hardware acceleration
  } else {
    // Software encoding — use crf + fast preset
    result.crf = isPreview ? 30 : 20;
    result.x264Preset = isPreview ? 'ultrafast' : 'fast';
  }

  return result;
}

/**
 * Return FFmpeg encoder arg fragments for direct spawn() calls.
 *
 * @param {'preview'|'final'|'max'} quality
 * @returns {string[]} — array of FFmpeg args like ['-c:v', 'h264_nvenc', ...]
 */
export function getFFmpegEncodeArgs(quality = 'preview') {
  const useFFmpegHW = envBool('HWACCEL_FFMPEG');
  if (!useFFmpegHW) return SOFTWARE_ARGS[quality] || SOFTWARE_ARGS.preview;

  const caps = getCapabilities();
  const encoder = caps.preferredEncoder;

  if (encoder && ENCODER_ARGS[encoder]) {
    return ENCODER_ARGS[encoder][quality] || ENCODER_ARGS[encoder].preview;
  }

  // No HW encoder available — fall back to software
  return SOFTWARE_ARGS[quality] || SOFTWARE_ARGS.preview;
}

/**
 * Get a human-readable summary of the current acceleration config.
 * Useful for the /hwaccel-info diagnostic endpoint.
 */
export function getAccelSummary() {
  const caps = getCapabilities();
  return {
    ...caps,
    toggles: {
      HWACCEL_REMOTION: envBool('HWACCEL_REMOTION'),
      HWACCEL_FFMPEG: envBool('HWACCEL_FFMPEG'),
      HWACCEL_HEADFUL: envBool('HWACCEL_HEADFUL', caps.platform !== 'linux'),
    },
    effective: {
      remotionEncoder: envBool('HWACCEL_REMOTION') && caps.preferredEncoder
        ? caps.preferredEncoder
        : 'libx264 (software)',
      ffmpegEncoder: envBool('HWACCEL_FFMPEG') && caps.preferredEncoder
        ? caps.preferredEncoder
        : 'libx264 (software)',
      chromiumGl: pickGlBackend(caps.platform, caps.gpuName, envBool('HWACCEL_HEADFUL', caps.platform !== 'linux')) || 'default',
      chromeMode: envBool('HWACCEL_HEADFUL', caps.platform !== 'linux')
        ? 'chrome-for-testing (headful, real GPU)'
        : 'headless-shell (no GPU)',
      concurrency: caps.concurrency,
    },
  };
}
