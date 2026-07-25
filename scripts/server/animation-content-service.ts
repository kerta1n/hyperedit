import { createReadStream, existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { renderDynamicAnimation } from '../remotion-core/render.js';
import { TEMP_DIR } from './server-config.ts';
import { parseBody, sendJSON } from './http-helpers.ts';
import { orientationOf, requireSession, resolveCompositionSettings, saveAssetMetadata, writeJsonAtomic } from './session-store.ts';
import { getVideoDuration, runFFmpeg, runFFmpegProbe } from './ffmpeg-helpers.ts';
import { checkLocalWhisper, runLocalWhisper } from './whisper-helpers.ts';
import { generateWithLLM, hasLLMProvider, parseLLMJson, transcribeAudioWithLLM } from './llm-gateway.ts';
import { getOrTranscribeVideo } from './transcription-service.ts';

import type { SessionRoute } from './route-table.ts';

// Content-derived animation lanes that author scenes from what the video
// says: batch generation across the timeline, kinetic-typography from the
// transcript, and content-aware contextual animation.

// Generate batch animations across the timeline based on video content analysis
async function handleGenerateBatchAnimations(req, res, sessionId) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  if (!hasLLMProvider()) {
    sendJSON(res, { error: 'No LLM provider configured. Set GEMINI_API_KEY or OPENAI_API_BASE_URL in .dev.vars' }, 500);
    return;
  }

  try {
    const body = await parseBody(req);
    const { count = 5 } = body;
    const { fps, width, height } = resolveCompositionSettings(session, body);

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === GENERATE BATCH ANIMATIONS ===`);
    console.log(`[${jobId}] Requested count: ${count}`);

    // Explicit target only — library-order guessing is nondeterministic after restarts
    if (!body.assetId) {
      sendJSON(res, {
        error: 'assetId is required',
        hint: 'Pass the id of the video asset to transcribe; GET /session/:id/assets lists assets.',
      }, 400);
      return;
    }
    const videoAsset = session.assets.get(body.assetId);
    if (!videoAsset || videoAsset.type !== 'video') {
      sendJSON(res, {
        error: `No video asset with id ${body.assetId} in session`,
        hint: 'GET /session/:id/assets lists available assets.',
      }, 400);
      return;
    }

    console.log(`[${jobId}] Using video: ${videoAsset.filename} (${videoAsset.duration}s)`);

    // Step 1: Get or create transcription
    console.log(`[${jobId}] Step 1: Getting video transcription...`);
    const transcription = await getOrTranscribeVideo(session, videoAsset, jobId);

    if (!transcription.text) {
      sendJSON(res, { error: 'Could not transcribe video' }, 400);
      return;
    }

    console.log(`[${jobId}] Transcription: ${transcription.text.substring(0, 200)}...`);

    // Step 2: Use Gemini to plan animations across the video
    console.log(`[${jobId}] Step 2: Planning ${count} animations with AI...`);

    const planPrompt = `You are a video editor planning motion graphics animations for a video. Analyze this transcript and plan exactly ${count} animations that would enhance the video.

VIDEO TRANSCRIPT:
"${transcription.text}"

VIDEO DURATION: ${videoAsset.duration} seconds

WORD TIMESTAMPS (for timing reference):
${transcription.words?.slice(0, 100).map(w => `[${w.start.toFixed(1)}s] ${w.text}`).join(' ') || 'Not available'}

Plan exactly ${count} animations. Each should:
1. Be placed at a strategic moment in the video (intro, key points, transitions, outro)
2. Have a specific purpose (introduce topic, highlight key point, transition, call-to-action, etc.)
3. Be relevant to the content being discussed at that timestamp

Return ONLY valid JSON (no markdown):
{
  "animations": [
    {
      "type": "intro" | "highlight" | "transition" | "callout" | "outro",
      "startTime": <seconds where animation should appear>,
      "duration": <animation duration in seconds, typically 3-5>,
      "title": "<short title for the animation>",
      "description": "<detailed description of what the animation should show, including specific text, colors, style>",
      "relevantContent": "<what the video is discussing at this point>"
    }
  ]
}

Guidelines:
- First animation should typically be an intro (startTime: 0)
- Last animation could be an outro or call-to-action
- Space animations throughout the video, not clustered together
- Each animation should enhance understanding or engagement
- Be specific about visual style, colors, and text content`;

    let animationPlan;
    try {
      const planText = await generateWithLLM(planPrompt, { responseMimeType: 'application/json' });
      animationPlan = parseLLMJson(planText);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse animation plan:`, parseError);
      throw new Error('Failed to parse AI animation plan');
    }

    console.log(`[${jobId}] Planned ${animationPlan.animations.length} animations`);
    animationPlan.animations.forEach((a, i) => {
      console.log(`[${jobId}]   ${i + 1}. ${a.type} at ${a.startTime}s: ${a.title}`);
    });

    // Step 3: Generate each animation
    console.log(`[${jobId}] Step 3: Generating animations...`);
    const generatedAnimations = [];

    for (let i = 0; i < animationPlan.animations.length; i++) {
      const plan = animationPlan.animations[i];
      console.log(`[${jobId}] Generating animation ${i + 1}/${animationPlan.animations.length}: ${plan.title}`);

      const assetId = randomUUID();
      const outputPath = join(session.assetsDir, `${assetId}.mp4`);
      const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
      const propsPath = join(session.dir, `${jobId}-batch-${i}-props.json`);
      const sceneDataPath = join(session.dir, `${assetId}-scenes.json`);

      // Generate scene data with LLM
      const scenePromptText = `Create a Remotion animation for this video moment.

ANIMATION TYPE: ${plan.type}
TITLE: ${plan.title}
DESCRIPTION: ${plan.description}
CONTEXT: ${plan.relevantContent}
DURATION: ${plan.duration} seconds (${plan.duration * fps} frames)
CANVAS: ${width}x${height} (${orientationOf(width, height)}) — compose layouts for this orientation

Generate a scene-based animation. Return ONLY valid JSON:
{
  "scenes": [
    {
      "id": "scene-1",
      "type": "title" | "bullets" | "stats" | "quote" | "callToAction" | "transition",
      "duration": <frames>,
      "content": {
        "title": "optional title text",
        "subtitle": "optional subtitle",
        "items": [{"label": "item text", "icon": "optional emoji"}],
        "stats": [{"value": "100%", "label": "stat name"}],
        "quote": "quote text",
        "author": "quote author",
        "buttonText": "CTA text",
        "backgroundColor": "#hex",
        "textColor": "#hex",
        "accentColor": "#hex"
      }
    }
  ],
  "totalDuration": <total frames>,
  "backgroundColor": "#1a1a2e"
}

Make it visually engaging with good color choices. Use 2-4 scenes for variety.`;

      let sceneData;
      try {
        const sceneText = await generateWithLLM(scenePromptText);
        sceneData = parseLLMJson(sceneText);
      } catch (parseError) {
        console.error(`[${jobId}] Failed to parse scene data for animation ${i + 1}, using fallback`);
        // Create a simple fallback animation
        sceneData = {
          scenes: [{
            id: 'scene-1',
            type: 'title',
            duration: plan.duration * fps,
            content: {
              title: plan.title,
              subtitle: plan.description.substring(0, 50),
              backgroundColor: '#1a1a2e',
              textColor: '#ffffff',
              accentColor: '#6366f1'
            }
          }],
          totalDuration: plan.duration * fps,
          backgroundColor: '#1a1a2e'
        };
      }

      // Save scene data (fps-annotated so edits re-render at the authoring fps)
      sceneData.fps = fps;
      writeJsonAtomic(sceneDataPath, sceneData);
      writeFileSync(propsPath, JSON.stringify(sceneData, null, 2));

      const totalDuration = sceneData.totalDuration || sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
      const durationInSeconds = totalDuration / fps;

      // Render with Remotion Node API
      await renderDynamicAnimation({
        sceneData,
        outputPath,
        width,
        height,
        fps,
        logLevel: 'warn',
      });

      // Generate thumbnail
      try {
        await runFFmpeg([
          '-y', '-i', outputPath,
          '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
          '-frames:v', '1',
          thumbPath
        ], jobId);
      } catch (e) {
        console.warn(`[${jobId}] Thumbnail failed for animation ${i + 1}`);
      }

      // Clean up props file
      try { unlinkSync(propsPath); } catch (e) { }

      const { stat } = await import('fs/promises');
      const stats = await stat(outputPath);

      // Create asset entry
      const asset = {
        id: assetId,
        type: 'video',
        filename: `${plan.type}-${plan.title.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 20)}.mp4`,
        path: outputPath,
        thumbPath: existsSync(thumbPath) ? thumbPath : null,
        duration: durationInSeconds,
        size: stats.size,
        width,
        height,
        fps,
        createdAt: Date.now(),
        aiGenerated: true,
        sceneData,
        sceneDataPath,
        description: plan.description,
      };

      session.assets.set(assetId, asset);

      generatedAnimations.push({
        assetId,
        filename: asset.filename,
        duration: durationInSeconds,
        startTime: plan.startTime,
        type: plan.type,
        title: plan.title,
        thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
      });

      console.log(`[${jobId}] ✓ Animation ${i + 1} complete: ${asset.filename}`);
    }

    saveAssetMetadata(session); // Persist asset metadata to disk

    console.log(`[${jobId}] === BATCH GENERATION COMPLETE ===`);
    console.log(`[${jobId}] Generated ${generatedAnimations.length} animations\n`);

    sendJSON(res, {
      success: true,
      animations: generatedAnimations,
      videoDuration: videoAsset.duration,
    });

  } catch (error) {
    console.error('Batch animation generation error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}

// Analyze video for animation concept (no rendering - for approval workflow)
async function handleGenerateTranscriptAnimation(req, res, sessionId) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  if (!hasLLMProvider()) {
    sendJSON(res, { error: 'No LLM provider configured. Set GEMINI_API_KEY or OPENAI_API_BASE_URL in .dev.vars' }, 500);
    return;
  }

  try {
    const body = await parseBody(req);
    const { fps, width, height } = resolveCompositionSettings(session, body);

    // Find the first video asset
    let videoAsset = null;
    for (const asset of session.assets.values()) {
      if (asset.type === 'video') {
        videoAsset = asset;
        break;
      }
    }

    if (!videoAsset) {
      sendJSON(res, { error: 'No video asset found in session' }, 400);
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === GENERATE TRANSCRIPT ANIMATION ===`);
    console.log(`[${jobId}] Video: ${videoAsset.filename}`);

    // Step 1: Transcribe the video with word-level timestamps
    console.log(`[${jobId}] Step 1: Transcribing video...`);
    const audioPath = join(TEMP_DIR, `${jobId}-transcript-audio.mp3`);
    const totalDuration = await getVideoDuration(videoAsset.path);

    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vn', '-acodec', 'libmp3lame',
      '-ab', '64k', '-ar', '16000', '-ac', '1',
      audioPath
    ], jobId);

    // Check transcription method
    const hasLocalWhisper = await checkLocalWhisper();
    const openaiKey = process.env.OPENAI_API_KEY;

    // Fallback transcription via the LLM provider's audio understanding
    const transcribeWithLLMForAnimation = async () =>
      transcribeAudioWithLLM(audioPath, totalDuration, jobId);

    let transcription;
    if (hasLocalWhisper) {
      try {
        console.log(`[${jobId}]    Using local Whisper...`);
        transcription = await runLocalWhisper(audioPath, jobId);
      } catch (whisperError) {
        console.log(`[${jobId}]    Local Whisper failed: ${whisperError.message}`);
        console.log(`[${jobId}]    Falling back to Gemini...`);
        transcription = await transcribeWithLLMForAnimation();
      }
    } else if (openaiKey) {
      console.log(`[${jobId}]    Using OpenAI Whisper API...`);
      const audioBuffer = readFileSync(audioPath);
      const FormData = (await import('formdata-node')).FormData;
      const { Blob } = await import('buffer');

      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities[]', 'word');

      const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiKey}` },
        body: formData as any,
      });

      if (!whisperResponse.ok) {
        throw new Error(`Whisper API error: ${whisperResponse.status}`);
      }

      const whisperResult: any = await whisperResponse.json();
      transcription = {
        text: whisperResult.text || '',
        words: (whisperResult.words || []).map(w => ({
          text: w.word || '',
          start: w.start || 0,
          end: w.end || 0,
        }))
      };
    } else {
      transcription = await transcribeWithLLMForAnimation();
    }

    try { unlinkSync(audioPath); } catch { }

    console.log(`[${jobId}]    Transcript: "${transcription.text.substring(0, 100)}..."`);
    console.log(`[${jobId}]    Words: ${transcription.words?.length || 0}`);

    // Step 2: Use LLM to identify key phrases for animation
    console.log(`[${jobId}] Step 2: Identifying key phrases...`);

    const analysisPrompt = `Analyze this video transcript and identify 5-8 KEY PHRASES that would make great kinetic typography animations. These should be:
- Important or impactful statements
- Keywords or product names
- Emotional or emphatic moments
- Key points the speaker is making

Transcript: "${transcription.text}"

Word timestamps: ${JSON.stringify(transcription.words?.slice(0, 100) || [])}
(Total duration: ${totalDuration}s)

Return JSON array of phrases to animate:
[
  {
    "phrase": "the exact phrase from transcript",
    "startTime": 1.5,
    "endTime": 3.2,
    "emphasis": "high|medium|low",
    "style": "bold|explosive|subtle|typewriter",
    "reason": "why this phrase is important"
  }
]

Pick phrases that are spread throughout the video. Each phrase should be 2-6 words.`;

    let keyPhrases = [];
    try {
      const respText = await generateWithLLM(analysisPrompt, { responseMimeType: 'application/json' });
      const parsed = parseLLMJson(respText);
      keyPhrases = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error(`[${jobId}] Failed to parse key phrases:`, e.message);
    }

    const keyPhraseFallback = keyPhrases.length === 0;
    if (keyPhraseFallback) {
      console.warn(`[${jobId}] LLM key-phrase extraction unusable — falling back to transcript chunking (emphasis/styling degraded)`);
      // Fallback: create basic phrases from transcript chunks
      const words = transcription.words || [];
      const chunkSize = Math.ceil(words.length / 6);
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize);
        if (chunk.length > 0) {
          keyPhrases.push({
            phrase: chunk.map(w => w.text).join(' ').trim(),
            startTime: chunk[0].start,
            endTime: chunk[chunk.length - 1].end,
            emphasis: 'medium',
            style: 'typewriter'
          });
        }
      }
    }

    console.log(`[${jobId}]    Found ${keyPhrases.length} key phrases`);

    // Step 3: Generate Remotion scenes for each phrase
    console.log(`[${jobId}] Step 3: Generating animation scenes...`);
    const scenes = keyPhrases.map((phrase, index) => {
      const duration = Math.max(2 * fps, Math.round((phrase.endTime - phrase.startTime + 1) * fps)); // At least 2 seconds

      // Map emphasis to visual style
      const colors = {
        high: '#f97316', // orange
        medium: '#3b82f6', // blue
        low: '#22c55e', // green
      };

      return {
        id: `text-${index}`,
        type: 'text',
        duration,
        content: {
          title: phrase.phrase.toUpperCase(),
          subtitle: null,
          color: colors[phrase.emphasis] || '#ffffff',
          backgroundColor: '#0a0a0a',
          style: phrase.style || 'typewriter',
        }
      };
    });

    // Calculate total animation duration
    const animationTotalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = animationTotalDuration / fps;

    console.log(`[${jobId}]    Total animation: ${animationTotalDuration} frames (${durationInSeconds}s)`);

    // Step 4: Render with Remotion
    console.log(`[${jobId}] Step 4: Rendering with Remotion...`);

    const assetId = randomUUID();
    const outputPath = join(session.assetsDir, `${assetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-transcript-props.json`);

    const sceneData = {
      scenes,
      backgroundColor: '#0a0a0a',
      totalDuration: animationTotalDuration,
      contentSummary: `Kinetic typography animation from transcript: "${transcription.text.substring(0, 100)}..."`,
      keyTopics: keyPhrases.map(p => p.phrase),
      fps,
    };

    // Save scene data for future editing (persistent path based on asset ID)
    const sceneDataPath = join(session.dir, `${assetId}-scenes.json`);
    writeJsonAtomic(sceneDataPath, sceneData);
    console.log(`[${jobId}] Scene data saved to ${sceneDataPath} for future editing`);

    writeFileSync(propsPath, JSON.stringify(sceneData, null, 2));

    // Render with Remotion Node API
    await renderDynamicAnimation({
      sceneData,
      outputPath,
      width,
      height,
      fps,
      logLevel: 'warn',
    });

    // Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    // Create asset entry with scene data for future editing
    const asset = {
      id: assetId,
      type: 'video',
      filename: `transcript-animation-${Date.now()}.mp4`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: durationInSeconds,
      size: stats.size,
      width,
      height,
      fps,
      createdAt: Date.now(),
      aiGenerated: true,
      transcriptAnimation: true,
      phraseCount: keyPhrases.length,
      sceneCount: scenes.length,
      sceneDataPath, // Store path to scene data for re-editing
      sceneData, // Also keep in memory for quick access
    };

    session.assets.set(assetId, asset);
    saveAssetMetadata(session); // Persist AI-generated flag to disk

    console.log(`[${jobId}] Transcript animation created: ${assetId}`);
    console.log(`[${jobId}] === TRANSCRIPT ANIMATION COMPLETE ===\n`);

    sendJSON(res, {
      success: true,
      assetId,
      filename: asset.filename,
      duration: durationInSeconds,
      phraseCount: keyPhrases.length,
      keyPhraseFallback,
      phrases: keyPhrases.map(p => p.phrase),
      thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
    });

  } catch (error) {
    console.error('Transcript animation error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}

// Generate contextual animation based on video content
// This transcribes the video first, understands what it's about, then generates relevant animation
async function handleGenerateContextualAnimation(req, res, sessionId) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  if (!hasLLMProvider()) {
    sendJSON(res, { error: 'No LLM provider configured. Set GEMINI_API_KEY or OPENAI_API_BASE_URL in .dev.vars' }, 500);
    return;
  }

  try {
    const body = await parseBody(req);
    const { assetId, type = 'intro', description } = body;
    const { fps, width, height } = resolveCompositionSettings(session, body);

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

    const jobId = randomUUID();
    const outputAssetId = randomUUID();
    const outputPath = join(session.assetsDir, `${outputAssetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${outputAssetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-props.json`);
    const audioPath = join(TEMP_DIR, `${jobId}-audio.mp3`);

    console.log(`\n[${jobId}] === GENERATE CONTEXTUAL ${type.toUpperCase()} ANIMATION ===`);
    console.log(`[${jobId}] Analyzing video: ${videoAsset.filename}`);
    console.log(`[${jobId}] Type: ${type}, Description hint: ${description || 'none'}`);

    // Step 1: Transcribe the video to understand content
    console.log(`[${jobId}] Step 1: Transcribing video...`);

    // Extract audio from video
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vn', '-acodec', 'libmp3lame', '-ar', '16000', '-ac', '1', '-q:a', '9',
      audioPath
    ], jobId);

    // Get video duration
    const durationOutput = await runFFmpegProbe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoAsset.path
    ], jobId);
    const totalDuration = parseFloat(durationOutput.trim()) || 60;

    let transcription;
    const hasLocalWhisper = await checkLocalWhisper();
    const openaiKey = process.env.OPENAI_API_KEY;

    // Fallback transcription via the LLM provider's audio understanding
    const transcribeWithLLMContextual = async () =>
      transcribeAudioWithLLM(audioPath, totalDuration.toFixed(1), jobId, { wordTimestamps: false });

    if (hasLocalWhisper) {
      try {
        console.log(`[${jobId}]    Using local Whisper...`);
        transcription = await runLocalWhisper(audioPath, jobId);
      } catch (whisperError) {
        console.log(`[${jobId}]    Local Whisper failed: ${whisperError.message}`);
        console.log(`[${jobId}]    Falling back to Gemini...`);
        transcription = await transcribeWithLLMContextual();
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
        body: formData as any,
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
      transcription = await transcribeWithLLMContextual();
    }

    console.log(`[${jobId}] Transcription complete: ${transcription.text.substring(0, 100)}...`);

    // Clean up audio file
    try { unlinkSync(audioPath); } catch (e) { }

    // Step 2: Analyze content and generate contextual scene data
    console.log(`[${jobId}] Step 2: Analyzing content and generating scenes...`);

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

    const scenePrompt = `You are a motion graphics designer. Analyze this video transcript and create a contextual ${type} animation.

VIDEO TRANSCRIPT:
"${transcription.text}"

${description ? `USER HINT: "${description}"` : ''}

${typePrompts[type] || typePrompts.intro}

CANVAS: ${width}x${height} (${orientationOf(width, height)}) — compose all layouts for this orientation.

Based on the video content above, return ONLY valid JSON (no markdown) with this structure:
{
  "scenes": [
    {
      "id": "unique-id",
      "type": "title" | "steps" | "features" | "stats" | "text" | "transition",
      "duration": <frames at ${fps}fps>,
      "content": {
        "title": "text derived from video content",
        "subtitle": "optional",
        "items": [{"icon": "emoji", "label": "text", "description": "optional"}],
        "stats": [{"value": "number", "label": "text"}],
        "color": "#hex accent color",
        "backgroundColor": "#hex or null for transparent"
      }
    }
  ],
  "backgroundColor": "#0a0a0a",
  "totalDuration": <sum of scene durations>,
  "contentSummary": "brief description of what the video is about"
}

IMPORTANT: The animation content should directly relate to the video's actual topic and message.
Use specific terms, concepts, and themes from the transcript.`;

    let sceneData;
    try {
      const responseText = await generateWithLLM(scenePrompt);
      sceneData = parseLLMJson(responseText);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse AI response:`, parseError);
      throw new Error('Failed to parse AI-generated scene data');
    }

    console.log(`[${jobId}] Generated ${sceneData.scenes.length} scenes for ${type}`);
    console.log(`[${jobId}] Content summary: ${sceneData.contentSummary || 'N/A'}`);

    // Log camera movements for debugging
    const scenesWithCamera = sceneData.scenes.filter(s => s.content?.camera?.type);
    if (scenesWithCamera.length > 0) {
      console.log(`[${jobId}] 🎥 Camera movements: ${scenesWithCamera.map(s => `${s.id}: ${s.content.camera.type}`).join(', ')}`);
    } else {
      console.log(`[${jobId}] ⚠️ No camera movements in any scene`);
    }

    const animationTotalDuration = sceneData.totalDuration || sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = animationTotalDuration / fps;

    // Annotate the fps the scene frame counts are anchored to (edits re-render at it)
    sceneData.fps = fps;

    // Save scene data for future editing (persistent path based on asset ID)
    const sceneDataPath = join(session.dir, `${outputAssetId}-scenes.json`);
    writeJsonAtomic(sceneDataPath, sceneData);
    console.log(`[${jobId}] Scene data saved to ${sceneDataPath} for future editing`);

    // Step 3: Render with Remotion Node API
    console.log(`[${jobId}] Step 3: Rendering with Remotion...`);

    await renderDynamicAnimation({
      sceneData,
      outputPath,
      width,
      height,
      fps,
      logLevel: 'warn',
    });

    // Step 4: Generate thumbnail
    await runFFmpeg([
      '-y', '-i', outputPath,
      '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      thumbPath
    ], jobId);

    // Clean up
    try { unlinkSync(propsPath); } catch (e) { }

    const { stat } = await import('fs/promises');
    const stats = await stat(outputPath);

    // Create asset entry
    // Create asset entry with scene data for future editing
    const asset = {
      id: outputAssetId,
      type: 'video',
      filename: `${type}-animation-${Date.now()}.mp4`,
      path: outputPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: durationInSeconds,
      size: stats.size,
      width,
      height,
      fps,
      createdAt: Date.now(),
      // Metadata
      aiGenerated: true,
      contextual: true,
      animationType: type,
      contentSummary: sceneData.contentSummary,
      sceneCount: sceneData.scenes.length,
      sourceAssetId: videoAsset.id,
      sceneDataPath, // Store path to scene data for re-editing
      sceneData, // Also keep in memory for quick access
    };

    session.assets.set(outputAssetId, asset);
    saveAssetMetadata(session); // Persist AI-generated flag to disk

    console.log(`[${jobId}] Contextual ${type} animation rendered: ${outputAssetId} (${durationInSeconds}s)`);
    console.log(`[${jobId}] === CONTEXTUAL ANIMATION COMPLETE ===\n`);

    sendJSON(res, {
      success: true,
      assetId: outputAssetId,
      filename: asset.filename,
      duration: durationInSeconds,
      type,
      contentSummary: sceneData.contentSummary,
      sceneCount: sceneData.scenes.length,
      thumbnailUrl: `/session/${sessionId}/assets/${outputAssetId}/thumbnail`,
      streamUrl: `/session/${sessionId}/assets/${outputAssetId}/stream`,
    });

  } catch (error) {
    console.error('Contextual animation generation error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}





export const animationContentRoutes: SessionRoute[] = [
  { method: 'POST', action: 'generate-batch-animations', handler: handleGenerateBatchAnimations },
  { method: 'POST', action: 'generate-transcript-animation', handler: handleGenerateTranscriptAnimation },
  { method: 'POST', action: 'generate-contextual-animation', handler: handleGenerateContextualAnimation },
];
