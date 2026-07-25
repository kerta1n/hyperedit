import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import SynAudio from 'synaudio';
import { TEMP_DIR } from './server-config.ts';
import { parseBody, sendJSON } from './http-helpers.ts';
import { requireSession, saveAssetMetadata } from './session-store.ts';
import { parseFFmpegArgs, runFFmpeg, runFFmpegProbe } from './ffmpeg-helpers.ts';
import type { SessionRoute } from './route-table.ts';

// Asset transformation: ffmpeg-command processing, audio/video split,
// audio cross-correlation sync, animated-GIF creation. Storage/serving
// lives in asset-service.

// Create animated GIF from an image
async function handleCreateGif(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const options = body ? JSON.parse(body) : {};

    const {
      sourceAssetId,
      effect = 'pulse', // pulse, zoom, rotate, bounce, fade
      duration = 2,      // seconds
      fps = 15,
      width = 400,
      height = 400,
    } = options;

    const sourceAsset = session.assets.get(sourceAssetId);
    if (!sourceAsset) {
      sendJSON(res, { error: 'Source asset not found' }, 404);
      return;
    }

    if (sourceAsset.type !== 'image') {
      sendJSON(res, { error: 'Source must be an image' }, 400);
      return;
    }

    const jobId = randomUUID();
    console.log(`\n[${jobId}] === CREATE ANIMATED GIF ===`);
    console.log(`[${jobId}] Source: ${sourceAsset.filename}, Effect: ${effect}, Duration: ${duration}s`);

    // Generate GIF output path
    const gifId = randomUUID();
    const gifPath = join(session.assetsDir, `${gifId}.gif`);
    const thumbPath = join(session.assetsDir, `${gifId}_thumb.jpg`);

    // Build FFmpeg filter based on effect
    let filter;
    const totalFrames = duration * fps;

    switch (effect) {
      case 'pulse':
        // Pulsing scale effect (breathe in/out)
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
          `zoompan=z='1+0.1*sin(on*PI*2/${totalFrames})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
        break;

      case 'zoom':
        // Ken Burns zoom in effect
        filter = `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=decrease,` +
          `zoompan=z='min(zoom+0.002,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=${width}x${height}:fps=${fps}`;
        break;

      case 'rotate':
        // Gentle rotation effect
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
          `rotate=t*PI/8:c=none:ow=${width}:oh=${height},fps=${fps}`;
        break;

      case 'bounce':
        // Bouncing effect (up and down)
        filter = `scale=${width}:${height - 40}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:'(oh-ih)/2+20*sin(t*PI*2)':color=transparent,fps=${fps}`;
        break;

      case 'fade':
        // Fade in and out
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
          `fade=t=in:st=0:d=${duration / 4},fade=t=out:st=${duration * 3 / 4}:d=${duration / 4},fps=${fps}`;
        break;

      case 'shake':
        // Shake/vibrate effect
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width + 20}:${height + 20}:(ow-iw)/2:(oh-ih)/2,` +
          `crop=${width}:${height}:'10+5*sin(t*30)':'10+5*cos(t*25)',fps=${fps}`;
        break;

      default:
        // Simple loop with no animation
        filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`;
    }

    // FFmpeg command to create animated GIF
    const ffmpegArgs = [
      '-y',
      '-loop', '1',
      '-i', sourceAsset.path,
      '-t', duration.toString(),
      '-vf', filter,
      '-gifflags', '+transdiff',
      gifPath
    ];

    console.log(`[${jobId}] Running FFmpeg...`);
    await runFFmpeg(ffmpegArgs, jobId);

    // Generate thumbnail from first frame
    try {
      await runFFmpeg([
        '-y',
        '-i', gifPath,
        '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
        '-frames:v', '1',
        thumbPath
      ], jobId);
    } catch (e: any) {
      console.warn(`[${jobId}] Thumbnail generation failed:`, e.message);
    }

    const { stat } = await import('fs/promises');
    const stats = await stat(gifPath);

    // Create asset entry
    const gifAsset = {
      id: gifId,
      type: 'image',
      filename: `${sourceAsset.filename.replace(/\.[^.]+$/, '')}-${effect}.gif`,
      path: gifPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: duration, // GIFs have duration
      size: stats.size,
      width,
      height,
      createdAt: Date.now(),
    };

    session.assets.set(gifId, gifAsset);
    saveAssetMetadata(session); // Persist asset metadata to disk

    console.log(`[${jobId}] GIF created: ${(stats.size / 1024).toFixed(1)} KB`);
    console.log(`[${jobId}] === GIF CREATION COMPLETE ===\n`);

    sendJSON(res, {
      success: true,
      asset: {
        id: gifAsset.id,
        type: gifAsset.type,
        filename: gifAsset.filename,
        duration: gifAsset.duration,
        size: gifAsset.size,
        width: gifAsset.width,
        height: gifAsset.height,
        thumbnailUrl: gifAsset.thumbPath ? `/session/${sessionId}/assets/${gifId}/thumbnail` : null,
      },
    });

  } catch (error: any) {
    console.error(`[${sessionId}] GIF creation error:`, error.message);
    sendJSON(res, { error: error.message }, 500);
  }
}

// Cross-correlate audio from two assets to compute alignment offset
async function handleAudioSync(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  const jobId = randomUUID().substring(0, 8);
  const pcmPathA = join(TEMP_DIR, `${jobId}-a.pcm`);
  const pcmPathB = join(TEMP_DIR, `${jobId}-b.pcm`);

  try {
    const body = await parseBody(req);
    const { assetA, assetB, sampleRate = 16000, correlationSampleSize = 3200, initialGranularity = 16 } = body;

    if (!assetA || !assetB) {
      sendJSON(res, { error: 'assetA and assetB are required' }, 400);
      return;
    }

    const assetObjA = session.assets.get(assetA);
    const assetObjB = session.assets.get(assetB);
    if (!assetObjA) {
      sendJSON(res, { error: 'Asset not found', assetId: assetA }, 404);
      return;
    }
    if (!assetObjB) {
      sendJSON(res, { error: 'Asset not found', assetId: assetB }, 404);
      return;
    }

    console.log(`\n[${jobId}] === AUDIO SYNC ===`);
    console.log(`[${jobId}] Asset A: ${assetObjA.filename}, Asset B: ${assetObjB.filename}`);

    // Verify both assets have an audio stream
    for (const [, asset] of [['A', assetObjA], ['B', assetObjB]] as const) {
      const probeOut = await runFFmpegProbe([
        '-v', 'error', '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'json', asset.path
      ], jobId);
      const probeData = JSON.parse(probeOut);
      if (!probeData.streams || probeData.streams.length === 0) {
        sendJSON(res, { error: 'Asset has no audio stream', assetId: asset.id }, 400);
        return;
      }
    }

    // Probe durations for region slicing
    let note: string | undefined = undefined;
    const durationArgs = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1'];
    const durA = parseFloat(await runFFmpegProbe([...durationArgs, assetObjA.path], jobId));
    const durB = parseFloat(await runFFmpegProbe([...durationArgs, assetObjB.path], jobId));

    const region = body.analysisRegion || 'full';
    const safetyLimit = 600;
    // Clamp the caller-supplied window: correlation must stay bounded server-side
    // regardless of input — offsets are findable within seconds of audio, and an
    // unbounded window means ~150MB Float32Arrays and a multi-minute O(n*m)
    // freeze of the single-threaded server on 40-minute assets.
    const segDuration = body.analysisDuration ? Math.min(body.analysisDuration, safetyLimit) : null;

    const computeSeekAndDuration = (clipDur: number): { ss: number | null; t: number | null } => {
      if (region === 'full') {
        const t = clipDur > safetyLimit ? safetyLimit : null;
        return { ss: null, t };
      }
      const seg = Math.min(segDuration || 15, clipDur);
      if (region === 'start') return { ss: 0, t: seg };
      if (region === 'end') return { ss: Math.max(0, clipDur - seg), t: seg };
      return { ss: Math.max(0, (clipDur / 2) - (seg / 2)), t: seg };
    };

    const sliceA = computeSeekAndDuration(durA);
    const sliceB = computeSeekAndDuration(durB);

    if (region !== 'full') {
      note = `Analyzed ${region} ${segDuration || 15}s segment`;
      console.log(`[${jobId}] Region: ${region}, segment: ${segDuration || 15}s (A: ss=${sliceA.ss}, B: ss=${sliceB.ss})`);
    } else if (sliceA.t || sliceB.t) {
      note = `Analyzed first ${safetyLimit}s only`;
      console.log(`[${jobId}] Safety cap: ${safetyLimit}s (A=${durA.toFixed(1)}s, B=${durB.toFixed(1)}s)`);
    }

    // Bandpass 2-8kHz isolates transient energy (claps/clicks) shared between mic types.
    // Compressor + dynaudnorm normalize gain differences between USB condenser and DSLR onboard mics.
    // -ac 1 handles both mono and stereo input (pan=mono crashes on mono).
    const extractArgs = (inputPath: string, outputPath: string, slice: { ss: number | null; t: number | null }) => {
      const args = ['-y'];
      if (slice.ss !== null) args.push('-ss', String(slice.ss));
      args.push('-i', inputPath);
      if (slice.t !== null) args.push('-t', String(slice.t));
      args.push('-map', '0:a:0', '-vn',
        '-af', 'highpass=f=2000,lowpass=f=8000,acompressor=threshold=-20dB:ratio=8:attack=0.5:release=50,dynaudnorm=p=0.95:m=5',
        '-ac', '1', '-ar', String(sampleRate),
        '-c:a', 'pcm_f32le', '-f', 'f32le', outputPath);
      return args;
    };

    console.log(`[${jobId}] Extracting PCM at ${sampleRate}Hz...`);
    await Promise.all([
      runFFmpeg(extractArgs(assetObjA.path, pcmPathA, sliceA), jobId),
      runFFmpeg(extractArgs(assetObjB.path, pcmPathB, sliceB), jobId),
    ]);

    const bufA = readFileSync(pcmPathA);
    const bufB = readFileSync(pcmPathB);
    const floatsA = new Float32Array(bufA.buffer, bufA.byteOffset, bufA.byteLength / 4);
    const floatsB = new Float32Array(bufB.buffer, bufB.byteOffset, bufB.byteLength / 4);

    // synaudio requires base.samplesDecoded >= comparison.samplesDecoded
    let swapped = false;
    let base = { channelData: [floatsA], samplesDecoded: floatsA.length };
    let comparison = { channelData: [floatsB], samplesDecoded: floatsB.length };
    if (floatsA.length < floatsB.length) {
      swapped = true;
      [base, comparison] = [comparison, base];
    }

    console.log(`[${jobId}] Cross-correlating (base=${base.samplesDecoded} samples, comparison=${comparison.samplesDecoded}, swapped=${swapped})...`);
    const synAudio = new SynAudio({ correlationSampleSize, initialGranularity });
    const result = await synAudio.sync(base, comparison);

    // Convert segment-relative offset to absolute clip time.
    // Convention: assetB[0] aligns with assetA[offsetSeconds].
    const rawOffset = result.sampleOffset / sampleRate;
    const seekA = sliceA.ss || 0;
    const seekB = sliceB.ss || 0;
    const offsetSeconds = seekA + (swapped ? -rawOffset : rawOffset) - seekB;

    const correlation = result.correlation;
    const confidence = correlation > 0.7 ? 'high' : correlation >= 0.4 ? 'medium' : 'low';

    console.log(`[${jobId}] Result: offset=${offsetSeconds.toFixed(4)}s, correlation=${correlation.toFixed(4)}, confidence=${confidence}`);

    const response: any = { offsetSeconds, correlation, confidence };
    if (note) response.note = note;

    sendJSON(res, response);
  } catch (err: any) {
    console.error(`[${jobId}] Audio sync failed:`, err);
    sendJSON(res, { error: 'Correlation failed', details: err.message }, 500);
  } finally {
    try { unlinkSync(pcmPathA); } catch {}
    try { unlinkSync(pcmPathB); } catch {}
  }
}

// Extract audio from video - creates separate audio asset and mutes the video
async function handleExtractAudio(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    const body = await parseBody(req);
    const { assetId } = body;

    if (!assetId) {
      sendJSON(res, { error: 'assetId is required' }, 400);
      return;
    }

    const videoAsset = session.assets.get(assetId);
    if (!videoAsset) {
      sendJSON(res, { error: 'Asset not found' }, 404);
      return;
    }

    if (videoAsset.type !== 'video') {
      sendJSON(res, { error: 'Asset must be a video' }, 400);
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === EXTRACT AUDIO ===`);
    console.log(`[${jobId}] Source video: ${videoAsset.filename}`);

    // Generate IDs and paths
    const audioAssetId = randomUUID();
    const mutedVideoAssetId = randomUUID();
    const audioPath = join(session.assetsDir, `${audioAssetId}.mp3`);
    const mutedVideoPath = join(session.assetsDir, `${mutedVideoAssetId}.mp4`);
    const mutedThumbPath = join(session.assetsDir, `${mutedVideoAssetId}_thumb.jpg`);

    // Step 1: Extract audio from video
    console.log(`[${jobId}] Step 1: Extracting audio...`);
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vn',                    // No video
      '-acodec', 'libmp3lame',  // MP3 codec
      '-q:a', '2',              // High quality
      audioPath
    ], jobId);

    // Step 2: Create muted version of video
    console.log(`[${jobId}] Step 2: Creating muted video...`);
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-an',                    // No audio
      '-c:v', 'copy',           // Copy video stream (fast)
      mutedVideoPath
    ], jobId);

    // Step 3: Generate thumbnail for muted video
    try {
      await runFFmpeg([
        '-y', '-i', mutedVideoPath,
        '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
        '-frames:v', '1',
        mutedThumbPath
      ], jobId);
    } catch (e: any) {
      console.warn(`[${jobId}] Thumbnail generation failed:`, e.message);
    }

    // Get file stats
    const { stat } = await import('fs/promises');
    const audioStats = await stat(audioPath);
    const videoStats = await stat(mutedVideoPath);

    // Get audio duration
    let audioDuration = videoAsset.duration;
    try {
      const durationStr = (await runFFmpegProbe([
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        audioPath
      ], jobId)).trim();
      audioDuration = parseFloat(durationStr) || videoAsset.duration;
    } catch (e: any) {
      console.warn(`[${jobId}] Could not get audio duration:`, e.message);
    }

    // Create audio asset
    const audioAsset = {
      id: audioAssetId,
      type: 'audio',
      filename: `${videoAsset.filename.replace(/\.[^.]+$/, '')}-audio.mp3`,
      path: audioPath,
      thumbPath: null,
      duration: audioDuration,
      size: audioStats.size,
      createdAt: Date.now(),
      sourceAssetId: assetId,
    };
    session.assets.set(audioAssetId, audioAsset);

    // Create muted video asset
    const mutedAsset = {
      id: mutedVideoAssetId,
      type: 'video',
      filename: `${videoAsset.filename.replace(/\.[^.]+$/, '')}-muted.mp4`,
      path: mutedVideoPath,
      thumbPath: existsSync(mutedThumbPath) ? mutedThumbPath : videoAsset.thumbPath,
      duration: videoAsset.duration,
      size: videoStats.size,
      width: videoAsset.width || 1920,
      height: videoAsset.height || 1080,
      createdAt: Date.now(),
      sourceAssetId: assetId,
      isMuted: true,
    };
    session.assets.set(mutedVideoAssetId, mutedAsset);
    saveAssetMetadata(session); // Persist asset metadata to disk

    console.log(`[${jobId}] ✓ Audio extracted: ${audioAsset.filename} (${(audioDuration ?? 0).toFixed(2)}s)`);
    console.log(`[${jobId}] ✓ Muted video created: ${mutedAsset.filename}`);
    console.log(`[${jobId}] === EXTRACT AUDIO COMPLETE ===\n`);

    sendJSON(res, {
      success: true,
      audioAsset: {
        id: audioAssetId,
        filename: audioAsset.filename,
        duration: audioDuration,
        type: 'audio',
        streamUrl: `/session/${sessionId}/assets/${audioAssetId}/stream`,
      },
      mutedVideoAsset: {
        id: mutedVideoAssetId,
        filename: mutedAsset.filename,
        duration: mutedAsset.duration,
        type: 'video',
        streamUrl: `/session/${sessionId}/assets/${mutedVideoAssetId}/stream`,
        thumbnailUrl: `/session/${sessionId}/assets/${mutedVideoAssetId}/thumbnail`,
      },
      originalAssetId: assetId,
    });

  } catch (error: any) {
    console.error('Extract audio error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}

// Process asset with FFmpeg command (for AI-suggested edits)
async function handleProcessAsset(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    const body = await parseBody(req);
    const { assetId, command } = body;

    if (!assetId || !command) {
      sendJSON(res, { error: 'assetId and command are required' }, 400);
      return;
    }

    const asset = session.assets.get(assetId);
    if (!asset) {
      sendJSON(res, { error: 'Asset not found' }, 404);
      return;
    }

    // Verify the asset file actually exists on disk
    if (!existsSync(asset.path)) {
      console.error(`[ProcessAsset] Asset file missing: ${asset.path}`);
      sendJSON(res, {
        error: 'Asset file no longer exists. The session may have expired. Please re-upload your video.',
        code: 'ASSET_FILE_MISSING'
      }, 410);
      return;
    }

    const jobId = randomUUID();
    const newAssetId = randomUUID();
    const outputPath = join(session.assetsDir, `${newAssetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${newAssetId}_thumb.jpg`);

    console.log(`\n[${jobId}] === PROCESS ASSET WITH FFMPEG ===`);
    console.log(`[${jobId}] Source: ${asset.filename}`);
    console.log(`[${jobId}] Command: ${command}`);

    // Tokenize with the quote-aware parser (spawn uses no shell, so embedded
    // quote characters would reach ffmpeg literally), then swap the
    // input/output placeholders for real paths.
    let ffmpegArgs = parseFFmpegArgs(command).map(arg => {
      if (/^input\.[a-z0-9]+$/i.test(arg)) return asset.path;
      if (/^output\.[a-z0-9]+$/i.test(arg)) return outputPath;
      return arg;
    });

    // If the command doesn't have proper input/output, construct a basic one
    if (!ffmpegArgs.some(arg => arg.includes(asset.path))) {
      // Reconstruct with proper input
      ffmpegArgs = ['-y', '-i', asset.path, ...ffmpegArgs.filter(a => a !== '-i'), outputPath];
    }

    // Ensure -y flag for overwrite
    if (!ffmpegArgs.includes('-y')) {
      ffmpegArgs.unshift('-y');
    }

    console.log(`[${jobId}] FFmpeg args:`, ffmpegArgs);

    await runFFmpeg(ffmpegArgs, jobId);

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Get video info
    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    // Get duration with ffprobe
    let duration = asset.duration;
    try {
      const durationStr = (await runFFmpegProbe([
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        outputPath
      ], jobId)).trim();
      duration = parseFloat(durationStr) || asset.duration;
    } catch (e: any) {
      console.warn(`[${jobId}] Could not get duration:`, e.message);
    }

    // Create new asset entry
    const newAsset = {
      id: newAssetId,
      type: 'video',
      filename: `edited-${asset.filename}`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration,
      size: stats.size,
      width: asset.width || 1920,
      height: asset.height || 1080,
      createdAt: Date.now(),
      // Metadata
      sourceAssetId: assetId,
      ffmpegCommand: command,
    };

    session.assets.set(newAssetId, newAsset);
    saveAssetMetadata(session); // Persist asset metadata to disk

    console.log(`[${jobId}] Asset processed: ${newAssetId} (${(duration ?? 0).toFixed(2)}s)`);
    console.log(`[${jobId}] === PROCESSING COMPLETE ===\n`);

    sendJSON(res, {
      success: true,
      assetId: newAssetId,
      filename: newAsset.filename,
      duration,
      thumbnailUrl: `/session/${sessionId}/assets/${newAssetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${newAssetId}/stream`,
    });

  } catch (error: any) {
    console.error('Process asset error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}

export const assetProcessingRoutes: SessionRoute[] = [
  { method: 'POST', action: 'create-gif', handler: handleCreateGif },
  { method: 'POST', action: 'audio-sync', handler: handleAudioSync },
  { method: 'POST', action: 'extract-audio', handler: handleExtractAudio },
  { method: 'POST', action: 'process-asset', handler: handleProcessAsset },
];
