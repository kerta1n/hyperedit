import { spawn } from 'child_process';

// Run FFmpeg command and return a promise
// Shared spawn wrapper for ffmpeg/ffprobe: stderr capture, optional timeout,
// optional inline progress logging. Resolves with the chosen output stream.
export function runProcess(
  binary: string,
  label: string,
  args: string[],
  jobId: string,
  { timeout, resolveWith = 'stderr', logProgress = false, signal }: { timeout?: number; resolveWith?: 'stderr' | 'stdout'; logProgress?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${label} aborted`));
      return;
    }
    const child = spawn(binary, args);
    let stdout = '';
    let stderr = '';
    // Why the process died, if we killed it — keeps the timeout and cancel
    // rejections distinguishable (a cancel must not look like a real failure).
    let killReason: 'timeout' | 'abort' | null = null;
    let timer: NodeJS.Timeout | undefined;

    if (timeout) {
      timer = setTimeout(() => {
        killReason = 'timeout';
        child.kill('SIGKILL');
      }, timeout);
    }

    const onAbort = () => {
      killReason = 'abort';
      child.kill('SIGKILL');
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (logProgress) {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.includes('time=') || line.includes('frame=')) {
            process.stdout.write(`\r[${jobId}] ${line.trim()}`);
          }
        }
      }
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (killReason === 'timeout') {
        reject(new Error(`${label} timed out after ${timeout}ms`));
      } else if (killReason === 'abort') {
        reject(new Error(`${label} aborted`));
      } else if (code === 0) {
        resolve(resolveWith === 'stdout' ? stdout : stderr);
      } else {
        reject(new Error(`${label} failed with code ${code}: ${stderr.slice(-500)}`));
      }
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

export function runFFmpeg(args: string[], jobId: string, { timeout, signal }: { timeout?: number; signal?: AbortSignal } = {}): Promise<string> {
  return runProcess('ffmpeg', 'FFmpeg', args, jobId, { timeout, logProgress: true, signal });
}

// Run FFprobe command and return stdout
export function runFFmpegProbe(args: string[], jobId: string): Promise<string> {
  return runProcess('ffprobe', 'FFprobe', args, jobId, { resolveWith: 'stdout' });
}

// True iff the file has at least one audio stream. Used to skip waveform-peak
// extraction on silent video (screen recordings, muted exports): ffmpeg's
// `-vn … -f s16le -` errors ("Output file does not contain any stream") when
// there is no audio, so building peaks for those is a guaranteed failure — skip,
// don't fail. A probe error returns false (skip) rather than throwing.
export async function hasAudioStream(inputPath: string): Promise<boolean> {
  try {
    const out = await runFFmpegProbe([
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', inputPath,
    ], 'probe');
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Compute a waveform peak envelope from an asset's audio for the timeline strip
// (Phase 5 step 7). Decodes to low-rate mono s16le PCM on ffmpeg's STDOUT — no
// temp file, no full PCM buffer left on the ramdisk — and buckets it in one
// streaming pass: ~peaksPerSec buckets/sec, each the max |sample| in its window
// normalized to 0..1 (rounded to 3 dp). Binary is captured as Buffers, never a
// string (runProcess's string concat would corrupt the PCM). Boring JSON output,
// no invented binary format. Rejects on non-zero exit, timeout, or abort.
export function extractWaveformPeaks(
  inputPath: string,
  { peaksPerSec = 20, sampleRate = 8000, timeout = 600_000, signal }:
    { peaksPerSec?: number; sampleRate?: number; timeout?: number; signal?: AbortSignal } = {},
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('waveform peaks aborted')); return; }
    const samplesPerPeak = Math.max(1, Math.round(sampleRate / peaksPerSec));
    const child = spawn('ffmpeg', [
      '-v', 'error', '-i', inputPath, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-',
    ]);

    const peaks: number[] = [];
    let curMax = 0;
    let count = 0;
    let carry: Buffer | null = null; // odd trailing byte across a chunk boundary
    let stderr = '';
    let killReason: 'timeout' | 'abort' | null = null;

    const timer = setTimeout(() => { killReason = 'timeout'; child.kill('SIGKILL'); }, timeout);
    const onAbort = () => { killReason = 'abort'; child.kill('SIGKILL'); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      carry = usable < buf.length ? buf.subarray(usable) : null;
      for (let i = 0; i < usable; i += 2) {
        const s = Math.abs(buf.readInt16LE(i));
        if (s > curMax) curMax = s;
        if (++count >= samplesPerPeak) {
          peaks.push(Math.round((curMax / 32768) * 1000) / 1000);
          curMax = 0; count = 0;
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (killReason === 'timeout') { reject(new Error(`waveform peaks timed out after ${timeout}ms`)); return; }
      if (killReason === 'abort') { reject(new Error('waveform peaks aborted')); return; }
      if (code !== 0) { reject(new Error(`waveform peaks failed with code ${code}: ${stderr.slice(-300)}`)); return; }
      if (count > 0) peaks.push(Math.round((curMax / 32768) * 1000) / 1000); // final partial bucket
      resolve(peaks);
    });
  });
}

export interface SilencePeriod {
  start: number;
  end: number;
}

// Detect silence in video and return silence periods
export async function detectSilence(
  inputPath: string,
  jobId: string,
  options: { silenceThreshold?: number; minSilenceDuration?: number } = {},
): Promise<SilencePeriod[]> {
  const {
    silenceThreshold = -40, // dB
    minSilenceDuration = 0.5, // seconds
  } = options;

  console.log(`[${jobId}] Detecting silence (threshold: ${silenceThreshold}dB, min duration: ${minSilenceDuration}s)...`);

  const args = [
    '-i', inputPath,
    '-af', `silencedetect=noise=${silenceThreshold}dB:d=${minSilenceDuration}`,
    '-f', 'null',
    '-'
  ];

  const stderr = await runFFmpeg(args, jobId);

  // Parse silence detection output
  const silencePeriods: SilencePeriod[] = [];
  const lines = stderr.split('\n');

  let currentStart: number | null = null;
  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([\d.]+)/);
    const endMatch = line.match(/silence_end:\s*([\d.]+)/);

    if (startMatch) {
      currentStart = parseFloat(startMatch[1]);
    }
    if (endMatch && currentStart !== null) {
      silencePeriods.push({
        start: currentStart,
        end: parseFloat(endMatch[1])
      });
      currentStart = null;
    }
  }

  console.log(`\n[${jobId}] Found ${silencePeriods.length} silence periods`);
  return silencePeriods;
}

// Get video/audio duration (returns 0 for images)
export async function getVideoDuration(inputPath: string): Promise<number> {
  try {
    const result = await runFFmpegProbe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath
    ], 'probe');
    const duration = parseFloat(result.trim());
    return isNaN(duration) ? 0 : duration;
  } catch {
    return 0;
  }
}

// Calculate segments to keep (inverse of silence periods)
export function calculateKeepSegments(
  silencePeriods: SilencePeriod[],
  totalDuration: number,
  minSegmentDuration = 0.1,
): Array<{ start: number; end: number }> {
  if (silencePeriods.length === 0) {
    return [{ start: 0, end: totalDuration }];
  }

  const keepSegments: Array<{ start: number; end: number }> = [];
  let lastEnd = 0;

  for (const silence of silencePeriods) {
    if (silence.start > lastEnd + minSegmentDuration) {
      keepSegments.push({
        start: lastEnd,
        end: silence.start
      });
    }
    lastEnd = silence.end;
  }

  // Add final segment if there's content after last silence
  if (lastEnd < totalDuration - minSegmentDuration) {
    keepSegments.push({
      start: lastEnd,
      end: totalDuration
    });
  }

  return keepSegments;
}

// Generate thumbnail for video/image asset
export async function generateThumbnail(inputPath: string, outputPath: string, isImage = false): Promise<void> {
  const timeout = 15000;
  if (isImage) {
    const args = [
      '-y', '-i', inputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      outputPath
    ];
    await runFFmpeg(args, 'thumb', { timeout });
  } else {
    const duration = await getVideoDuration(inputPath);
    const seekTime = Math.min(1, duration * 0.1);
    const args = [
      '-y', '-ss', seekTime.toString(),
      '-i', inputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      outputPath
    ];
    await runFFmpeg(args, 'thumb', { timeout });
  }
}

// Get video/image dimensions
export interface MediaInfo {
  width: number;
  height: number;
  duration: number;
  fps: number;
  vfr: boolean;
  hdr: boolean;
  rotation: number;
}

// Parse a `-print_format json` ffprobe result into media info + the ingest
// conform flags (VFR/HDR/rotation). Pure (no ffprobe call) so the
// classification is unit-tested from canned JSON. Absent fields mean "unset"
// → constant frame rate / SDR / no rotation.
export function classifyMediaProbe(info: any): MediaInfo {
  const stream = info?.streams?.[0] || {};
  const rate = (r: unknown): number => {
    if (typeof r !== 'string') return 0;
    const [num, den] = r.split('/').map(Number);
    return num && den ? num / den : 0;
  };
  const fps = rate(stream.r_frame_rate);
  const avgFps = rate(stream.avg_frame_rate);
  // VFR: the average rate diverges from the nominal base rate (both known).
  // Screen recordings / phone footage report avg != r; true CFR has avg == r.
  const vfr = fps > 0 && avgFps > 0 && Math.abs(fps - avgFps) / fps > 0.01;
  // HDR is a transfer-function property: PQ (smpte2084) or HLG (arib-std-b67).
  // BT.2020 primaries alone can be SDR, so key on color_transfer only.
  const trc = String(stream.color_transfer || '').toLowerCase();
  const hdr = trc === 'smpte2084' || trc === 'arib-std-b67';
  // Rotation: display-matrix side data (modern) → legacy rotate tag (fallback),
  // normalized to [0, 360). Side-data rotation is commonly negative.
  let rotation = 0;
  const sd = Array.isArray(stream.side_data_list)
    ? stream.side_data_list.find((s: any) => s && s.rotation != null)
    : null;
  if (sd) rotation = Number(sd.rotation);
  else if (stream.tags && stream.tags.rotate != null) rotation = Number(stream.tags.rotate);
  rotation = ((Math.round(rotation) % 360) + 360) % 360;
  return {
    width: stream.width || 0,
    height: stream.height || 0,
    // Container (format) duration covers all streams; the video stream's own
    // duration undershoots it when audio outruns video, which starved the
    // /transcribe -t window of end-of-clip words. Same field getVideoDuration
    // probes, so asset.duration and transcribe windows share one basis.
    duration: parseFloat(info?.format?.duration) || parseFloat(stream.duration) || 0,
    fps,
    vfr,
    hdr,
    rotation,
  };
}

export async function getMediaInfo(inputPath: string): Promise<MediaInfo> {
  try {
    const result = await runFFmpegProbe([
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries',
      'stream=width,height,duration,r_frame_rate,avg_frame_rate,color_transfer,color_primaries,color_space:stream_side_data=rotation:stream_tags=rotate:format=duration',
      '-of', 'json',
      inputPath
    ], 'probe');
    return classifyMediaProbe(JSON.parse(result));
  } catch {
    return { width: 0, height: 0, duration: 0, fps: 0, vfr: false, hdr: false, rotation: 0 };
  }
}

export function parseFFmpegArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  // Remove 'ffmpeg' prefix if present
  command = command.replace(/^ffmpeg\s+/, '');

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
    } else if (char === ' ' && !inQuotes) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}
