import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { renderDynamicInWorker } from './render-client.ts';
import { PORT } from './server-config.ts';
import { parseBody, sendJSON, sendJobAccepted } from './http-helpers.ts';
import { makeRenderProgressUpdater } from './job-store.ts';
import { enqueueJob } from './job-queue.ts';
import { orientationOf, requireSession, resolveCompositionSettings, saveAssetMetadata, writeJsonAtomic } from './session-store.ts';
import { runFFmpeg } from './ffmpeg-helpers.ts';
import { generateWithLLM, hasLLMProvider, parseLLMJson } from './llm-gateway.ts';
import { getOrTranscribeVideo, getTranscriptSegment } from './transcription-service.ts';
import { searchGiphy } from './giphy-service.ts';
import type { SessionRoute } from './route-table.ts';

// Prompt-driven Remotion animation generation: LLM scene authoring with
// transcript/asset context, post-processing (GIF lookups, stat counting),
// and in-process render.

// Extract numeric value from stat strings like "$10K+", "50%", "2.5M", "10,000", etc.
// Returns { numericValue, prefix, suffix } where numericValue is the number to count TO
function extractNumericValue(valueStr: string) {
  if (!valueStr || typeof valueStr !== 'string') return null;

  const str = valueStr.trim();
  console.log(`[extractNumericValue] Input: "${str}"`);

  // Extract prefix (currency symbols and other leading non-numeric chars)
  let prefix = '';
  const prefixMatch = str.match(/^([£$€¥₹#@~]+)/);
  if (prefixMatch) {
    prefix = prefixMatch[1];
  }

  // Extract the number part (including decimals and commas)
  const numberMatch = str.match(/[\d,]+\.?\d*/);
  if (!numberMatch || numberMatch[0] === '') {
    console.log(`[extractNumericValue] No number found in "${str}"`);
    return null;
  }

  let numericValue = parseFloat(numberMatch[0].replace(/,/g, ''));
  if (isNaN(numericValue)) {
    console.log(`[extractNumericValue] Could not parse number from "${numberMatch[0]}"`);
    return null;
  }

  // Extract suffix - everything after the number
  let suffix = '';
  const numberEndIndex = str.indexOf(numberMatch[0]) + numberMatch[0].length;
  const afterNumber = str.substring(numberEndIndex).trim();
  console.log(`[extractNumericValue] Number: ${numericValue}, After: "${afterNumber}"`);

  // Check for multiplier suffixes and apply them
  if (/^k\b/i.test(afterNumber) || /^thousand/i.test(afterNumber)) {
    numericValue *= 1000;
    suffix = afterNumber.replace(/^k\b/i, '').replace(/^thousand/i, '').trim();
  } else if (/^m\b/i.test(afterNumber) || /^million/i.test(afterNumber)) {
    numericValue *= 1000000;
    suffix = afterNumber.replace(/^m\b/i, '').replace(/^million/i, '').trim();
  } else if (/^b\b/i.test(afterNumber) || /^billion/i.test(afterNumber)) {
    numericValue *= 1000000000;
    suffix = afterNumber.replace(/^b\b/i, '').replace(/^billion/i, '').trim();
  } else {
    suffix = afterNumber;
  }

  // Clean up suffix - keep only common suffix chars
  // But preserve % and + which are important
  if (suffix.includes('%')) {
    suffix = '%';
  } else if (suffix.includes('+')) {
    suffix = '+';
  } else {
    suffix = suffix.replace(/[^%+\-KMB]/gi, '').trim();
  }

  const result = {
    numericValue: Math.round(numericValue),
    prefix,
    suffix,
  };

  console.log(`[extractNumericValue] Result: ${JSON.stringify(result)}`);
  return result;
}

// AI-generated animation using Gemini + Remotion
async function handleGenerateAnimation(req, res, sessionId) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  if (!hasLLMProvider()) {
    sendJSON(res, { error: 'No LLM provider configured. Set GEMINI_API_KEY or OPENAI_API_BASE_URL in .dev.vars' }, 500);
    return;
  }

  try {
    const body = await parseBody(req);
    const { description, videoAssetId, startTime, endTime, attachedAssetIds, durationSeconds } = body;
    const { fps, width, height } = resolveCompositionSettings(session, body);

    if (!description) {
      sendJSON(res, { error: 'description is required' }, 400);
      return;
    }

    const job = enqueueJob({
      sessionId,
      kind: 'animation',
      lane: 'llm',
      run: async (job) => {
    const jobId = randomUUID();
    const assetId = randomUUID();
    const outputPath = join(session.assetsDir, `${assetId}.mp4`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);
    const propsPath = join(session.dir, `${jobId}-props.json`);

    console.log(`\n[${jobId}] === GENERATE AI ANIMATION ===`);
    console.log(`[${jobId}] Description: ${description}`);
    if (attachedAssetIds?.length) {
      console.log(`[${jobId}] Attached assets: ${attachedAssetIds.length}`);
    }

    // Step 0: Get video transcript context if a video is provided
    let transcriptContext = '';
    let relevantSegment = '';
    let detectedTimeRange = null;

    if (videoAssetId) {
      const videoAsset = session.assets.get(videoAssetId);
      if (videoAsset && videoAsset.type === 'video') {
        console.log(`[${jobId}] Getting transcript context from ${videoAsset.filename}...`);

        try {
          const transcription = await getOrTranscribeVideo(session, videoAsset, jobId);

          if (transcription.text) {
            // If time range provided, get that segment
            if (startTime !== undefined && endTime !== undefined) {
              relevantSegment = getTranscriptSegment(transcription, startTime, endTime);
              detectedTimeRange = { start: startTime, end: endTime };
              console.log(`[${jobId}] ⏱️ Using USER-SPECIFIED time range: ${startTime}s - ${endTime}s`);
              console.log(`[${jobId}] 📝 Extracted transcript segment (${relevantSegment.split(' ').length} words):`);
              console.log(`[${jobId}]    "${relevantSegment.substring(0, 200)}${relevantSegment.length > 200 ? '...' : ''}"`);
            } else {
              // Use AI to identify the relevant part of the video based on the description
              console.log(`[${jobId}] Using AI to identify relevant video segment...`);

              const segmentPrompt = `Given this video transcript and an animation request, identify the most relevant time segment.

VIDEO TRANSCRIPT (with word timestamps):
${transcription.words?.slice(0, 200).map(w => `[${w.start.toFixed(1)}s] ${w.text}`).join(' ') || transcription.text.substring(0, 2000)}

ANIMATION REQUEST: "${description}"

VIDEO DURATION: ${videoAsset.duration}s

Analyze the request and determine:
1. Which part of the video is most relevant to this animation
2. The start and end times of the relevant segment

Return ONLY JSON (no markdown):
{
  "startTime": <seconds>,
  "endTime": <seconds>,
  "reasoning": "brief explanation of why this segment is relevant"
}

If the animation seems to be for the intro (beginning), use startTime: 0.
If it's for the outro (ending), use times near the end.
If it's about a specific topic mentioned in the transcript, find where that topic is discussed.
If unclear or general, use the middle third of the video.`;

              try {
                const segmentText = await generateWithLLM(segmentPrompt, { responseMimeType: 'application/json' });
                const segmentData = parseLLMJson(segmentText);

                if (segmentData.startTime !== undefined && segmentData.endTime !== undefined) {
                  detectedTimeRange = {
                    start: Math.max(0, segmentData.startTime),
                    end: Math.min(videoAsset.duration, segmentData.endTime)
                  };
                  relevantSegment = getTranscriptSegment(transcription, detectedTimeRange.start, detectedTimeRange.end);
                  console.log(`[${jobId}] AI detected relevant segment: ${detectedTimeRange.start}s - ${detectedTimeRange.end}s`);
                  console.log(`[${jobId}] Reasoning: ${segmentData.reasoning}`);
                }
              } catch (e) {
                console.log(`[${jobId}] Could not parse segment detection, using full transcript`);
                relevantSegment = transcription.text;
              }
            }

            // Build transcript context for the animation prompt
            if (relevantSegment) {
              const timeRangeNote = detectedTimeRange
                ? `\nThis segment is from ${detectedTimeRange.start.toFixed(1)}s to ${detectedTimeRange.end.toFixed(1)}s in the video.`
                : '';

              transcriptContext = `

VIDEO CONTEXT (from the transcript):
"${relevantSegment.substring(0, 1500)}"
${timeRangeNote}

IMPORTANT: The animation content should be relevant to and inspired by this video context. Use specific terms, concepts, and themes from the transcript to make the animation feel connected to the video content.`;

              console.log(`[${jobId}] 🎯 Transcript context built for Gemini (${relevantSegment.length} chars)`);
            }
          }
        } catch (transcriptError: any) {
          console.log(`[${jobId}] Could not get transcript: ${transcriptError.message}`);
          // Continue without transcript context
        }
      }
    }

    // Build context for attached assets (images/videos to include in animation)
    let attachedAssetsContext = '';
    const attachedAssetPaths: any[] = [];
    if (attachedAssetIds?.length) {
      const attachedAssetInfo: any[] = [];
      for (const attachedId of attachedAssetIds) {
        const attachedAsset = session.assets.get(attachedId);
        if (attachedAsset) {
          // Build HTTP URL for the asset (served by FFmpeg server)
          const assetUrl = `http://localhost:${PORT}/session/${sessionId}/assets/${attachedAsset.id}/stream`;
          attachedAssetInfo.push({
            id: attachedAsset.id,
            filename: attachedAsset.filename,
            type: attachedAsset.type,
            url: assetUrl,
          });
          attachedAssetPaths.push({
            id: attachedAsset.id,
            path: attachedAsset.path,  // Keep file path for server-side operations
            url: assetUrl,              // HTTP URL for Remotion rendering
            type: attachedAsset.type,
            filename: attachedAsset.filename,
          });
        }
      }
      if (attachedAssetInfo.length > 0) {
        attachedAssetsContext = `

ATTACHED MEDIA ASSETS (MUST be included in the animation):
${attachedAssetInfo.map((a, i) => `Asset ${i + 1}:
  - id: "${a.id}"
  - type: "${a.type}"
  - filename: "${a.filename}"`).join('\n')}

CRITICAL REQUIREMENTS:
1. You MUST create at least one "media" type scene for each attached asset above
2. In each media scene, set "mediaAssetId" to the EXACT id value shown above (copy/paste it exactly)
3. Use "mediaStyle": "framed" for a nicely presented image, or "fullscreen" for dramatic impact
4. Example media scene:
   {
     "id": "show-image",
     "type": "media",
     "duration": ${3 * fps},
     "content": {
       "title": "Optional title over the image",
       "mediaAssetId": "${attachedAssetInfo[0].id}",
       "mediaStyle": "framed",
       "color": "#f97316"
     }
   }`;
        console.log(`[${jobId}] Including ${attachedAssetInfo.length} attached assets in animation`);
      }
    }

    // Step 1: Use LLM to generate scene data
    console.log(`[${jobId}] Generating scenes with AI...`);

    const prompt = `You are a motion graphics designer. Create a JSON scene structure for an animated video based on this description:

"${description}"
${transcriptContext}${attachedAssetsContext}
Return ONLY valid JSON (no markdown, no code blocks) with this structure:
{
  "scenes": [
    {
      "id": "unique-id",
      "type": "title" | "steps" | "features" | "stats" | "text" | "transition" | "media" | "chart" | "comparison" | "countdown" | "shapes" | "emoji" | "gif" | "lottie",
      "duration": <number of frames at ${fps}fps, typically ${Math.round(1.5 * fps)}-${3 * fps} (1.5-3 seconds per scene). Keep scenes SHORT and punchy!>,
      "content": {
        "title": "optional title text",
        "subtitle": "optional subtitle",
        "items": [{"icon": "emoji or number", "label": "text", "description": "optional", "value": 75, "color": "#hex"}],
        "stats": [{"value": "10K+", "label": "Users", "numericValue": 10000, "prefix": "", "suffix": "+"}],  // IMPORTANT: numericValue must be a NUMBER (not string) for counting animation!
        "color": "#hex color for accent",
        "backgroundColor": "#hex for bg or null for transparent",
        // MEDIA SCENE OPTIONS:
        "mediaAssetId": "id of attached image/video to display",
        "mediaStyle": "fullscreen" | "framed" | "pip" | "background" | "split-left" | "split-right" | "circle" | "phone-frame",
        // VIDEO CONTROLS (for video assets):
        "videoStartFrom": 0,  // frame to start playing from
        "videoEndAt": ${3 * fps},     // frame to stop at (for trimming)
        "videoVolume": 1,     // 0-1
        "videoPlaybackRate": 1, // 0.5 = slow-mo, 2 = fast forward
        "videoLoop": false,
        "videoMuted": false,
        // MEDIA ANIMATION (ken-burns, zoom, pan on the media itself):
        "mediaAnimation": {"type": "ken-burns" | "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "parallax", "intensity": 0.3},
        // TEXT OVERLAY ON MEDIA:
        "overlayText": "Text to show over media",
        "overlayPosition": "top" | "center" | "bottom",
        "overlayStyle": "minimal" | "bold" | "gradient-bar",
        // SHAPES SCENE OPTIONS:
        "shapes": [
          {
            "type": "circle" | "rect" | "triangle" | "star" | "polygon" | "ellipse",
            "fill": "#hex color",
            "stroke": "#hex outline color",
            "strokeWidth": 2,
            "x": 50, "y": 50,  // position as percentage (0-100)
            "scale": 1,
            "rotation": 0,
            "delay": 0,  // animation delay in frames
            "animation": "pop" | "spin" | "bounce" | "float" | "pulse" | "none",
            // Shape-specific: radius (circle/polygon), width/height (rect), length/direction (triangle), points/innerRadius/outerRadius (star), rx/ry (ellipse)
          }
        ],
        "shapesLayout": "scattered" | "grid" | "circle" | "custom",
        // EMOJI SCENE OPTIONS:
        "emojis": [
          {
            "emoji": "🔥",  // Use actual emoji characters
            "x": 50, "y": 50,  // position as percentage
            "scale": 0.2,  // size (0.1 = small, 0.3 = large)
            "delay": 0,  // animation delay in frames
            "animation": "pop" | "bounce" | "float" | "pulse" | "spin" | "shake" | "wave" | "none"
          }
        ],
        "emojiLayout": "scattered" | "grid" | "circle" | "row" | "custom",
        // OTHER SCENE OPTIONS:
        "chartType": "bar" | "progress" | "pie",
        "chartData": [{"label": "Category", "value": 75, "color": "#hex"}],
        "maxValue": 100,
        "beforeLabel": "BEFORE", "afterLabel": "AFTER",
        "beforeValue": "50%", "afterValue": "95%",
        "countFrom": 3, "countTo": 0,
        "camera": {"type": "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "ken-burns" | "shake", "intensity": 0.3}
      },
      "transition": {"type": "swipe-left" | "swipe-right" | "swipe-up" | "swipe-down" | "fade" | "zoom-in" | "zoom-out" | "wipe-left" | "wipe-right" | "blur" | "flip", "duration": ${Math.round(fps / 2)}}
    }
  ],
  "backgroundColor": "#0a0a0a",
  "totalDuration": <sum of all scene durations>,
  "attachedAssets": [{"id": "asset-id", "path": "will be filled by server"}]
}

Scene types:
- "title": Big centered title with optional subtitle (for intros/outros)
- "steps": Numbered steps or process flow (1, 2, 3...)
- "features": Feature showcase with icons
- "stats": Animated statistics/numbers with COUNTING animation (numbers count from 0 to target). CRITICAL: You MUST include "numericValue" as an INTEGER (e.g., 10000, not "10000") for the counting animation to work! Example: {"value": "$10K+", "label": "Revenue", "numericValue": 10000, "prefix": "$", "suffix": "+"}. Without numericValue, numbers will NOT animate!
- "text": Simple text message
- "transition": Brief transition between scenes
- "media": Display an attached image/video with ADVANCED controls:
  * mediaStyle: "fullscreen" (edge-to-edge), "framed" (bordered), "pip" (small corner), "background" (dimmed behind text), "split-left"/"split-right" (half screen), "circle" (circular crop), "phone-frame" (mobile mockup)
  * mediaAnimation: Apply ken-burns, zoom, or pan DIRECTLY on the media for dynamic effect
  * overlayText: Add text over the media (great with "background" style)
  * For videos: Use videoStartFrom/videoEndAt to trim, videoPlaybackRate for slow-mo (0.5) or speed-up (2)
- "chart": Data visualization with chartType: "bar" (vertical bars), "progress" (horizontal progress bars), "pie" (pie chart). Use chartData array with label/value/color.
- "comparison": Before/after comparison. Use beforeLabel, afterLabel, beforeValue, afterValue.
- "countdown": Animated countdown. Use countFrom and countTo (e.g., 3 to 0).
- "shapes": Animated SVG shapes scene! Create eye-catching visuals with:
  * Shape types: "circle", "rect", "triangle", "star", "polygon", "ellipse"
  * Animations: "pop" (scale up), "spin" (rotate), "bounce" (vertical movement), "float" (gentle hover), "pulse" (breathing effect)
  * Layout: "scattered" (random positions), "grid" (organized), "circle" (arranged in circle), "custom" (use x/y)
  * Example shapes: [{"type": "star", "fill": "#f97316", "points": 5, "outerRadius": 60, "x": 50, "y": 50, "animation": "spin"}]
- "emoji": Animated emoji scene! Fun and expressive visuals:
  * Use actual emoji characters: "🔥", "⭐", "🚀", "💯", "❤️", "🎉", "✨", "👍", "🎯", "💡", etc.
  * Animations: "pop", "bounce", "float", "pulse", "spin", "shake", "wave"
  * Layout: "scattered", "grid", "circle" (arranged around center), "row" (horizontal line), "custom"
  * Example: [{"emoji": "🔥", "x": 30, "y": 50, "scale": 0.2, "animation": "bounce"}, {"emoji": "🚀", "x": 70, "y": 50, "animation": "float"}]
  * Great for reactions, celebrations, emphasis!
- "gif": Animated GIF scene! GIPHY integration for memes, reactions, and B-roll:
  * Use "gifSearch" to search GIPHY for GIFs by keyword (the server will fetch actual URLs automatically!)
  * Example: {"gifSearch": "mind blown", "gifLayout": "fullscreen"} - searches GIPHY for "mind blown" GIFs
  * Can also use "gifSearches" array for multiple GIFs: {"gifSearches": ["fire", "celebration", "thumbs up"]}
  * Properties for each GIF: x, y (position 0-100), width, height, scale, playbackRate (0.5=slow, 2=fast)
  * Animations: "pop", "bounce", "float", "pulse", "spin", "shake" (applied to the GIF container)
  * Layout: "fullscreen" (single GIF fills screen), "scattered", "grid", "circle", "row", "pip" (corner)
  * Use "gifBackground": true for a looping GIF as the scene background (with dark overlay for readability)
  * POPULAR SEARCHES: "reaction", "funny", "meme", "celebration", "mind blown", "shocked", "laughing", "applause", "fire", "thumbs up", "yes", "no", "thinking", "dancing"
  * Great for: adding humor, emphasizing points, meme-style content, reaction clips!
- "lottie": Professional After Effects animations! Smooth vector animations:
  * Provide Lottie JSON URLs in the "lotties" array (from LottieFiles.com or similar)
  * Properties: src (URL to JSON), x, y (position 0-100), width, height, scale, playbackRate, direction ("forward"/"backward")
  * Layout: "fullscreen", "scattered", "grid", "circle", "row", "custom"
  * Use "lottieBackground" for animated background (with dark overlay)
  * Great for: loading spinners, confetti, celebrations, transitions, icons, illustrations
  * Example: {"lotties": [{"src": "https://assets.lottiefiles.com/...", "width": 400, "height": 400}], "lottieLayout": "fullscreen"}

Camera movement (add to any scene's content):
- "zoom-in": Slowly zoom into the content
- "zoom-out": Start zoomed, pull back
- "pan-left" / "pan-right": Horizontal movement
- "pan-up" / "pan-down": Vertical movement
- "ken-burns": Classic documentary style (slow zoom + slight pan)
- "intensity": 0.1 to 0.5 (subtle to dramatic)

Scene transitions (add to scene to animate entry/exit):
- "swipe-left" / "swipe-right": Slide in/out horizontally (most popular)
- "swipe-up" / "swipe-down": Slide in/out vertically
- "fade": Fade in/out (subtle, professional)
- "zoom-in" / "zoom-out": Scale in/out with fade
- "wipe-left" / "wipe-right": Reveal effect (like a curtain)
- "blur": Blur transition (dreamy effect)
- "flip": 3D flip effect (dramatic)
- "duration": frames for transition (default ${Math.round(fps / 2)}, use ${Math.round(2 * fps / 3)}-${fps} for dramatic)

Guidelines:
- Canvas: ${width}x${height} (${orientationOf(width, height)}) — compose all layouts for this orientation
- Use MORE scenes with SHORTER durations (1.5-3 seconds each, ${Math.round(1.5 * fps)}-${3 * fps} frames). Fast cuts feel dynamic and engaging!
- For a 5s animation use 3-4 scenes, for 10s use 5-7 scenes, for 15s use 7-10 scenes, for 30s use 12-18 scenes. Scale up proportionally.
- NO scene should exceed ${4 * fps} frames (4 seconds) unless it's a countdown or media showcase.
- Total duration: ${durationSeconds ? `EXACTLY ${durationSeconds} seconds (${Math.round(durationSeconds * fps)} frames) - the user specifically requested this duration!` : `5-15 seconds (${5 * fps}-${15 * fps} frames)`}
- Use vibrant colors: #f97316 (orange), #3b82f6 (blue), #22c55e (green), #8b5cf6 (purple), #ec4899 (pink)
- Make it visually engaging with good pacing

IMPORTANT - ADD CAMERA MOVEMENTS to make scenes dynamic:
- ADD "camera" to at least 2-3 scenes (especially title, stats, and media scenes)
- Example: "content": { "title": "Hello", "camera": {"type": "zoom-in", "intensity": 0.25} }
- Use "zoom-in" for focus and impact (intensity 0.2-0.3)
- Use "ken-burns" for media/photos (intensity 0.25-0.35)
- Use "pan-left" or "pan-right" for text reveals (intensity 0.2)
- Use "shake" sparingly for energy (intensity 0.1-0.15)

- When showing numbers/stats, use numericValue for animated counting effect
- ADD TRANSITIONS between scenes! Use "swipe-left" or "swipe-right" for dynamic flow, "fade" for elegance, or "zoom-in" for impact
- Mix transition types for variety (e.g., first scene: swipe-right, second: fade, third: swipe-left)

IMPORTANT - ADD GIF SCENES for humor and engagement:
- ALWAYS include at least 1-2 "gif" type scenes in every animation for comedic/reaction effects!
- Use "gifSearch" with funny, relevant search terms that match the topic (e.g., "mind blown", "excited", "wait what", "money rain", "mic drop")
- Place GIF scenes BETWEEN informational scenes as punchlines or reactions to what was just shown
- Use "gifLayout": "fullscreen" for maximum impact, or "pip" for a subtle corner reaction
- GIFs make animations feel fun, relatable, and meme-worthy - lean into humor!
- Example: After a stats scene showing impressive numbers, add a "gif" scene with "gifSearch": "mind blown" or "impressed"
- For intros, try "lets go" or "hype". For outros, try "mic drop" or "thats all folks"
${attachedAssetIds?.length ? `- IMPORTANT: Include media scenes to showcase the attached images/videos!
- Use "mediaAnimation": {"type": "ken-burns", "intensity": 0.3} to add dynamic movement to images/videos
- Use "background" mediaStyle with "overlayText" for cinematic text-over-video effect
- For product shots, use "phone-frame" or "circle" mediaStyle
- For videos, consider using slow-mo (videoPlaybackRate: 0.5) for dramatic moments` : ''}`;

    let sceneData;
    try {
      const responseText = await generateWithLLM(prompt);
      sceneData = parseLLMJson(responseText);
    } catch (parseError) {
      console.error(`[${jobId}] Failed to parse AI response:`, parseError);
      throw new Error('Failed to parse AI-generated scene data');
    }

    console.log(`[${jobId}] Generated ${sceneData.scenes.length} scenes`);

    // Log camera movements for debugging
    const scenesWithCamera = sceneData.scenes.filter(s => s.content?.camera?.type);
    if (scenesWithCamera.length > 0) {
      console.log(`[${jobId}] 🎥 Camera movements: ${scenesWithCamera.map(s => `${s.id}: ${s.content.camera.type}`).join(', ')}`);
    } else {
      console.log(`[${jobId}] ⚠️ No camera movements in any scene`);
    }

    let totalDuration = sceneData.totalDuration || sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);

    // Enforce user-requested duration by scaling scene durations proportionally
    if (durationSeconds) {
      const targetFrames = Math.round(durationSeconds * fps);
      if (totalDuration !== targetFrames && totalDuration > 0) {
        const scale = targetFrames / totalDuration;
        console.log(`[${jobId}] ⏱️ Adjusting duration: Gemini gave ${totalDuration} frames (${(totalDuration / fps).toFixed(1)}s), user requested ${durationSeconds}s (${targetFrames} frames). Scale: ${scale.toFixed(2)}x`);
        for (const scene of sceneData.scenes) {
          const oldDuration = scene.duration;
          scene.duration = Math.max(1, Math.round(scene.duration * scale));
          console.log(`[${jobId}]   Scene "${scene.id}": ${oldDuration} → ${scene.duration} frames`);
        }
        totalDuration = sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
        sceneData.totalDuration = totalDuration;
        console.log(`[${jobId}] ⏱️ Adjusted total: ${totalDuration} frames (${(totalDuration / fps).toFixed(1)}s)`);
      }
    }

    const durationInSeconds = totalDuration / fps;

    // Annotate the fps the scene frame counts are anchored to (edits re-render at it)
    sceneData.fps = fps;

    // Inject actual asset file paths for attached media (use absolute file paths for Remotion CLI)
    if (attachedAssetPaths.length > 0) {
      sceneData.attachedAssets = attachedAssetPaths;
      console.log(`[${jobId}] Available attached assets:`, attachedAssetPaths.map(a => ({ id: a.id, filename: a.filename, type: a.type })));

      // Also update any media scenes with the correct file paths
      let mediaSceneCount = 0;
      for (const scene of sceneData.scenes) {
        console.log(`[${jobId}] Checking scene: type=${scene.type}, hasMediaAssetId=${!!scene.content?.mediaAssetId}`);

        if (scene.type === 'media' && scene.content?.mediaAssetId) {
          const matchedAsset = attachedAssetPaths.find(a => a.id === scene.content.mediaAssetId);
          if (matchedAsset) {
            // Use HTTP URL for Remotion CLI rendering - more reliable than file:// paths
            scene.content.mediaPath = matchedAsset.url;
            scene.content.mediaType = matchedAsset.type;
            mediaSceneCount++;
            console.log(`[${jobId}] ✓ Linked media asset to scene: ${matchedAsset.filename} -> ${matchedAsset.url}`);
          } else {
            console.log(`[${jobId}] ✗ No matching asset found for mediaAssetId: ${scene.content.mediaAssetId}`);
            console.log(`[${jobId}]   Available IDs: ${attachedAssetPaths.map(a => a.id).join(', ')}`);
          }
        } else if (scene.type === 'media' && !scene.content?.mediaAssetId) {
          console.log(`[${jobId}] ✗ Media scene without mediaAssetId - will show placeholder`);
          // If Gemini created a media scene but didn't set mediaAssetId, try to assign the first attached asset
          if (attachedAssetPaths.length > 0) {
            const firstAsset = attachedAssetPaths[0];
            scene.content.mediaAssetId = firstAsset.id;
            scene.content.mediaPath = firstAsset.url;  // Use HTTP URL
            scene.content.mediaType = firstAsset.type;
            mediaSceneCount++;
            console.log(`[${jobId}] ✓ Auto-assigned first attached asset: ${firstAsset.filename} -> ${firstAsset.url}`);
          }
        }
      }

      // If Gemini didn't create any media scenes but we have attached assets, add one
      if (mediaSceneCount === 0 && attachedAssetPaths.length > 0) {
        console.log(`[${jobId}] ⚠ No media scenes found! Adding a media scene for the attached asset(s)`);
        const firstAsset = attachedAssetPaths[0];
        const mediaScene = {
          id: `media-${firstAsset.id}`,
          type: 'media',
          duration: 3 * fps, // 3 seconds
          content: {
            title: firstAsset.filename.replace(/\.[^/.]+$/, ''), // filename without extension
            mediaAssetId: firstAsset.id,
            mediaPath: firstAsset.url,  // Use HTTP URL
            mediaType: firstAsset.type,
            mediaStyle: 'framed',
            color: '#f97316',
          }
        };
        // Insert media scene near the beginning (after the first scene if there is one)
        if (sceneData.scenes.length > 1) {
          sceneData.scenes.splice(1, 0, mediaScene);
        } else {
          sceneData.scenes.push(mediaScene);
        }
        sceneData.totalDuration = sceneData.scenes.reduce((sum, s) => sum + s.duration, 0);
        console.log(`[${jobId}] ✓ Added media scene for: ${firstAsset.filename} -> ${firstAsset.url}`);
      }
    }

    // Post-process GIF scenes - search GIPHY and inject actual URLs
    const giphyKey = process.env.GIPHY_API_KEY;
    for (const scene of sceneData.scenes) {
      if (scene.type === 'gif' && scene.content) {
        const { gifSearch, gifSearches } = scene.content;
        const searchTerms = gifSearches || (gifSearch ? [gifSearch] : []);

        if (searchTerms.length > 0 && giphyKey) {
          console.log(`[${jobId}] 🎬 Fetching GIFs from GIPHY for: ${searchTerms.join(', ')}`);
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
                  console.log(`[${jobId}]    ✓ Found GIF for "${term}": ${gif.title || 'untitled'}`);
                }
              } else {
                console.log(`[${jobId}]    ✗ No GIF found for "${term}"`);
              }
            } catch (err: any) {
              console.log(`[${jobId}]    ✗ GIPHY search failed for "${term}": ${err.message}`);
            }
          }

          // Set default layout if not specified
          if (!scene.content.gifLayout && scene.content.gifs.length === 1) {
            scene.content.gifLayout = 'fullscreen';
          } else if (!scene.content.gifLayout) {
            scene.content.gifLayout = 'scattered';
          }

          console.log(`[${jobId}]    Total GIFs fetched: ${scene.content.gifs.length}`);
        } else if (searchTerms.length > 0 && !giphyKey) {
          console.log(`[${jobId}] ⚠ GIPHY_API_KEY not configured - skipping GIF search`);
        }
      }
    }

    // Post-process stats to ensure numericValue is set for counting animation
    for (const scene of sceneData.scenes) {
      if (scene.type === 'stats' && scene.content?.stats) {
        console.log(`[${jobId}] 📊 Processing stats scene with ${scene.content.stats.length} stats...`);
        for (const stat of scene.content.stats) {
          console.log(`[${jobId}]    Raw stat: value="${stat.value}", numericValue=${stat.numericValue} (type: ${typeof stat.numericValue}), prefix="${stat.prefix || ''}", suffix="${stat.suffix || ''}"`);

          // Convert numericValue to number if it's a string
          if (typeof stat.numericValue === 'string') {
            const parsed = parseFloat(stat.numericValue);
            if (!isNaN(parsed)) {
              stat.numericValue = parsed;
              console.log(`[${jobId}]    ✓ Converted string numericValue to number: ${stat.numericValue}`);
            } else {
              stat.numericValue = undefined; // Clear invalid string so we can extract from value
            }
          }

          // If numericValue is not a valid positive number, try to extract from value string
          const hasValidNumericValue = typeof stat.numericValue === 'number' && !isNaN(stat.numericValue) && stat.numericValue > 0;

          if (!hasValidNumericValue && stat.value) {
            const extracted = extractNumericValue(stat.value);
            if (extracted && extracted.numericValue > 0) {
              stat.numericValue = extracted.numericValue;
              stat.prefix = stat.prefix || extracted.prefix;
              stat.suffix = stat.suffix || extracted.suffix;
              console.log(`[${jobId}]    ✓ Extracted: "${stat.value}" → prefix="${stat.prefix}" numericValue=${stat.numericValue} suffix="${stat.suffix}"`);
            } else {
              console.log(`[${jobId}]    ✗ Could not extract numeric value from "${stat.value}"`);
            }
          } else if (hasValidNumericValue) {
            console.log(`[${jobId}]    ✓ Already has valid numericValue: ${stat.numericValue}`);
          }

          // Final check: log what will be used for rendering
          const finalHasNumeric = typeof stat.numericValue === 'number' && !isNaN(stat.numericValue) && stat.numericValue > 0;
          console.log(`[${jobId}]    → Final: numericValue=${stat.numericValue}, will animate: ${finalHasNumeric}`);
        }
      }
    }

    // Step 2: Write props to JSON file for Remotion
    // Log final scene data for debugging
    console.log(`[${jobId}] Final scene data:`);
    for (const scene of sceneData.scenes) {
      const hasMedia = scene.content?.mediaPath ? `mediaPath: ${scene.content.mediaPath}` : 'no media';
      const hasStats = scene.content?.stats ? `stats: ${scene.content.stats.map(s => s.numericValue || s.value).join(', ')}` : '';
      console.log(`[${jobId}]   - ${scene.type}: ${scene.content?.title || '(no title)'} | ${hasMedia} ${hasStats}`);
    }
    writeFileSync(propsPath, JSON.stringify(sceneData, null, 2));
    console.log(`[${jobId}] Props written to ${propsPath}`);

    // Step 3: Render with Remotion Node API
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

      // Step 4: Generate thumbnail
      await runFFmpeg([
        '-y', '-i', outputPath,
        '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
        '-frames:v', '1',
        thumbPath
      ], jobId);

      // Store the scene data for future editing (don't delete props)
      const sceneDataPath = join(session.dir, `${assetId}-scenes.json`);
      writeJsonAtomic(sceneDataPath, sceneData);

      // Clean up temporary props file (but keep scene data)
      try {
        unlinkSync(propsPath);
      } catch (e) {
        // Ignore cleanup errors
      }

      const { stat } = await import('fs/promises');
      const stats = await stat(outputPath);

      // Create asset entry with scene data for re-editing
      const asset = {
        id: assetId,
        type: 'video',
        filename: `animation-${Date.now()}.mp4`,
        path: outputPath,
        thumbPath: existsSync(thumbPath) ? thumbPath : null,
        duration: durationInSeconds,
        size: stats.size,
        width,
        height,
        fps,
        createdAt: Date.now(),
        // Metadata for AI animations
        aiGenerated: true,
        description,
        sceneCount: sceneData.scenes.length,
        sceneDataPath,
        sceneData,
      };

      session.assets.set(assetId, asset);
      saveAssetMetadata(session);

      console.log(`[${jobId}] AI animation rendered: ${assetId} (${durationInSeconds}s)`);
      console.log(`[${jobId}] === GENERATION COMPLETE ===\n`);

      return {
        success: true,
        assetId,
        filename: asset.filename,
        duration: durationInSeconds,
        sceneCount: sceneData.scenes.length,
        thumbnailUrl: `/session/${sessionId}/assets/${assetId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${assetId}/stream`,
      };
      },
    });

    sendJobAccepted(res, sessionId, job);

  } catch (error: any) {
    console.error('AI animation generation error:', error);
    if (!res.headersSent) {
      sendJSON(res, { error: error.message }, 500);
    }
  }
}

export const animationGenerateRoutes: SessionRoute[] = [
  { method: 'POST', action: 'generate-animation', handler: handleGenerateAnimation },
];
