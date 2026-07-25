import type { SessionRoute } from './route-table.ts';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { TEMP_DIR } from './server-config.ts';
import { parseBody, sendJSON, sendJobAccepted } from './http-helpers.ts';
import { requireSession, saveAssetMetadata } from './session-store.ts';
import { getVideoDuration, runFFmpeg } from './ffmpeg-helpers.ts';
import { callFal, cancelGenerativeRequest, downloadArtifact, falUpload } from './fal-gateway.ts';
import type { JobRecord } from './job-store.ts';
import { enqueueJob } from './job-queue.ts';
import { generateWithLLM, hasLLMProvider } from './llm-gateway.ts';
import { ensureProjectDefaults } from '../project-schema.js';

// Video generation lanes (DiCaprio agent): image-to-video, video restyle,
// and background removal through the generative provider gateway.

// DELETE on the job makes a real remote cancel attempt once the provider
// queue has accepted the request. The paid path is untestable here
// (owner-accepted); the caveat lands in the job record's note.
function installRemoteCancel(job: JobRecord, model: string, jobId: string) {
  return (requestId: string) => {
    job.cancel = () => {
      job.note = 'remote cancel attempted (untested paid path)';
      cancelGenerativeRequest(model, requestId, jobId);
    };
  };
}

// Generate video from image using fal.ai (DiCaprio agent)
async function handleGenerateVideo(req, res, sessionId) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  const falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falApiKey) {
    sendJSON(res, { error: 'FAL_KEY or FAL_API_KEY not configured in .dev.vars' }, 500);
    return;
  }

  try {
    const body = await parseBody(req);
    const { prompt, imageAssetId, duration = 5 } = body;

    if (!prompt) {
      sendJSON(res, { error: 'prompt is required' }, 400);
      return;
    }

    if (!imageAssetId) {
      sendJSON(res, { error: 'imageAssetId is required' }, 400);
      return;
    }

    // Get the source image asset
    const imageAsset = session.assets.get(imageAssetId);
    if (!imageAsset || imageAsset.type !== 'image') {
      sendJSON(res, { error: 'Image asset not found' }, 400);
      return;
    }

    const job = enqueueJob({
      sessionId,
      kind: 'video-gen',
      lane: 'fal',
      run: async (job) => {
    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === DICAPRIO: GENERATE VIDEO ===`);
    console.log(`[${jobId}] User prompt: ${prompt}`);
    console.log(`[${jobId}] Source image: ${imageAsset.filename}`);
    console.log(`[${jobId}] Duration: ${duration}s`);

    // Enhance prompt using LLM for better video generation
    let enhancedPrompt = prompt;
    if (hasLLMProvider()) {
      try {
        console.log(`[${jobId}] Enhancing prompt with DiCaprio AI...`);

        const systemPrompt = `You are DiCaprio, an expert AI prompt engineer specializing in image-to-video generation. Your role is to transform simple motion requests into detailed, cinematic prompts that produce stunning videos.

## Your Expertise
- Deep knowledge of cinematography, camera movements, and film techniques
- Understanding of timing, pacing, and motion dynamics
- Mastery of visual storytelling through movement
- Knowledge of video generation model capabilities

## Prompt Enhancement Guidelines

1. **Camera Movement**: Be specific about camera motion (dolly, pan, tilt, zoom, crane, tracking, handheld)
2. **Motion Direction**: Specify direction and speed (slow zoom in, gentle pan left, dynamic push forward)
3. **Subject Motion**: Describe how elements in the scene should move (hair flowing, leaves rustling, water rippling)
4. **Atmosphere**: Include atmospheric effects (light rays moving, dust particles, fog drifting)
5. **Timing**: Use terms like "gradual", "sudden", "rhythmic", "smooth", "cinematic"

## Response Format
Return ONLY the enhanced prompt text. No explanations, no quotes, no markdown.`;

        enhancedPrompt = (await generateWithLLM(`Enhance this video motion prompt: "${prompt}"`, { systemPrompt })).trim();
        console.log(`[${jobId}] Enhanced prompt: ${enhancedPrompt.substring(0, 100)}...`);
      } catch (e) {
        console.log(`[${jobId}] Prompt enhancement failed, using original: ${e.message}`);
      }
    }

    // Upload image to provider storage to get a URL (handles large files)
    const mimeType = imageAsset.filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    const uploadedImageUrl = await falUpload(imageAsset.path, mimeType, jobId);

    // Match the project's canvas orientation so generated video fits the composition
    const genSettings = ensureProjectDefaults(session.project).settings;
    const genAspect = genSettings.width === genSettings.height
      ? '1:1'
      : (genSettings.width > genSettings.height ? '16:9' : '9:16');

    console.log(`[${jobId}] Calling video-gen provider (${genAspect})...`);
    const videoGenModel = 'fal-ai/kling-video/v1.5/pro/image-to-video';
    const falResult = await callFal(videoGenModel, {
      prompt: enhancedPrompt,
      image_url: uploadedImageUrl,
      duration: duration === 10 ? '10' : '5',
      aspect_ratio: genAspect,
    }, jobId, { onRequestId: installRemoteCancel(job, videoGenModel, jobId) });

    console.log(`[${jobId}] Video generation complete!`);

    // Download the generated video - SDK returns { data, requestId }
    const videoUrl = falResult.data?.video?.url;
    if (!videoUrl) {
      throw new Error('No video URL in response');
    }

    // Save to assets
    const videoId = randomUUID();
    const shortPrompt = prompt.substring(0, 30).replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
    const videoPath = join(session.assetsDir, `${videoId}.mp4`);
    const thumbPath = join(session.assetsDir, `${videoId}_thumb.jpg`);

    await downloadArtifact(videoUrl, videoPath, 'generated video');

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', videoPath,
      '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    const videoDuration = (await getVideoDuration(videoPath)) || duration;

    const { stat } = await import('fs/promises');
    const stats = await stat(videoPath);

    // Create asset entry
    const asset = {
      id: videoId,
      filename: `dicaprio-${shortPrompt}.mp4`,
      originalFilename: `dicaprio-${shortPrompt}.mp4`,
      type: 'video',
      path: videoPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      size: stats.size,
      duration: videoDuration,
      width: 1920,
      height: 1080,
      uploadedAt: Date.now(),
      generatedBy: 'dicaprio',
      sourcePrompt: prompt,
      enhancedPrompt: enhancedPrompt,
      sourceImageId: imageAssetId,
    };

    session.assets.set(videoId, asset);
    saveAssetMetadata(session);

    console.log(`[${jobId}] Saved video: ${asset.filename} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`[${jobId}] === DICAPRIO COMPLETE ===\n`);

    return {
      success: true,
      video: {
        id: videoId,
        filename: asset.filename,
        thumbnailUrl: `/session/${sessionId}/assets/${videoId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${videoId}/stream`,
        duration: videoDuration,
      },
    };
      },
    });

    sendJobAccepted(res, sessionId, job);

  } catch (error) {
    console.error('Video generation error:', error);
    console.error('Error stack:', error.stack);
    sendJSON(res, { error: error.message }, 500);
  }
}

// Restyle video using LTX-2 video-to-video (DiCaprio agent)
async function handleRestyleVideo(req, res, sessionId) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  const falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falApiKey) {
    sendJSON(res, { error: 'FAL_KEY or FAL_API_KEY not configured in .dev.vars' }, 500);
    return;
  }

  try {
    const body = await parseBody(req);
    const { prompt, videoAssetId } = body;

    if (!prompt) {
      sendJSON(res, { error: 'prompt is required' }, 400);
      return;
    }

    if (!videoAssetId) {
      sendJSON(res, { error: 'videoAssetId is required' }, 400);
      return;
    }

    // Get the source video asset
    const videoAsset = session.assets.get(videoAssetId);
    if (!videoAsset || videoAsset.type !== 'video') {
      sendJSON(res, { error: 'Video asset not found' }, 400);
      return;
    }

    const job = enqueueJob({
      sessionId,
      kind: 'restyle',
      lane: 'fal',
      run: async (job) => {
    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === DICAPRIO: RESTYLE VIDEO ===`);
    console.log(`[${jobId}] User prompt: ${prompt}`);
    console.log(`[${jobId}] Source video: ${videoAsset.filename}`);

    // Enhance prompt using LLM for better style transfer
    let enhancedPrompt = prompt;
    if (hasLLMProvider()) {
      try {
        console.log(`[${jobId}] Enhancing style prompt with AI...`);

        enhancedPrompt = (await generateWithLLM(`You are an expert at writing prompts for AI video style transfer. Transform this simple style request into a detailed, cinematic prompt that will produce stunning results.

User request: "${prompt}"

Write a detailed prompt describing the visual style. Include:
- Color grading and mood
- Texture and grain quality
- Lighting style
- Overall aesthetic
- Any specific visual effects

Return ONLY the enhanced prompt, no explanations.`)).trim();
        console.log(`[${jobId}] Enhanced prompt: ${enhancedPrompt.substring(0, 100)}...`);
      } catch (e) {
        console.log(`[${jobId}] Prompt enhancement failed, using original: ${e.message}`);
      }
    }

    // Compress video for upload (fal.ai has size limits)
    const compressedPath = join(TEMP_DIR, `${jobId}-compressed.mp4`);
    console.log(`[${jobId}] Compressing video for upload...`);

    // Compress to 720p max, lower bitrate for faster upload
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vf', 'scale=-2:720',  // Max 720p height, maintain aspect
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '28',  // Lower quality but smaller file
      '-c:a', 'aac',
      '-b:a', '128k',
      '-t', '10',  // Max 10 seconds for API limits
      compressedPath
    ], jobId);

    // Upload compressed video to provider storage
    const uploadedVideoUrl = await falUpload(compressedPath, 'video/mp4', jobId);

    // Clean up compressed file
    try { unlinkSync(compressedPath); } catch (e) { }

    console.log(`[${jobId}] Calling restyle provider...`);
    const restyleModel = 'fal-ai/ltx-2-19b/video-to-video';
    const falResult = await callFal(restyleModel, {
      prompt: enhancedPrompt,
      video_url: uploadedVideoUrl,
      num_inference_steps: 40,
      guidance_scale: 3,
      video_strength: 0.7,
      generate_audio: false,
      video_quality: 'high',
    }, jobId, { onRequestId: installRemoteCancel(job, restyleModel, jobId) });

    console.log(`[${jobId}] Video restyle complete!`);

    // Download the restyled video - SDK returns { data, requestId }
    const outputVideoUrl = falResult.data?.video?.url;
    if (!outputVideoUrl) {
      throw new Error('No video URL in response');
    }

    // Save to assets
    const newVideoId = randomUUID();
    const shortPrompt = prompt.substring(0, 20).replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
    const outputPath = join(session.assetsDir, `${newVideoId}.mp4`);
    const thumbPath = join(session.assetsDir, `${newVideoId}_thumb.jpg`);

    await downloadArtifact(outputVideoUrl, outputPath, 'restyled video');

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    const videoDuration = (await getVideoDuration(outputPath)) || videoAsset.duration || 5;

    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    const asset = {
      id: newVideoId,
      filename: `restyled-${shortPrompt}.mp4`,
      originalFilename: `restyled-${shortPrompt}.mp4`,
      type: 'video',
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      size: stats.size,
      duration: videoDuration,
      width: falResult.video?.width || 1280,
      height: falResult.video?.height || 720,
      uploadedAt: Date.now(),
      generatedBy: 'dicaprio-restyle',
      sourcePrompt: prompt,
      sourceVideoId: videoAssetId,
    };

    session.assets.set(newVideoId, asset);
    saveAssetMetadata(session);

    console.log(`[${jobId}] Saved restyled video: ${asset.filename}`);
    console.log(`[${jobId}] === DICAPRIO RESTYLE COMPLETE ===\n`);

    return {
      success: true,
      video: {
        id: newVideoId,
        filename: asset.filename,
        thumbnailUrl: `/session/${sessionId}/assets/${newVideoId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${newVideoId}/stream`,
        duration: videoDuration,
      },
    };
      },
    });

    sendJobAccepted(res, sessionId, job);

  } catch (error) {
    console.error('Video restyle error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}

// Remove video background using Bria (DiCaprio agent)
async function handleRemoveVideoBg(req, res, sessionId) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  const falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falApiKey) {
    sendJSON(res, { error: 'FAL_KEY or FAL_API_KEY not configured in .dev.vars' }, 500);
    return;
  }

  try {
    const body = await parseBody(req);
    const { videoAssetId } = body;

    if (!videoAssetId) {
      sendJSON(res, { error: 'videoAssetId is required' }, 400);
      return;
    }

    // Get the source video asset
    const videoAsset = session.assets.get(videoAssetId);
    if (!videoAsset || videoAsset.type !== 'video') {
      sendJSON(res, { error: 'Video asset not found' }, 400);
      return;
    }

    const job = enqueueJob({
      sessionId,
      kind: 'bg-removal',
      lane: 'fal',
      run: async (job) => {
    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === DICAPRIO: REMOVE VIDEO BACKGROUND ===`);
    console.log(`[${jobId}] Source video: ${videoAsset.filename}`);

    // Compress video for upload (fal.ai has size limits)
    const compressedPath = join(TEMP_DIR, `${jobId}-bg-compressed.mp4`);
    console.log(`[${jobId}] Compressing video for upload...`);

    // Compress to 720p max, lower bitrate for faster upload
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vf', 'scale=-2:720',  // Max 720p height, maintain aspect
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '28',  // Lower quality but smaller file
      '-c:a', 'aac',
      '-b:a', '128k',
      '-t', '10',  // Max 10 seconds for API limits
      compressedPath
    ], jobId);

    // Upload compressed video to provider storage
    const uploadedVideoUrl = await falUpload(compressedPath, 'video/mp4', jobId);

    // Clean up compressed file
    try { unlinkSync(compressedPath); } catch (e) { }

    console.log(`[${jobId}] Calling bg-removal provider...`);
    const bgRemovalModel = 'fal-ai/ben/v2/video';
    const falResult = await callFal(bgRemovalModel, {
      video_url: uploadedVideoUrl,
      output_format: 'webm',  // WebM for transparency support
    }, jobId, { onRequestId: installRemoteCancel(job, bgRemovalModel, jobId) });

    console.log(`[${jobId}] Background removal complete!`);

    // Download the processed video - SDK returns { data, requestId }
    const outputVideoUrl = falResult.data?.video?.url;
    if (!outputVideoUrl) {
      throw new Error('No video URL in response');
    }

    // Save to assets (webm for transparency support)
    const newVideoId = randomUUID();
    const baseName = videoAsset.filename.replace(/\.[^/.]+$/, '');
    const outputPath = join(session.assetsDir, `${newVideoId}.webm`);
    const thumbPath = join(session.assetsDir, `${newVideoId}_thumb.jpg`);

    await downloadArtifact(outputVideoUrl, outputPath, 'processed video');

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    const videoDuration = (await getVideoDuration(outputPath)) || videoAsset.duration || 5;

    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    const asset = {
      id: newVideoId,
      filename: `${baseName}-nobg.webm`,
      originalFilename: `${baseName}-nobg.webm`,
      type: 'video',
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      size: stats.size,
      duration: videoDuration,
      width: videoAsset.width || 1920,
      height: videoAsset.height || 1080,
      uploadedAt: Date.now(),
      generatedBy: 'dicaprio-remove-bg',
      sourceVideoId: videoAssetId,
      hasTransparency: true,
    };

    session.assets.set(newVideoId, asset);
    saveAssetMetadata(session);

    console.log(`[${jobId}] Saved video: ${asset.filename}`);
    console.log(`[${jobId}] === DICAPRIO REMOVE BG COMPLETE ===\n`);

    return {
      success: true,
      video: {
        id: newVideoId,
        filename: asset.filename,
        thumbnailUrl: `/session/${sessionId}/assets/${newVideoId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${newVideoId}/stream`,
        duration: videoDuration,
      },
    };
      },
    });

    sendJobAccepted(res, sessionId, job);

  } catch (error) {
    console.error('Video background removal error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}





export const videoGenRoutes: SessionRoute[] = [
  { method: 'POST', action: 'generate-video', handler: handleGenerateVideo },
  { method: 'POST', action: 'restyle-video', handler: handleRestyleVideo },
  { method: 'POST', action: 'remove-video-bg', handler: handleRemoveVideoBg },
];
