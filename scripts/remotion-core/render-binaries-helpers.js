/**
 * render-binaries-helpers.js — Provisions the `binariesDirectory` that Remotion
 * needs for NVENC encoding on Windows.
 *
 * Remotion (>= 4.0.484) supports NVENC via `hardwareAcceleration`, but its
 * bundled Windows FFmpeg is a minimal build WITHOUT NVENC. `binariesDirectory`
 * overrides where renderMedia() looks for ALL THREE binaries it spawns:
 * remotion.exe (the compositor, plus its DLLs), ffmpeg and ffprobe. So the
 * directory must merge the compositor package's files with the system FFmpeg
 * (which has NVENC).
 *
 * The merged dir is version-stamped with the compositor package version so a
 * Remotion upgrade never runs a stale remotion.exe. It lives under the output
 * root (HDD): survives reboots (ramdisk doesn't) and keeps writes off flash.
 *
 * The system FFmpeg lacks libfdk_aac (non-free — no redistributable build can
 * ship it), which Remotion hardcodes for aac audio preprocessing. So the swap
 * also remaps aac to FFmpeg's native encoder inside Remotion's CJS module
 * registry (render.js consumes the CJS build for exactly this reason).
 *
 * Linux x64 needs none of this — Remotion's bundled Linux FFmpeg ships with
 * NVENC since 4.0.484 (Linux ARM64 has no NVENC at all).
 *
 * EXIT CONDITION: rust-ffmpeg-splitter PR #18 (open, 2026-07) adds NVENC to
 * Remotion's bundled Windows FFmpeg. Once a Remotion release ships it, delete
 * this module and revert render.js to a plain `import` of @remotion/renderer.
 */

import { execSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const COMPOSITOR_PKG = '@remotion/compositor-win32-x64-msvc';

/** undefined = not attempted yet; null = unavailable; string = merged dir */
let resolved;

function findOnPath(bin) {
  const out = execSync(`where ${bin}`, {
    encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const first = out.trim().split(/\r?\n/)[0];
  if (!first) throw new Error(`${bin} not found on PATH`);
  return first;
}

function buildMergedDir(outputRoot) {
  const pkgJsonPath = require.resolve(`${COMPOSITOR_PKG}/package.json`);
  const compositorDir = dirname(pkgJsonPath);
  const { version } = require(`${COMPOSITOR_PKG}/package.json`);

  const binDir = join(outputRoot, 'cache', 'remotion-bin', version);
  const complete = ['remotion.exe', 'ffmpeg.exe', 'ffprobe.exe']
    .every((f) => existsSync(join(binDir, f)));
  if (complete) return binDir;

  // System FFmpeg first — if it's missing, fail before writing anything.
  // NOTE: assumes a static build (e.g. Gyan/winget). A DLL-dependent ffmpeg.exe
  // would fail Remotion's encoder probe after copying → software fallback.
  const systemFfmpeg = findOnPath('ffmpeg');
  const systemFfprobe = findOnPath('ffprobe');

  mkdirSync(binDir, { recursive: true });

  // remotion.exe + its DLLs; skip the bundled (non-NVENC) ffmpeg/ffprobe
  for (const file of readdirSync(compositorDir)) {
    if (file === 'ffmpeg.exe' || file === 'ffprobe.exe') continue;
    if (!file.endsWith('.exe') && !file.endsWith('.dll')) continue;
    copyFileSync(join(compositorDir, file), join(binDir, file));
  }

  copyFileSync(systemFfmpeg, join(binDir, 'ffmpeg.exe'));
  copyFileSync(systemFfprobe, join(binDir, 'ffprobe.exe'));

  console.log(`[Remotion] NVENC binaries merged at: ${binDir} (system FFmpeg: ${systemFfmpeg})`);
  return binDir;
}

function patchRemotionAacEncoder() {
  // Remotion hardcodes libfdk_aac for aac audio — only its own FFmpeg builds
  // have it. Remap aac to FFmpeg's native encoder for the swapped-in system
  // FFmpeg. Internal call sites (compress/create/combine audio) look the
  // function up on the module object at call time, so patching the export is
  // effective everywhere.
  const internalRequire = createRequire(require.resolve('@remotion/renderer'));
  const audioCodec = internalRequire('./options/audio-codec.js');
  const original = audioCodec.mapAudioCodecToFfmpegAudioCodecName;
  if (typeof original !== 'function') {
    throw new Error('@remotion/renderer audio-codec module shape changed — aac remap impossible');
  }
  audioCodec.mapAudioCodecToFfmpegAudioCodecName = (codec) =>
    codec === 'aac' ? 'aac' : original(codec);
}

/**
 * Return the merged binaries dir for Windows NVENC, or null when Remotion's
 * bundled binaries should be used as-is (non-Windows) or provisioning failed.
 * Idempotent and cached; the copy runs at most once per process.
 *
 * @param {string} outputRoot - HYPEREDIT_OUTPUT root (HDD)
 * @returns {string|null}
 */
export function ensureNvencBinariesDir(outputRoot) {
  if (resolved !== undefined) return resolved;
  if (process.platform !== 'win32') {
    resolved = null;
    return resolved;
  }
  try {
    const binDir = buildMergedDir(outputRoot);
    patchRemotionAacEncoder();
    resolved = binDir;
  } catch (err) {
    console.warn(`[Remotion] NVENC binaries setup failed — falling back to software encoding: ${err.message}`);
    resolved = null;
  }
  return resolved;
}
