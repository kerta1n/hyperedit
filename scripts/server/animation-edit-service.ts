import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { renderDynamicInWorker } from './render-client.ts';

import { parseBody, sendJSON, sendJobAccepted } from './http-helpers.ts';
import { makeRenderProgressUpdater } from './job-store.ts';
import { enqueueJob } from './job-queue.ts';
import { orientationOf, requireSession, saveAssetMetadata, writeJsonAtomic } from './session-store.ts';
import { runFFmpeg } from './ffmpeg-helpers.ts';
import { generateWithLLM, hasLLMProvider, parseLLMJson } from './llm-gateway.ts';
import { getOrTranscribeVideo } from './transcription-service.ts';

import type { SessionRoute } from './route-table.ts';

// In-place editing of an existing generated animation: same asset id,
// stored scene data + stored fps/dims re-rendered after LLM modification.

// Edit an existing animation with a new prompt
// Takes the original scene data and modifies it based on the prompt
async function handleEditAnimation(req, res, sessionId) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  if (!hasLLMProvider()) {
    sendJSON(res, { error: 'No LLM provider configured. Set GEMINI_API_KEY or OPENAI_API_BASE_URL in .dev.vars' }, 500);
    return;
  }

  try {
    const body = await parseBody(req);
    const { assetId, editPrompt, assets: availableAssets, v1Context } = body;

    if (!assetId || !editPrompt) {
      sendJSON(res, { error: 'assetId and editPrompt are required' }, 400);
      return;
    }

    // Get the original animation asset
    const originalAsset = session.assets.get(assetId);
    if (!originalAsset) {
      sendJSON(res, { error: 'Animation asset not found' }, 404);
      return;
    }

    if (!originalAsset.aiGenerated) {
      sendJSON(res, { error: 'Asset is not an AI-generated animation' }, 400);
      return;
    }

    // Get the original scene data
    let originalSceneData = originalAsset.sceneData;
    if (!originalSceneData && originalAsset.sceneDataPath && existsSync(originalAsset.sceneDataPath)) {
      originalSceneData = JSON.parse(readFileSync(originalAsset.sceneDataPath, 'utf-8'));
    }

    if (!originalSceneData) {
      sendJSON(res, { error: 'Original scene data not found - cannot edit this animation' }, 400);
      return;
    }

    // Re-render at the fps/dimensions the animation was authored with — scene
    // frame counts are fps-anchored, so a different fps rescales the animation's
    // wall-clock length. Legacy animations (no stored fps) were all rendered at 30.
    const fps = originalAsset.fps || originalSceneData.fps || 30;
    const width = originalAsset.width || 1920;
    const height = originalAsset.height || 1080;

    const job = enqueueJob({
      sessionId,
      kind: 'animation',
      lane: 'llm',
      run: async (job) => {
    const jobId = randomUUID();
    // IMPORTANT: Reuse the same asset ID to replace in-place (no asset creep)
    const outputPath = originalAsset.path; // Overwrite existing video file
    const thumbPath = originalAsset.thumbPath || join(session.assetsDir, `${assetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-props.json`);
    // Reuse existing scene data path or create one with original asset ID
    const existingSceneDataPath = originalAsset.sceneDataPath || join(session.dir, `${assetId}-scenes.json`);

    console.log(`\n[${jobId}] ========================================`);
    console.log(`[${jobId}] === EDIT AI ANIMATION (IN-PLACE) ===`);
    console.log(`[${jobId}] ========================================`);
    console.log(`[${jobId}] IMPORTANT: Reusing SAME asset ID: ${assetId}`);
    console.log(`[${jobId}] Output path (overwriting): ${outputPath}`);
    console.log(`[${jobId}] Edit prompt: ${editPrompt}`);
    console.log(`[${jobId}] Original scene count: ${originalSceneData.scenes?.length || 0}`);
    console.log(`[${jobId}] Original scenes: ${originalSceneData.scenes?.map(s => s.type).join(', ') || 'none'}`);
    console.log(`[${jobId}] Original scene data being passed to Gemini:`);
    console.log(JSON.stringify(originalSceneData, null, 2));
    if (v1Context) {
      console.log(`[${jobId}] V1 context: ${v1Context.filename} (${v1Context.type})`);
    }

    // Build transcript context from source video if available
    // Try V1 context first, but fall back to any non-AI-generated video in session
    let transcriptContext = '';
    let sourceVideoAsset = null;

    // First, try the V1 clip if it's a real video (not AI-generated animation)
    if (v1Context && v1Context.assetId && v1Context.type === 'video') {
      const v1VideoAsset = session.assets.get(v1Context.assetId);
      if (v1VideoAsset && v1VideoAsset.type === 'video' && !v1VideoAsset.aiGenerated) {
        sourceVideoAsset = v1VideoAsset;
        console.log(`[${jobId}] 📝 Using V1 source video for transcript: ${v1VideoAsset.filename}`);
      }
    }

    // If V1 is an animation, find any source video in the session
    if (!sourceVideoAsset) {
      for (const asset of session.assets.values()) {
        if (asset.type === 'video' && !asset.aiGenerated) {
          sourceVideoAsset = asset;
          console.log(`[${jobId}] 📝 Using session source video for transcript: ${asset.filename}`);
          break;
        }
      }
    }

    // Fetch transcript from the source video
    if (sourceVideoAsset) {
      try {
        const transcription = await getOrTranscribeVideo(session, sourceVideoAsset, jobId);
        if (transcription.text) {
          // Get first 1500 chars of transcript for context
          const transcriptText = transcription.text.substring(0, 1500);
          transcriptContext = `

VIDEO TRANSCRIPT CONTEXT (what's being said in the video "${sourceVideoAsset.filename}"):
"${transcriptText}"${transcription.text.length > 1500 ? '...' : ''}

This is what the viewer is hearing. Use this context to make the animation content relevant and synchronized with the video's message. Consider:
- Key topics and themes being discussed
- Important words, phrases, or concepts that could be visualized
- The tone and style of the content (educational, entertaining, promotional, etc.)
- Specific facts, numbers, or quotes that could be highlighted`;
          console.log(`[${jobId}] ✅ Transcript context added (${transcriptText.length} chars)`);
        }
      } catch (transcriptError) {
        console.log(`[${jobId}] ⚠️ Could not get transcript: ${transcriptError.message}`);
        // Continue without transcript - not a fatal error
      }
    } else {
      console.log(`[${jobId}] ℹ️ No source video found for transcript context`);
    }

    // Build asset context for Gemini
    let assetContext = '';

    // Include V1 context if provided (primary clip in the edit tab)
    if (v1Context) {
      assetContext += `\n\nPRIMARY V1 CLIP CONTEXT (currently on the timeline):
- ${v1Context.type}: "${v1Context.filename}" (id: ${v1Context.assetId})${v1Context.duration ? `, duration: ${v1Context.duration}s` : ''}
This clip is currently being used in the animation timeline. You can reference it for visual coherence or incorporate it into scenes.`;
    }

    if (availableAssets && availableAssets.length > 0) {
      assetContext += `\n\nAVAILABLE ASSETS you can use in the animation:
${availableAssets.map(a => `- ${a.type}: "${a.filename}" (id: ${a.id})${a.type === 'video' ? `, duration: ${a.duration}s` : ''}`).join('\n')}

To include an asset in a scene, use:
{
  "type": "asset",
  "assetType": "image" | "video",
  "assetId": "<asset id>",
  "duration": <frames>,
  "content": { "title": "optional overlay text" }
}`;
    }

    // Use LLM to modify the scene data
    console.log(`[${jobId}] Modifying scenes with AI...`);

    const prompt = `You are editing an EXISTING Remotion animation. The user wants to make a SPECIFIC change.

## YOUR TASK
Make ONLY the change the user requested. Do NOT change anything else.
Canvas: ${width}x${height} (${orientationOf(width, height)}) — any new scenes must suit this orientation.

## EXISTING ANIMATION (copy this exactly, then apply ONLY the requested change):
${JSON.stringify(originalSceneData, null, 2)}

## USER'S REQUESTED CHANGE:
"${editPrompt}"
${assetContext}${transcriptContext}

## SCENE STRUCTURE REFERENCE:
Scene types and their content properties:
- "title": { "title": "text", "subtitle": "optional text", "color": "#hex", "backgroundColor": "#hex" }
- "text": { "title": "main text", "subtitle": "optional" }
- "steps" / "features": { "title": "optional heading", "items": [{"icon": "emoji", "label": "text", "description": "optional"}] }
- "stats": { "stats": [{"value": "10K+", "label": "Users", "numericValue": 10000}] }
- "transition": { "color": "#hex" }

## ADDING EMOJIS/ICONS:
To add emojis or icons, use scene types that support "items" array:
{
  "type": "features",
  "duration": ${3 * fps},
  "content": {
    "title": "Optional heading",
    "items": [
      {"icon": "💯", "label": "100% Satisfaction"},
      {"icon": "🔥", "label": "Hot Feature"},
      {"icon": "⭐", "label": "5-Star Quality"}
    ]
  }
}

To add a SINGLE large emoji/icon, use a "title" scene with the emoji IN the title:
{
  "type": "title",
  "duration": ${2 * fps},
  "content": {
    "title": "💯",
    "subtitle": "Perfect Score"
  }
}

## CAMERA MOVEMENTS (IMPORTANT - add to make scenes dynamic):
Camera movements make scenes more engaging. Add a "camera" object INSIDE the scene's "content":

Available camera types:
- "zoom-in": Slowly zoom into the content (intensity 0.2-0.4 recommended)
- "zoom-out": Start zoomed in, pull back to reveal
- "pan-left" / "pan-right": Horizontal tracking movement
- "pan-up" / "pan-down": Vertical tilt movement
- "ken-burns": Classic documentary style (slow zoom + subtle pan)
- "shake": Camera shake for energy/impact (use low intensity 0.1-0.2)

EXAMPLE - Complete scene with camera movement:
{
  "id": "intro-scene",
  "type": "title",
  "duration": ${3 * fps},
  "content": {
    "title": "Welcome",
    "subtitle": "Let's get started",
    "color": "#ffffff",
    "backgroundColor": "#1a1a2e",
    "camera": {
      "type": "zoom-in",
      "intensity": 0.3
    }
  }
}

WHEN TO ADD CAMERA MOVEMENTS:
- User says "add zoom", "zoom in", "zoom effect" → Add camera with type "zoom-in"
- User says "add pan", "pan across", "tracking" → Add camera with type "pan-left" or "pan-right"
- User says "ken burns", "documentary style" → Add camera with type "ken-burns"
- User says "shake", "energy", "impact" → Add camera with type "shake" (low intensity)
- User says "make it dynamic", "more movement", "cinematic" → Add camera movements to multiple scenes

## STRICT RULES - FOLLOW EXACTLY:
1. Copy the ENTIRE existing animation structure above
2. Find ONLY the specific element the user mentioned
3. Change ONLY that element - nothing else
4. Keep ALL other text, colors, durations, and properties EXACTLY the same

## EXAMPLES OF CORRECT BEHAVIOR:
- User says "change the title to Hello World" → Only change the title text field, keep all colors/styles
- User says "make it blue" → Only change color values, keep all text the same
- User says "add a new scene" → Keep all existing scenes, append the new one
- User says "add zoom effect" → Add camera object with zoom-in to relevant scenes
- User says "add ken burns to the intro" → Add camera object to intro scene only
- User says "make it more dynamic" → Add camera movements and/or transitions to scenes
- User says "add a 100 emoji" → Add a new scene with type "title" and title "💯" or add to items array
- User says "add fire emoji" → Add "🔥" to title or items depending on context
- User says "visualize the transcript" → Create scenes that highlight key words, phrases, or concepts from the transcript
- User says "add kinetic typography" → Create animated text scenes using words from the transcript

## TRANSCRIPT VISUALIZATION (if transcript context is provided):
When transcript context is available, you can use it to:
- Extract key quotes and display them with "title" or "text" scenes
- Identify statistics or numbers mentioned and create "stats" scenes
- Find key steps or points and create "steps" or "features" scenes
- Pull important concepts and visualize them with relevant emojis/icons
- Create word clouds or key phrase highlights

## EXAMPLES OF WRONG BEHAVIOR (DO NOT DO THIS):
- Changing colors when user only asked about text
- Changing text when user only asked about colors
- Removing or reordering scenes
- Changing durations unless specifically asked

Return ONLY the complete JSON structure with your minimal change applied. No markdown, no explanation.`;

    // Use LLM for better instruction following on edits
    let newSceneData;
    try {
      const responseText = await generateWithLLM(prompt);
      newSceneData = parseLLMJson(responseText);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse AI response:`, parseError);
      throw new Error('Failed to parse AI-modified scene data');
    }

    console.log(`[${jobId}] Modified to ${newSceneData.scenes.length} scenes`);

    // Log camera movements for debugging
    const scenesWithCamera = newSceneData.scenes.filter(s => s.content?.camera?.type);
    if (scenesWithCamera.length > 0) {
      console.log(`[${jobId}] 🎥 Camera movements: ${scenesWithCamera.map(s => `${s.id}: ${s.content.camera.type}`).join(', ')}`);
    } else {
      console.log(`[${jobId}] ⚠️ No camera movements in any scene`);
    }

    const totalDuration = newSceneData.totalDuration || newSceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
    const durationInSeconds = totalDuration / fps;

    // Preserve the fps anchor across edits (the LLM response won't carry it)
    newSceneData.fps = fps;

    // Store scene data for future editing (overwrite existing)
    writeJsonAtomic(existingSceneDataPath, newSceneData);

    // Write props for Remotion
    writeFileSync(propsPath, JSON.stringify(newSceneData, null, 2));
    console.log(`[${jobId}] Props written to ${propsPath}`);

    // Render with Remotion Node API
    console.log(`[${jobId}] Rendering with Remotion...`);

    await renderDynamicInWorker(job, {
      sceneData: newSceneData,
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
      try {
        unlinkSync(propsPath);
      } catch (e) { }

      const { stat } = await import('fs/promises');
      const stats = await stat(outputPath);

      // Update the existing asset entry IN-PLACE (no new asset, prevents asset creep)
      originalAsset.duration = durationInSeconds;
      originalAsset.size = stats.size;
      originalAsset.thumbPath = existsSync(thumbPath) ? thumbPath : null;
      originalAsset.sceneCount = newSceneData.scenes.length;
      originalAsset.sceneDataPath = existingSceneDataPath;
      originalAsset.sceneData = newSceneData;
      originalAsset.fps = fps;
      originalAsset.lastEditedAt = Date.now();
      originalAsset.lastEditPrompt = editPrompt;
      originalAsset.editCount = (originalAsset.editCount || 0) + 1;
      saveAssetMetadata(session);

      console.log(`[${jobId}] ========================================`);
      console.log(`[${jobId}] Animation updated IN-PLACE successfully!`);
      console.log(`[${jobId}] SAME asset ID: ${assetId}`);
      console.log(`[${jobId}] Duration: ${durationInSeconds}s`);
      console.log(`[${jobId}] Edit count: ${originalAsset.editCount}`);
      console.log(`[${jobId}] Total assets in session: ${session.assets.size}`);
      console.log(`[${jobId}] === EDIT COMPLETE ===`);
      console.log(`[${jobId}] ========================================\n`);

      return {
        success: true,
        assetId: assetId,
        filename: originalAsset.filename,
        duration: durationInSeconds,
        sceneCount: newSceneData.scenes.length,
        editCount: originalAsset.editCount,
        thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail?t=${Date.now()}`,
        streamUrl: `/session/${sessionId}/assets/${assetId}/stream?t=${Date.now()}`,
      };
      },
    });

    sendJobAccepted(res, sessionId, job);

  } catch (error) {
    console.error('Animation edit error:', error);
    if (!res.headersSent) {
      sendJSON(res, { error: error.message }, 500);
    }
  }
}


export const animationEditRoutes: SessionRoute[] = [
  { method: 'POST', action: 'edit-animation', handler: handleEditAnimation },
];
