/**
 * hw-detect.js — System hardware capability detection for HyperEdit.
 *
 * Probes the runtime environment (OS, CPU, GPU, FFmpeg encoders) and caches
 * the result so every subsequent call to getCapabilities() is synchronous.
 *
 * Run standalone for diagnostics:
 *   node scripts/hw-detect.js
 */

import { execSync } from 'child_process';
import os from 'os';

/** @type {HWCapabilities|null} */
let cached = null;

/**
 * @typedef {Object} HWCapabilities
 * @property {string}   platform          - process.platform value
 * @property {string}   arch              - process.arch value
 * @property {number}   cpuCores          - logical CPU core count
 * @property {string}   cpuModel          - first CPU model string
 * @property {number}   totalMemoryGB     - total system memory in GB
 * @property {string|null} gpuName        - detected GPU name or null
 * @property {string[]} ffmpegHwEncoders  - available h264 HW encoder names
 * @property {string|null} preferredEncoder - best HW encoder for this system
 * @property {string|null} preferredGl    - recommended Chromium --gl value
 * @property {number}   concurrency       - recommended Remotion concurrency
 */

// --------------- detection helpers ---------------

function detectGpuName() {
  const p = process.platform;
  try {
    if (p === 'win32') {
      // WMIC is available on all Windows versions
      const out = execSync(
        'wmic path win32_videocontroller get Name /format:list',
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      // Grab all GPU names and prefer dedicated GPUs over virtual/basic adapters
      const names = [...out.matchAll(/Name=(.+)/gi)].map(m => m[1].trim()).filter(Boolean);
      const dedicated = names.find(n =>
        /nvidia|geforce|radeon|rtx|gtx|arc\s*a/i.test(n)
      );
      return dedicated || names[0] || null;
    }
    if (p === 'linux') {
      // Try nvidia-smi first, fall back to lspci
      try {
        const nv = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
          encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (nv.trim()) return nv.trim().split('\n')[0].trim();
      } catch { /* no nvidia-smi */ }
      try {
        const lspci = execSync("lspci | grep -i 'vga\\|3d\\|display'", {
          encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (lspci.trim()) return lspci.trim().split('\n')[0].trim();
      } catch { /* no lspci */ }
      return null;
    }
    if (p === 'darwin') {
      const sp = execSync('system_profiler SPDisplaysDataType 2>/dev/null', {
        encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const match = sp.match(/Chipset Model:\s*(.+)/i) || sp.match(/Chip:\s*(.+)/i);
      return match ? match[1].trim() : null;
    }
  } catch { /* detection failed — non-fatal */ }
  return null;
}

/** Parse `ffmpeg -encoders` and return all h264 hardware encoder names. */
function detectFFmpegHwEncoders() {
  const known = [
    'h264_nvenc',
    'h264_amf',
    'h264_qsv',
    'h264_vaapi',
    'h264_videotoolbox',
    'h264_mediacodec',
    'h264_v4l2m2m',
  ];

  try {
    const out = execSync('ffmpeg -encoders 2>&1', {
      encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return known.filter((enc) => out.includes(enc));
  } catch {
    return [];
  }
}

/** Pick the best encoder for the current platform from the available list. */
function pickPreferredEncoder(platform, available) {
  // Priority order per platform
  const priority = {
    win32:  ['h264_nvenc', 'h264_amf', 'h264_qsv'],
    linux:  ['h264_nvenc', 'h264_vaapi', 'h264_qsv'],
    darwin: ['h264_videotoolbox'],
  };

  const order = priority[platform] || [];
  for (const enc of order) {
    if (available.includes(enc)) return enc;
  }
  return null;
}

/** Recommend a Chromium --gl backend for the platform. */
function pickGlBackend(platform, gpuName) {
  if (platform === 'darwin') return 'angle';
  if (platform === 'win32')  return 'angle';
  // Linux: egl if a GPU is detected, otherwise swangle (software)
  if (platform === 'linux')  return gpuName ? 'egl' : 'swangle';
  return null;
}

/** Suggest a sane Remotion concurrency value (~50-75 % of logical cores). */
function pickConcurrency(cpuCores) {
  if (cpuCores <= 2) return 1;
  if (cpuCores <= 4) return 2;
  return Math.max(2, Math.floor(cpuCores * 0.6));
}

// --------------- public API ---------------

/**
 * Run full hardware detection. Safe to call multiple times — result is cached.
 * @returns {Promise<HWCapabilities>}
 */
export async function detectCapabilities() {
  if (cached) return cached;

  const platform = process.platform;
  const cpuCores = os.cpus().length;
  const cpuModel = os.cpus()[0]?.model || 'unknown';
  const totalMemoryGB = Math.round(os.totalmem() / (1024 ** 3) * 10) / 10;
  const gpuName = detectGpuName();
  const ffmpegHwEncoders = detectFFmpegHwEncoders();
  const preferredEncoder = pickPreferredEncoder(platform, ffmpegHwEncoders);
  const preferredGl = pickGlBackend(platform, gpuName);
  const concurrency = pickConcurrency(cpuCores);

  cached = {
    platform,
    arch: process.arch,
    cpuCores,
    cpuModel,
    totalMemoryGB,
    gpuName,
    ffmpegHwEncoders,
    preferredEncoder,
    preferredGl,
    concurrency,
  };

  console.log('[HW-Detect] Capabilities:', JSON.stringify(cached, null, 2));
  return cached;
}

/**
 * Return the cached capabilities synchronously.
 * Throws if detectCapabilities() has not been called yet.
 * @returns {HWCapabilities}
 */
export function getCapabilities() {
  if (!cached) {
    throw new Error('hw-detect: call detectCapabilities() before getCapabilities()');
  }
  return cached;
}

// --------------- standalone diagnostics ---------------

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('hw-detect.js') || process.argv[1].endsWith('hw-detect'));

if (isMain) {
  detectCapabilities().then((caps) => {
    console.log('\n=== HyperEdit Hardware Detection ===');
    console.log(JSON.stringify(caps, null, 2));
  });
}
