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
 * @property {string|null} gpuName        - detected GPU name or null (null = no real GPU found)
 * @property {string[]} ffmpegHwEncoders  - available h264 HW encoder names
 * @property {string|null} preferredEncoder - best HW encoder for this system
 * @property {number}   concurrency       - recommended Remotion concurrency
 *
 * NOTE: GL backend is intentionally absent from this object — it depends on
 * headful/headless mode, which is an env-var toggle resolved at render time.
 * Use pickGlBackend(platform, gpuName, headful) to get the correct value.
 */

// --------------- detection helpers ---------------

// Software/virtual adapters that have no real GPU silicon — treat as no GPU.
// Blocklist approach: reject known-bad rather than allow known-good, so real
// integrated GPUs (Intel UHD, Iris, QuickSync) pass through automatically.
const VIRTUAL_GPU = /basic render|basic display|vmware|virtualbox|hyper-v|virtio|qxl paravirtual|bochs|llvmpipe|swrast|microsoft remote/i;

function detectGpuName() {
  const p = process.platform;
  try {
    if (p === 'win32') {
      // WMIC is available on all Windows versions
      const out = execSync(
        'wmic path win32_videocontroller get Name /format:list',
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const names = [...out.matchAll(/Name=(.+)/gi)].map(m => m[1].trim()).filter(Boolean);
      // Prefer discrete GPU; fall back to any real adapter (Intel UHD, Iris, etc.)
      const dedicated = names.find(n => /nvidia|geforce|radeon|rtx|gtx|arc\s*a/i.test(n));
      if (dedicated) return dedicated;
      const real = names.find(n => !VIRTUAL_GPU.test(n));
      return real || null;
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
        // Filter out virtual/software adapters (VMware SVGA, virtio-vga, etc.)
        const real = lspci.trim().split('\n').find(l => l.trim() && !VIRTUAL_GPU.test(l));
        if (real) return real.trim();
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

// `ffmpeg -encoders` reports what is COMPILED IN, not what the hardware can
// run — a Gyan/winget build lists h264_nvenc on an AMD-only machine and the
// encode then fails at runtime. Runtime usability needs the matching GPU
// vendor, so each encoder is cross-checked against the detected adapter name.
const ENCODER_GPU_VENDOR = {
  h264_nvenc: /nvidia|geforce|rtx|gtx|quadro|tesla/i,
  h264_amf: /amd|radeon/i,
  h264_qsv: /intel|uhd|iris|arc\s*a/i,
  h264_vaapi: /nvidia|geforce|amd|radeon|intel|uhd|iris/i,
  h264_videotoolbox: null, // darwin-only in the priority list — platform gate suffices
};

/** Pick the best encoder for the current platform from the available list. */
function pickPreferredEncoder(platform, available, gpuName) {
  // Priority order per platform
  const priority = {
    win32:  ['h264_nvenc', 'h264_amf', 'h264_qsv'],
    linux:  ['h264_nvenc', 'h264_vaapi', 'h264_qsv'],
    darwin: ['h264_videotoolbox'],
  };

  const order = priority[platform] || [];
  for (const enc of order) {
    if (!available.includes(enc)) continue;
    const vendor = ENCODER_GPU_VENDOR[enc];
    if (vendor && !vendor.test(gpuName || '')) continue;
    return enc;
  }
  return null;
}

/**
 * Recommend a Chromium --gl backend based on OS, GPU presence, and render mode.
 *
 * headful=true  → chrome-for-testing with real GPU drivers
 * headful=false → headless-shell (limited GPU access)
 *
 * win32 + GPU: angle-egl — faster than angle in benchmarks (headful and headless)
 * win32 + no GPU: swangle (software ANGLE)
 * darwin: angle always — Metal/ANGLE works in all modes; Apple always has real GPU
 * linux + GPU + headful: angle-egl — Remotion docs recommend for GPU instances
 * linux + GPU + headless: egl — native EGL, reliable headless
 * linux + no GPU: swangle (software ANGLE)
 *
 * @param {string}      platform
 * @param {string|null} gpuName  - null means no real GPU detected
 * @param {boolean}     headful  - true when using chrome-for-testing (headful mode)
 * @returns {string|null}
 */
export function pickGlBackend(platform, gpuName, headful) {
  const hasGpu = Boolean(gpuName);

  if (platform === 'win32') {
    if (!hasGpu) return 'swangle';
    return 'angle-egl';
  }
  if (platform === 'darwin') {
    return 'angle';
  }
  if (platform === 'linux') {
    if (!hasGpu) return 'swangle';
    return headful ? 'angle-egl' : 'egl';
  }
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
  const preferredEncoder = pickPreferredEncoder(platform, ffmpegHwEncoders, gpuName);
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
    console.log('\n--- GL Backend (resolved at render time) ---');
    console.log('  headful :', pickGlBackend(caps.platform, caps.gpuName, true));
    console.log('  headless:', pickGlBackend(caps.platform, caps.gpuName, false));
  });
}
