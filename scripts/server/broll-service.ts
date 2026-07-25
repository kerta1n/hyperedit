import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { TEMP_DIR } from './server-config.ts';
import { sendJSON } from './http-helpers.ts';
import { requireSession, saveAssetMetadata } from './session-store.ts';
import { getMediaInfo, getVideoDuration, runFFmpeg } from './ffmpeg-helpers.ts';
import { checkLocalWhisper, runLocalWhisper } from './whisper-helpers.ts';
import { generateImageWithGemini, generateWithLLM, hasLLMProvider, parseLLMJson, transcribeAudioWithLLM } from './llm-gateway.ts';
import type { SessionRoute } from './route-table.ts';

// Transcript-driven B-roll image generation: transcribe, find overlay
// opportunities, generate images through the provider gateway.

// Analyze transcript for B-roll opportunities using LLM
async function analyzeBrollOpportunities(transcript: string, words: any[], totalDuration: number) {
  const prompt = `Analyze this video transcript and identify 3-5 key moments that would benefit from a visual B-roll image overlay. Consider:
- Keywords or products mentioned (e.g., "iPhone", "Claude AI", "Tesla")
- Funny or emphatic moments
- Important concepts being explained
- Brand names or people mentioned
- Abstract concepts that could use visual reinforcement

The video is ${totalDuration.toFixed(1)} seconds long.

Transcript: "${transcript}"

Word timings (for reference): ${JSON.stringify(words.slice(0, 50))}${words.length > 50 ? '...' : ''}

Return a JSON array with this exact structure:
[
  {
    "timestamp": 15.2,
    "prompt": "minimalist icon of iPhone floating on clean white background, simple flat design",
    "reason": "product mention",
    "keyword": "iPhone"
  }
]

Guidelines for prompts:
- Keep prompts concise (10-20 words)
- Request clean, iconic, simple images suitable for video overlay
- Use "minimalist", "icon", "simple", "flat design" style descriptors
- Avoid complex scenes - prefer single subjects with clean backgrounds
- Images will be 1:1 square format

IMPORTANT: Return ONLY valid JSON array, no markdown, no explanation.`;

  try {
    const responseText = await generateWithLLM(prompt, { responseMimeType: 'application/json' });
    const parsed = parseLLMJson(responseText);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Handle B-roll generation endpoint
async function handleGenerateBroll(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  const jobId = sessionId.substring(0, 8);

  try {
    console.log(`\n[${jobId}] === GENERATE B-ROLL IMAGES ===`);

    // Check for LLM provider
    if (!hasLLMProvider()) {
      sendJSON(res, { error: 'No LLM provider configured. Set GEMINI_API_KEY or OPENAI_API_BASE_URL in .dev.vars' }, 400);
      return;
    }
    // Image generation goes through the provider SDK directly; declared here
    // like the sibling animation handlers. (The monolith referenced apiKey
    // without ever declaring it — the image step always threw. Fixed in the
    // R1 extraction.)
    const apiKey = process.env.GEMINI_API_KEY;

    // Explicit target only — library-order guessing is nondeterministic after restarts
    let reqBody = '';
    for await (const chunk of req) reqBody += chunk;
    const reqOptions = reqBody ? JSON.parse(reqBody) : {};
    if (!reqOptions.assetId) {
      sendJSON(res, {
        error: 'assetId is required',
        hint: 'Pass the id of the video asset to transcribe; GET /session/:id/assets lists assets.',
      }, 400);
      return;
    }
    const videoAsset = session.assets.get(reqOptions.assetId);
    if (!videoAsset || videoAsset.type !== 'video') {
      sendJSON(res, {
        error: `No video asset with id ${reqOptions.assetId} in session`,
        hint: 'GET /session/:id/assets lists available assets.',
      }, 400);
      return;
    }

    console.log(`[${jobId}] Using video: ${videoAsset.filename}`);

    // Step 1: Transcribe the video
    console.log(`[${jobId}] Step 1: Transcribing video...`);
    const audioPath = join(TEMP_DIR, `${jobId}-broll-audio.mp3`);
    const totalDuration = await getVideoDuration(videoAsset.path);

    // Check for transcription method
    const hasLocalWhisper = await checkLocalWhisper();
    const openaiKey = process.env.OPENAI_API_KEY;

    // Extract audio
    await runFFmpeg([
      '-y', '-i', videoAsset.path,
      '-vn', '-acodec', 'libmp3lame',
      '-ab', '64k', '-ar', '16000', '-ac', '1',
      audioPath
    ], jobId);

    let transcription;
    if (hasLocalWhisper) {
      try {
        console.log(`[${jobId}]    Using local Whisper...`);
        transcription = await runLocalWhisper(audioPath, jobId);
      } catch (whisperError: any) {
        console.log(`[${jobId}]    Local Whisper failed: ${whisperError.message}`);
        console.log(`[${jobId}]    Falling back to LLM transcription...`);
        transcription = await transcribeAudioWithLLM(audioPath, totalDuration, jobId);
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
        words: (whisperResult.words || []).map((w: any) => ({
          text: w.word || '',
          start: w.start || 0,
          end: w.end || 0,
        }))
      };
    } else {
      transcription = await transcribeAudioWithLLM(audioPath, totalDuration, jobId);
    }

    try { unlinkSync(audioPath); } catch { }

    console.log(`[${jobId}]    Transcript: "${transcription.text.substring(0, 100)}..."`);
    console.log(`[${jobId}]    Words: ${transcription.words?.length || 0}`);

    // Step 2: Analyze transcript for B-roll opportunities
    console.log(`[${jobId}] Step 2: Analyzing for B-roll opportunities...`);
    const opportunities = await analyzeBrollOpportunities(
      transcription.text,
      transcription.words || [],
      totalDuration
    );

    console.log(`[${jobId}]    Found ${opportunities.length} B-roll opportunities`);
    opportunities.forEach((opp: any, i: number) => {
      console.log(`[${jobId}]    ${i + 1}. @${opp.timestamp.toFixed(1)}s: "${opp.keyword}" - ${opp.reason}`);
    });

    // Step 3: Generate images for each opportunity
    console.log(`[${jobId}] Step 3: Generating B-roll images...`);
    const brollAssets: any[] = [];

    for (let i = 0; i < opportunities.length; i++) {
      const opp = opportunities[i];
      const assetId = randomUUID();
      const imagePath = join(session.assetsDir, `${assetId}.png`);
      const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);

      console.log(`[${jobId}]    [${i + 1}/${opportunities.length}] Generating for "${opp.keyword}"...`);

      const success = await generateImageWithGemini(opp.prompt, apiKey, imagePath);

      if (success && existsSync(imagePath)) {
        // Generate thumbnail
        try {
          await runFFmpeg([
            '-y', '-i', imagePath,
            '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
            '-frames:v', '1',
            thumbPath
          ], jobId);
        } catch (e: any) {
          console.warn(`[${jobId}]    Thumbnail generation failed:`, e.message);
        }

        const { stat } = await import('fs/promises');
        const stats = await stat(imagePath);
        const info = await getMediaInfo(imagePath);

        // Create asset entry
        const asset = {
          id: assetId,
          type: 'image',
          filename: `broll-${opp.keyword.replace(/\s+/g, '-')}.png`,
          path: imagePath,
          thumbPath: existsSync(thumbPath) ? thumbPath : null,
          duration: 3, // Default 3 seconds for B-roll images
          size: stats.size,
          width: info.width || 1024,
          height: info.height || 1024,
          createdAt: Date.now(),
          // B-roll metadata
          keyword: opp.keyword,
          timestamp: opp.timestamp,
          reason: opp.reason,
        };

        session.assets.set(assetId, asset);
        saveAssetMetadata(session); // Persist asset metadata to disk

        brollAssets.push({
          assetId: asset.id,
          keyword: opp.keyword,
          timestamp: opp.timestamp,
          reason: opp.reason,
          filename: asset.filename,
          thumbnailUrl: `/session/${sessionId}/assets/${asset.id}/thumbnail`,
        });

        console.log(`[${jobId}]    ✓ Generated: ${asset.filename}`);
      } else {
        console.log(`[${jobId}]    ✗ Failed to generate image for "${opp.keyword}"`);
      }
    }

    console.log(`[${jobId}] Generated ${brollAssets.length}/${opportunities.length} B-roll images`);
    console.log(`[${jobId}] === B-ROLL GENERATION COMPLETE ===\n`);

    sendJSON(res, {
      success: true,
      transcript: transcription.text,
      opportunities: opportunities,
      brollAssets: brollAssets,
    });

  } catch (error: any) {
    console.error(`[${jobId}] Error:`, error.message);
    sendJSON(res, { error: error.message }, 500);
  }
}

export const brollRoutes: SessionRoute[] = [
  { method: 'POST', action: 'generate-broll', handler: handleGenerateBroll },
];
