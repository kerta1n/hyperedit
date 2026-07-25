/**
 * hwaccel-config.js — Translates HW capabilities + env var toggles into
 * concrete option objects for Remotion renderMedia() and raw FFmpeg calls.
 *
 * Environment variable toggles (set in .dev.vars):
 *
 *   HWACCEL_REMOTION=true|false          (default: true)
 *     Enable Remotion hardware-accelerated encoding: VideoToolbox on macOS,
 *     NVENC on Windows / Linux x64 with an NVIDIA GPU (Remotion >= 4.0.484).
 *     Uses videoBitrate instead of CRF when active.
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
// The `proxy` tier is the Phase 5 preview transcode: a bitrate-capped ~1.5 Mbps
// 540p stream (predictable file size drives the ramdisk budget math, §7.1), so
// even the software fallback caps bitrate rather than using CRF.
const ENCODER_ARGS = {
  h264_nvenc: {
    proxy: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', '1.5M', '-maxrate', '2M', '-bufsize', '3M'],
    preview: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', '6M'],
    final: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-b:v', '10M'],
    max: ['-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-b:v', '20M'],
  },
  h264_amf: {
    proxy: ['-c:v', 'h264_amf', '-quality', 'speed', '-b:v', '1.5M', '-maxrate', '2M'],
    preview: ['-c:v', 'h264_amf', '-quality', 'speed', '-b:v', '6M'],
    final: ['-c:v', 'h264_amf', '-quality', 'balanced', '-b:v', '10M'],
    max: ['-c:v', 'h264_amf', '-quality', 'quality', '-b:v', '20M'],
  },
  h264_qsv: {
    proxy: ['-c:v', 'h264_qsv', '-preset', 'faster', '-b:v', '1.5M', '-maxrate', '2M'],
    preview: ['-c:v', 'h264_qsv', '-preset', 'faster', '-b:v', '6M'],
    final: ['-c:v', 'h264_qsv', '-preset', 'medium', '-b:v', '10M'],
    max: ['-c:v', 'h264_qsv', '-preset', 'slow', '-b:v', '20M'],
  },
  h264_vaapi: {
    proxy: ['-c:v', 'h264_vaapi', '-b:v', '1.5M', '-maxrate', '2M'],
    preview: ['-c:v', 'h264_vaapi', '-b:v', '6M'],
    final: ['-c:v', 'h264_vaapi', '-b:v', '10M'],
    max: ['-c:v', 'h264_vaapi', '-b:v', '20M'],
  },
  h264_videotoolbox: {
    proxy: ['-c:v', 'h264_videotoolbox', '-b:v', '1.5M'],
    preview: ['-c:v', 'h264_videotoolbox', '-b:v', '6M'],
    final: ['-c:v', 'h264_videotoolbox', '-b:v', '10M'],
    max: ['-c:v', 'h264_videotoolbox', '-b:v', '20M'],
  },
};

const SOFTWARE_ARGS = {
  proxy: ['-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '1.5M', '-maxrate', '2M', '-bufsize', '3M'],
  preview: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18'],
  final: ['-c:v', 'libx264', '-preset', 'fast', '-crf', '20'],
  max: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'],
};

// --------------- remotion HW eligibility ---------------

/**
 * The encoder Remotion's own render pipeline can use natively, or null.
 *
 * Remotion (4.0.484+) supports exactly two hardware paths:
 *   macOS: VideoToolbox — bundled FFmpeg has it built in
 *   Windows / Linux x64: NVENC — needs an NVIDIA GPU. On Linux x64 the bundled
 *     FFmpeg ships with NVENC; on Windows it does NOT, so render.js provisions
 *     a binariesDirectory merging the system FFmpeg (see render-binaries-helpers.js)
 *     — hence the win32 check that the system FFmpeg actually has h264_nvenc.
 * AMF/QSV/VAAPI are not supported by Remotion — those systems stay on libx264.
 * `ffmpeg -encoders` lists compiled-in encoders even with no GPU installed,
 * so NVENC additionally requires an NVIDIA adapter in gpuName.
 *
 * hardwareAcceleration: 'if-possible' covers both h264 (h264_nvenc) and
 * h265 (hevc_nvenc); Remotion probes the FFmpeg it spawns and silently falls
 * back to software when the encoder is missing.
 */
function remotionHwEncoder(caps) {
  if (caps.platform === 'darwin' && caps.preferredEncoder === 'h264_videotoolbox') {
    return 'h264_videotoolbox';
  }
  const hasNvidiaGpu = /nvidia|geforce|rtx|quadro|tesla/i.test(caps.gpuName || '');
  if (!hasNvidiaGpu) return null;
  if (caps.platform === 'win32' && caps.ffmpegHwEncoders.includes('h264_nvenc')) {
    return 'h264_nvenc';
  }
  if (caps.platform === 'linux' && caps.arch === 'x64') {
    return 'h264_nvenc';
  }
  return null;
}

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
  // See remotionHwEncoder() above for the platform/encoder eligibility rules.

  if (useRemotionHW && remotionHwEncoder(caps)) {
    result.hardwareAcceleration = 'if-possible';
    result.videoBitrate = isPreview ? '6M' : '10M';
    // Do NOT set crf (or x264Preset) — both conflict with hardware acceleration
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
 * @param {'proxy'|'preview'|'final'|'max'} quality
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
      remotionEncoder: envBool('HWACCEL_REMOTION') && remotionHwEncoder(caps)
        ? remotionHwEncoder(caps)
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
