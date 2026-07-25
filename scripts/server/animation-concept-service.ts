import { createReadStream, existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { renderDynamicInWorker } from './render-client.ts';
import { TEMP_DIR } from './server-config.ts';
import { parseBody, sendJSON, sendJobAccepted } from './http-helpers.ts';
import { makeRenderProgressUpdater } from './job-store.ts';
import { enqueueJob } from './job-queue.ts';
import { orientationOf, requireSession, resolveCompositionSettings, saveAssetMetadata, writeJsonAtomic } from './session-store.ts';
import { runFFmpeg, runFFmpegProbe } from './ffmpeg-helpers.ts';
import { checkLocalWhisper, runLocalWhisper } from './whisper-helpers.ts';
import { generateWithLLM, hasLLMProvider, parseLLMJson, transcribeAudioWithLLM } from './llm-gateway.ts';

import { searchGiphy } from './giphy-service.ts';
import type { SessionRoute } from './route-table.ts';

// Approval-gated animation lane: analyze a video segment into a concept
// (no render), then render from a pre-approved concept. This is the
// current Remotion baseline path (see the addendum baseline checklist).

// Returns transcript and proposed animation scenes for user approval
async function handleAnalyzeForAnimation(req, res, sessionId) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  if (!hasLLMProvider()) {
    sendJSON(res, { error: 'No LLM provider configured. Set GEMINI_API_KEY or OPENAI_API_BASE_URL in .dev.vars' }, 500);
    return;
  }

  try {
    const body = await parseBody(req);
    const { assetId, type = 'intro', description, startTime, endTime } = body;
    const { fps, width, height } = resolveCompositionSettings(session, body);

    // Debug: log received time range values
    console.log(`[DEBUG] Received analyze request - startTime: ${startTime} (${typeof startTime}), endTime: ${endTime} (${typeof endTime})`);

    // Get the video asset to analyze — explicit target only; library-order
    // guessing is nondeterministic after restarts
    if (!assetId) {
      sendJSON(res, {
        error: 'assetId is required',
        hint: 'Pass the id of the video asset to analyze; GET /session/:id/assets lists assets.',
      }, 400);
      return;
    }
    const videoAsset = session.assets.get(assetId);

    if (!videoAsset) {
      sendJSON(res, { error: 'No video asset found to analyze' }, 400);
      return;
    }

    const job = enqueueJob({
      sessionId,
      kind: 'animation-analyze',
      lane: 'llm',
      run: async () => {
    const jobId = randomUUID();
    const audioPath = join(TEMP_DIR, `${jobId}-audio.mp3`);

    // Determine if we're analyzing a specific time range or the whole video
    const hasTimeRange = typeof startTime === 'number' && typeof endTime === 'number';
    const segmentStart = hasTimeRange ? startTime : 0;
    const segmentDuration = hasTimeRange ? (endTime - startTime) : null;

    console.log(`\n[${jobId}] === ANALYZE VIDEO FOR ${type.toUpperCase()} ANIMATION ===`);
    console.log(`[${jobId}] Analyzing video: ${videoAsset.filename}`);
    if (hasTimeRange) {
      console.log(`[${jobId}] Time range: ${segmentStart.toFixed(1)}s - ${endTime.toFixed(1)}s (${segmentDuration.toFixed(1)}s segment)`);
    }

    // Step 1: Transcribe the video (or just the specified segment)
    console.log(`[${jobId}] Step 1: Transcribing ${hasTimeRange ? 'segment' : 'video'}...`);

    // Extract audio from video - optionally just from the specified time range
    const ffmpegArgs = ['-y'];
    if (hasTimeRange) {
      // -ss before -i (input seeking): jump to the segment instead of decoding the
      // whole file up to it; frame-accurate because the audio is re-encoded
      ffmpegArgs.push('-ss', segmentStart.toString());
      ffmpegArgs.push('-t', segmentDuration.toString());
    }
    ffmpegArgs.push('-i', videoAsset.path);
    ffmpegArgs.push('-vn', '-acodec', 'libmp3lame', '-ar', '16000', '-ac', '1', '-q:a', '9', audioPath);

    await runFFmpeg(ffmpegArgs, jobId);

    // Get video duration
    const durationOutput = await runFFmpegProbe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoAsset.path
    ], jobId);
    const totalDuration = parseFloat(durationOutput.trim()) || 60;
    const analyzedDuration = hasTimeRange ? segmentDuration : totalDuration;

    let transcription;
    const hasLocalWhisper = await checkLocalWhisper();
    const openaiKey = process.env.OPENAI_API_KEY;

    // Fallback transcription via the LLM provider's audio understanding
    const transcribeWithLLMFallback = async () => {
      return transcribeAudioWithLLM(audioPath, analyzedDuration.toFixed(1), jobId, { wordTimestamps: false });
    };

    if (hasLocalWhisper) {
      try {
        console.log(`[${jobId}]    Using local Whisper...`);
        transcription = await runLocalWhisper(audioPath, jobId);
      } catch (whisperError) {
        console.log(`[${jobId}]    Local Whisper failed: ${whisperError.message}`);
        console.log(`[${jobId}]    Falling back to Gemini...`);
        transcription = await transcribeWithLLMFallback();
      }
    } else if (openaiKey) {
      console.log(`[${jobId}]    Using OpenAI Whisper API...`);
      // node-fetch's default export never carried FormData, so this always
      // resolved to the global (undici) implementation on Node 18+.
      const FormData = global.FormData;
      const formData = new FormData();
      formData.append('file', createReadStream(audioPath));
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities[]', 'word');

      const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}` },
        body: formData,
      });

      if (!whisperResponse.ok) {
        throw new Error(`Whisper API error: ${whisperResponse.status}`);
      }

      const whisperResult: any = await whisperResponse.json();
      transcription = {
        text: whisperResult.text || '',
        words: (whisperResult.words || []).map(w => ({
          text: w.word,
          start: w.start,
          end: w.end,
        })),
      };
    } else {
      // Use Gemini as fallback
      transcription = await transcribeWithLLMFallback();
    }

    console.log(`[${jobId}] Transcription complete: ${transcription.text.substring(0, 100)}...`);

    // Clean up audio file
    try { unlinkSync(audioPath); } catch (e) { }

    // Step 2: Generate animation concept (scenes) without rendering
    console.log(`[${jobId}] Step 2: Generating animation concept...`);

    const typePrompts = {
      intro: `Create an engaging INTRO animation that hooks viewers and introduces the video topic.
The intro should:
- Start with an attention-grabbing title or hook
- Tease what viewers will learn/see
- Build excitement for the content
- Be 4-8 seconds (${4 * fps}-${8 * fps} frames at ${fps}fps)`,

      outro: `Create a compelling OUTRO animation that wraps up the video.
The outro should:
- Summarize key takeaways
- Include a call-to-action (subscribe, like, etc.)
- Thank viewers
- Be 5-10 seconds (${5 * fps}-${10 * fps} frames at ${fps}fps)`,

      transition: `Create a smooth TRANSITION animation between sections.
The transition should:
- Be brief and visually interesting
- Match the video's tone
- Be 2-4 seconds (${2 * fps}-${4 * fps} frames at ${fps}fps)`,

      highlight: `Create a HIGHLIGHT animation that emphasizes a key moment.
The highlight should:
- Draw attention to an important point
- Use dynamic motion and colors
- Be 3-6 seconds (${3 * fps}-${6 * fps} frames at ${fps}fps)`,
    };

    // Build time context for the prompt
    const timeContext = hasTimeRange
      ? `\nNOTE: This transcript is from a SPECIFIC SEGMENT of the video (${segmentStart.toFixed(1)}s - ${endTime.toFixed(1)}s, duration: ${segmentDuration.toFixed(1)}s). Create an animation that relates ONLY to what is being discussed in this segment, not the entire video.`
      : '';

    const scenePrompt = `You are a motion graphics designer. Analyze this video transcript and create a contextual ${type} animation concept.

VIDEO TRANSCRIPT:
"${transcription.text}"
${timeContext}

${description ? `USER HINT: "${description}"` : ''}

${typePrompts[type] || typePrompts.intro}

CANVAS: ${width}x${height} (${orientationOf(width, height)}) — compose all layouts for this orientation.

Based on the video content above, return ONLY valid JSON (no markdown) with this structure:
{
  "scenes": [
    {
      "id": "unique-id",
      "type": "title" | "steps" | "features" | "stats" | "text" | "transition" | "gif" | "emoji",
      "duration": <frames at ${fps}fps>,
      "content": {
        "title": "text derived from video content",
        "subtitle": "optional",
        "items": [{"icon": "emoji", "label": "text", "description": "optional"}],
        "stats": [{"value": "number", "label": "text", "numericValue": <integer for counting>}],
        "color": "#hex accent color",
        "backgroundColor": "#hex or null for transparent",
        // For gif scenes - use GIPHY search:
        "gifSearch": "keyword to search for GIF",
        "gifLayout": "fullscreen" | "scattered",
        // For emoji scenes:
        "emojis": [{"emoji": "🔥", "x": 50, "y": 50, "scale": 0.2, "animation": "bounce"}]
      }
    }
  ],
  "backgroundColor": "#0a0a0a",
  "totalDuration": <sum of scene durations>,
  "contentSummary": "brief description of what the video is about",
  "keyTopics": ["topic1", "topic2", "topic3"]
}

Scene type notes:
- "gif": Use "gifSearch" to search GIPHY for GIFs (e.g., "mind blown", "celebration", "thumbs up")
- "emoji": Animated emoji scene with animations (pop, bounce, float, pulse)
- "stats": Use numericValue for counting animation (must be a NUMBER)

IMPORTANT: The animation content should directly relate to the video's actual topic and message.
Use specific terms, concepts, and themes from the transcript.
Feel free to add a GIF scene for reactions or emphasis when appropriate!`;

    let sceneData;
    try {
      const responseText = await generateWithLLM(scenePrompt);
      sceneData = parseLLMJson(responseText);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse AI response:`, parseError);
      throw new Error('Failed to parse AI-generated scene data');
    }

    // Post-process GIF scenes - search GIPHY and inject actual URLs
    const giphyKeyForAnalysis = process.env.GIPHY_API_KEY;
    for (const scene of sceneData.scenes) {
      if (scene.type === 'gif' && scene.content) {
        const { gifSearch, gifSearches } = scene.content;
        const searchTerms = gifSearches || (gifSearch ? [gifSearch] : []);

        if (searchTerms.length > 0 && giphyKeyForAnalysis) {
          console.log(`[${jobId}] 🎬 Fetching GIFs from GIPHY for concept: ${searchTerms.join(', ')}`);
          scene.content.gifs = [];

          for (const term of searchTerms) {
            try {
              const gifs = await searchGiphy(term, 1);
              if (gifs.length > 0) {
                const gif = gifs[0];
                const gifUrl = gif.images?.fixed_height?.url || gif.images?.original?.url;
                if (gifUrl) {
                  scene.content.gifs.push({
                    src: gifUrl,
                    width: parseInt(gif.images?.fixed_height?.width) || 400,
                    height: parseInt(gif.images?.fixed_height?.height) || 300,
                    title: gif.title || term,
                    searchTerm: term,
                  });
                  console.log(`[${jobId}]    ✓ Found GIF for "${term}"`);
                }
              }
            } catch (err) {
              console.log(`[${jobId}]    ✗ GIPHY search failed: ${err.message}`);
            }
          }

          if (!scene.content.gifLayout && scene.content.gifs.length === 1) {
            scene.content.gifLayout = 'fullscreen';
          }
        }
      }
    }

    const animationTotalDuration = sceneData.totalDuration || sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = animationTotalDuration / fps;

    console.log(`[${jobId}] Analysis complete: ${sceneData.scenes.length} scenes, ${durationInSeconds}s total`);
    console.log(`[${jobId}] === ANALYSIS COMPLETE (awaiting approval) ===\n`);

    // Return the concept for user approval (NOT rendered yet)
    return {
      success: true,
      concept: {
        type,
        // fps the scene frame counts were authored for; render-from-concept
        // must render at this fps or the approved duration won't hold
        fps,
        transcript: transcription.text,
        transcriptPreview: transcription.text.substring(0, 500) + (transcription.text.length > 500 ? '...' : ''),
        contentSummary: sceneData.contentSummary,
        keyTopics: sceneData.keyTopics || [],
        scenes: sceneData.scenes,
        totalDuration: animationTotalDuration,
        durationInSeconds,
        backgroundColor: sceneData.backgroundColor,
      },
      videoInfo: {
        filename: videoAsset.filename,
        duration: totalDuration,
        assetId: videoAsset.id,
      },
    };
      },
    });

    sendJobAccepted(res, sessionId, job);

  } catch (error) {
    console.error('Animation analysis error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}

// Render animation from pre-approved concept (skips analysis, uses provided scenes)
async function handleRenderFromConcept(req, res, sessionId) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  try {
    const body = await parseBody(req);
    const { concept } = body;

    if (!concept || !concept.scenes || concept.scenes.length === 0) {
      sendJSON(res, { error: 'concept with scenes is required' }, 400);
      return;
    }

    const { width, height, fps: projectFps } = resolveCompositionSettings(session, body);
    // Scene frame counts were authored at the fps embedded in the concept at
    // analyze time; render at that fps so the approved duration holds.
    const fps = concept.fps || projectFps;

    const job = enqueueJob({
      sessionId,
      kind: 'animation-render',
      lane: 'render',
      run: async (job) => {
    const jobId = randomUUID();
    const assetId = randomUUID();
    const outputPath = join(session.assetsDir, `${assetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-props.json`);

    console.log(`\n[${jobId}] === RENDER FROM APPROVED CONCEPT ===`);
    console.log(`[${jobId}] Type: ${concept.type}, Scenes: ${concept.scenes.length}`);

    const sceneData = {
      scenes: concept.scenes,
      backgroundColor: concept.backgroundColor || '#0a0a0a',
      totalDuration: concept.totalDuration,
      contentSummary: concept.contentSummary,
      keyTopics: concept.keyTopics,
      fps,
    };

    // Post-process GIF scenes - search GIPHY for any unresolved gif searches
    const giphyKeyForRender = process.env.GIPHY_API_KEY;
    for (const scene of sceneData.scenes) {
      if (scene.type === 'gif' && scene.content) {
        const { gifSearch, gifSearches, gifs } = scene.content;
        const searchTerms = gifSearches || (gifSearch ? [gifSearch] : []);

        // Only search if we have search terms but no resolved GIFs
        if (searchTerms.length > 0 && (!gifs || gifs.length === 0) && giphyKeyForRender) {
          console.log(`[${jobId}] 🎬 Resolving GIPHY searches: ${searchTerms.join(', ')}`);
          scene.content.gifs = [];

          for (const term of searchTerms) {
            try {
              const gifsResult = await searchGiphy(term, 1);
              if (gifsResult.length > 0) {
                const gif = gifsResult[0];
                const gifUrl = gif.images?.fixed_height?.url || gif.images?.original?.url;
                if (gifUrl) {
                  scene.content.gifs.push({
                    src: gifUrl,
                    width: parseInt(gif.images?.fixed_height?.width) || 400,
                    height: parseInt(gif.images?.fixed_height?.height) || 300,
                    title: gif.title || term,
                    searchTerm: term,
                  });
                  console.log(`[${jobId}]    ✓ Resolved GIF for "${term}"`);
                }
              }
            } catch (err) {
              console.log(`[${jobId}]    ✗ GIPHY search failed: ${err.message}`);
            }
          }

          if (!scene.content.gifLayout && scene.content.gifs.length === 1) {
            scene.content.gifLayout = 'fullscreen';
          }
        }
      }
    }

    // Save scene data for future editing (reusable path based on asset ID)
    const sceneDataPath = join(session.dir, `${assetId}-scenes.json`);
    writeJsonAtomic(sceneDataPath, sceneData);
    console.log(`[${jobId}] Scene data saved to ${sceneDataPath} for future editing`);

    const animationTotalDuration = sceneData.totalDuration || sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = animationTotalDuration / fps;

    // Write props to JSON file for Remotion
    writeFileSync(propsPath, JSON.stringify(sceneData, null, 2));
    console.log(`[${jobId}] Props written to ${propsPath}`);
    console.log(`[${jobId}] Scene data:`, JSON.stringify(sceneData, null, 2));

    // Render with Remotion Node API
    console.log(`[${jobId}] Rendering with Remotion...`);

    await renderDynamicInWorker(job, {
      sceneData,
      outputPath,
      width,
      height,
      fps,
      logLevel: 'warn',
      onProgress: makeRenderProgressUpdater(job),
    });

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Clean up props file
    try { unlinkSync(propsPath); } catch (e) { }

    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    // Create asset entry with scene data for future editing
    const asset = {
      id: assetId,
      type: 'video',
      filename: `${concept.type}-animation-${Date.now()}.mp4`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: durationInSeconds,
      size: stats.size,
      width,
      height,
      fps,
      createdAt: Date.now(),
      aiGenerated: true,
      contextual: true,
      animationType: concept.type,
      contentSummary: concept.contentSummary,
      sceneCount: concept.scenes.length,
      sceneDataPath, // Store path to scene data for re-editing
      sceneData, // Also keep in memory for quick access
    };

    session.assets.set(assetId, asset);
    saveAssetMetadata(session); // Persist AI-generated flag to disk

    console.log(`[${jobId}] Animation rendered: ${assetId} (${durationInSeconds}s)`);
    console.log(`[${jobId}] === RENDER COMPLETE ===\n`);

    return {
      success: true,
      assetId,
      filename: asset.filename,
      duration: durationInSeconds,
      type: concept.type,
      sceneCount: concept.scenes.length,
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
    };
      },
    });

    sendJobAccepted(res, sessionId, job);

  } catch (error) {
    console.error('Render from concept error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}

// Generate kinetic typography animation from video transcript
// Transcribes video, identifies key phrases, creates animated text scenes synced to audio

export const animationConceptRoutes: SessionRoute[] = [
  { method: 'POST', action: 'analyze-for-animation', handler: handleAnalyzeForAnimation },
  { method: 'POST', action: 'render-from-concept', handler: handleRenderFromConcept },
];
