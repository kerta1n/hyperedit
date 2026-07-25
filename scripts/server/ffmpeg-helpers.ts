import { spawn } from 'child_process';

// Run FFmpeg command and return a promise
// Shared spawn wrapper for ffmpeg/ffprobe: stderr capture, optional timeout,
// optional inline progress logging. Resolves with the chosen output stream.
export function runProcess(
  binary: string,
  label: string,
  args: string[],
  jobId: string,
  { timeout, resolveWith = 'stderr', logProgress = false }: { timeout?: number; resolveWith?: 'stderr' | 'stdout'; logProgress?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args);
    let stdout = '';
    let stderr = '';
    let killed = false;
    let timer: NodeJS.Timeout | undefined;

    if (timeout) {
      timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, timeout);
    }

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
      if (killed) {
        reject(new Error(`${label} timed out after ${timeout}ms`));
      } else if (code === 0) {
        resolve(resolveWith === 'stdout' ? stdout : stderr);
      } else {
        reject(new Error(`${label} failed with code ${code}: ${stderr.slice(-500)}`));
      }
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

export function runFFmpeg(args: string[], jobId: string, { timeout }: { timeout?: number } = {}): Promise<string> {
  return runProcess('ffmpeg', 'FFmpeg', args, jobId, { timeout, logProgress: true });
}

// Run FFprobe command and return stdout
export function runFFmpegProbe(args: string[], jobId: string): Promise<string> {
  return runProcess('ffprobe', 'FFprobe', args, jobId, { resolveWith: 'stdout' });
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
export async function getMediaInfo(inputPath: string): Promise<{ width: number; height: number; duration: number; fps: number }> {
  try {
    const result = await runFFmpegProbe([
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration,r_frame_rate:format=duration',
      '-of', 'json',
      inputPath
    ], 'probe');
    const info = JSON.parse(result);
    const stream = info.streams?.[0] || {};
    // r_frame_rate is a rational like "60/1" or "60000/1001"
    let fps = 0;
    if (stream.r_frame_rate) {
      const [num, den] = stream.r_frame_rate.split('/').map(Number);
      if (num && den) fps = num / den;
    }
    // Container (format) duration covers all streams; the video stream's own
    // duration undershoots it when audio outruns video, which starved the
    // /transcribe -t window of end-of-clip words. Same field getVideoDuration
    // probes, so asset.duration and transcribe windows share one basis.
    return {
      width: stream.width || 0,
      height: stream.height || 0,
      duration: parseFloat(info.format?.duration) || parseFloat(stream.duration) || 0,
      fps,
    };
  } catch {
    return { width: 0, height: 0, duration: 0, fps: 0 };
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
