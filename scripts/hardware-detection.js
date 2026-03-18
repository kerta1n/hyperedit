import { spawn } from 'child_process';

// Encoder priority: higher index = higher priority
const ENCODER_PRIORITY = [
  'libx264',
  'h264_videotoolbox',
  'h264_vaapi',
  'h264_amf',
  'h264_qsv',
  'h264_nvenc',
];

const ENCODER_VENDOR = {
  h264_nvenc: 'nvidia',
  h264_qsv: 'intel',
  h264_amf: 'amd',
  h264_vaapi: 'unknown', // Could be AMD or Intel on Linux
  h264_videotoolbox: 'apple',
};

/**
 * Run `ffmpeg -encoders` and return the set of available h264 hardware encoder names.
 */
function detectAvailableEncoders() {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-encoders', '-hide_banner']);
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('close', () => {
      const found = new Set();
      for (const name of ENCODER_PRIORITY) {
        // ffmpeg -encoders output lines look like: " V....D h264_nvenc  NVIDIA ..."
        if (name !== 'libx264' && stdout.includes(name)) {
          found.add(name);
        }
      }
      resolve(found);
    });
    proc.on('error', () => resolve(new Set()));
  });
}

/**
 * Determine the best Remotion `--gl` option for the current platform.
 */
function detectBestGl(platform, hasGpu) {
  if (!hasGpu) return 'swangle';
  switch (platform) {
    case 'darwin': return 'angle';
    case 'win32': return 'angle';
    case 'linux': return 'angle-egl';
    default: return 'swangle';
  }
}

/**
 * Detect hardware capabilities once at startup.
 * Respects env var overrides: HARDWARE_ACCEL, REMOTION_GL, FFMPEG_ENCODER.
 */
export async function detectHardwareCapabilities() {
  const platform = process.platform;
  const hardwareAccelSetting = (process.env.HARDWARE_ACCEL || 'auto').toLowerCase();

  // If explicitly off, return software-only capabilities
  if (hardwareAccelSetting === 'off') {
    const caps = {
      platform,
      hasGpu: false,
      gpuVendor: null,
      bestGlOption: process.env.REMOTION_GL || 'swangle',
      bestFfmpegEncoder: process.env.FFMPEG_ENCODER || 'libx264',
      hardwareAccelerationAvailable: false,
    };
    logCapabilities(caps, 'disabled via HARDWARE_ACCEL=off');
    return caps;
  }

  const available = await detectAvailableEncoders();

  // Pick best encoder by priority
  let bestEncoder = 'libx264';
  for (const name of ENCODER_PRIORITY) {
    if (available.has(name)) bestEncoder = name;
  }

  const hasGpu = bestEncoder !== 'libx264';
  const gpuVendor = hasGpu ? (ENCODER_VENDOR[bestEncoder] || 'unknown') : null;
  const bestGl = detectBestGl(platform, hasGpu);

  const caps = {
    platform,
    hasGpu,
    gpuVendor,
    bestGlOption: process.env.REMOTION_GL || bestGl,
    bestFfmpegEncoder: process.env.FFMPEG_ENCODER || bestEncoder,
    hardwareAccelerationAvailable: hasGpu || hardwareAccelSetting === 'on',
  };

  logCapabilities(caps, hardwareAccelSetting === 'on' ? 'forced via HARDWARE_ACCEL=on' : 'auto-detected');
  return caps;
}

function logCapabilities(caps, mode) {
  console.log(`\n[Hardware] Detection (${mode}):`);
  console.log(`  Platform:      ${caps.platform}`);
  console.log(`  GPU:           ${caps.hasGpu ? `yes (${caps.gpuVendor})` : 'none detected'}`);
  console.log(`  FFmpeg encoder: ${caps.bestFfmpegEncoder}`);
  console.log(`  Remotion GL:   ${caps.bestGlOption}`);
  console.log(`  HW accel:      ${caps.hardwareAccelerationAvailable ? 'available' : 'unavailable'}\n`);
}

/**
 * Build Remotion render options from detected capabilities.
 * Merges with caller-provided options.
 */
export function buildRemotionHardwareOptions(caps, preview = false) {
  if (!caps || !caps.hardwareAccelerationAvailable) {
    return { crf: preview ? 30 : 20 };
  }

  const opts = {
    chromiumOptions: { gl: caps.bestGlOption },
    // Use videoBitrate instead of crf — ABR mode is less CPU-intensive with libx264
    videoBitrate: preview ? '2M' : '8M',
  };

  // Remotion only supports hardwareAcceleration on macOS (h264_videotoolbox).
  // On Windows/Linux it silently falls back to libx264, but the flag can
  // destabilize the compositor subprocess, causing EPIPE crashes.
  if (caps.platform === 'darwin') {
    opts.hardwareAcceleration = 'if-possible';
  }

  if (caps.platform === 'linux') {
    opts.chromiumOptions.enableMultiProcessOnLinux = true;
  }

  return opts;
}

/**
 * Return FFmpeg encoder args array for a given encoder and quality level.
 * Replaces hardcoded `-c:v libx264 -preset ... -crf ...` patterns.
 *
 * @param {string} encoder - The encoder name (e.g. 'h264_nvenc', 'libx264')
 * @param {'preview'|'export'} quality - Quality preset
 * @returns {string[]} FFmpeg args to splice into the command
 */
export function getFFmpegEncoderArgs(encoder, quality) {
  const isExport = quality === 'export';

  switch (encoder) {
    case 'h264_nvenc':
      return [
        '-c:v', 'h264_nvenc',
        '-preset', isExport ? 'p4' : 'p1',
        '-b:v', isExport ? '8M' : '2M',
      ];

    case 'h264_qsv':
      return [
        '-c:v', 'h264_qsv',
        '-preset', isExport ? 'fast' : 'veryfast',
        '-b:v', isExport ? '8M' : '2M',
      ];

    case 'h264_amf':
      return [
        '-c:v', 'h264_amf',
        '-quality', isExport ? 'balanced' : 'speed',
        '-b:v', isExport ? '8M' : '2M',
      ];

    case 'h264_vaapi':
      return [
        '-hwaccel', 'vaapi',
        '-vaapi_device', '/dev/dri/renderD128',
        '-c:v', 'h264_vaapi',
        '-b:v', isExport ? '8M' : '2M',
      ];

    case 'h264_videotoolbox':
      return [
        '-c:v', 'h264_videotoolbox',
        '-b:v', isExport ? '8M' : '2M',
      ];

    default: // libx264 software fallback
      return [
        '-c:v', 'libx264',
        '-preset', isExport ? 'medium' : 'ultrafast',
        '-crf', isExport ? '18' : '28',
      ];
  }
}
