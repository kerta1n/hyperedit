import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { TEMP_DIR } from './server-config.ts';
import { httpError, sendJSON, sendJobAccepted } from './http-helpers.ts';
import { requireSession, type Session, type SessionAsset } from './session-store.ts';
import { enqueueJob } from './job-queue.ts';
import { getVideoDuration, runFFmpeg } from './ffmpeg-helpers.ts';
import { checkLocalWhisper, runLocalWhisper } from './whisper-helpers.ts';
import { callGeminiSDK, generateWithLLM, hasLLMProvider, parseLLMJson, transcribeAudioWithLLM } from './llm-gateway.ts';
import { downloadGifAsAsset, extractKeywordsFromTranscript, searchGiphy } from './giphy-service.ts';
import type { SessionRoute } from './route-table.ts';

// Transcript-derived operations: caption transcription, keyword-driven GIF
// extraction, and chapter generation. Engine selection stays behind the
// whisper-helpers/llm-gateway ladder — one contract per owner constraint.

// Format seconds to YouTube timestamp format (MM:SS or HH:MM:SS)
function formatTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Transcribe video using OpenAI Whisper API
async function transcribeVideo(videoPath: string, jobId: string) {
  const audioPath = join(TEMP_DIR, `${jobId}-audio-whisper.mp3`);

  try {
    // Extract audio
    console.log(`[${jobId}] Extracting audio for transcription...`);
    await runFFmpeg([
      '-y', '-i', videoPath,
      '-vn', '-acodec', 'libmp3lame',
      '-ab', '64k', '-ar', '16000', '-ac', '1',
      audioPath
    ], jobId);

    const { stat } = await import('fs/promises');
    const audioStats = await stat(audioPath);
    console.log(`\n[${jobId}] Audio extracted: ${(audioStats.size / 1024 / 1024).toFixed(1)} MB`);

    // Check for OpenAI API key
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not configured in .dev.vars');
    }

    // Send to Whisper API
    console.log(`[${jobId}] Sending to Whisper API...`);
    const audioBuffer = readFileSync(audioPath);
    const audioBlob = new Blob([audioBuffer], { type: 'audio/mp3' });

    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.mp3');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whisper API error: ${response.status} - ${errorText}`);
    }

    const result: any = await response.json();
    console.log(`[${jobId}] Transcription complete: ${result.text?.length || 0} characters`);

    // Cleanup
    try { unlinkSync(audioPath); } catch { }

    return {
      text: result.text || '',
      words: result.words || [],
      duration: result.duration || 0,
    };

  } catch (error) {
    try { unlinkSync(audioPath); } catch { }
    throw error;
  }
}

// Cached transcription helper - avoids re-transcribing the same video
// Returns { text: string, words: Array<{text, start, end}> }
export async function getOrTranscribeVideo(session: Session, videoAsset: SessionAsset, jobId: string) {
  // Check cache first
  if (session.transcriptCache.has(videoAsset.id)) {
    const cached = session.transcriptCache.get(videoAsset.id);
    console.log(`[${jobId}] Using cached transcript for ${videoAsset.filename} (cached ${Math.round((Date.now() - cached.cachedAt) / 1000)}s ago)`);
    return { text: cached.text, words: cached.words };
  }

  console.log(`[${jobId}] Transcribing ${videoAsset.filename}...`);

  // Check available transcription methods
  const hasLocalWhisper = await checkLocalWhisper();
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!hasLocalWhisper && !openaiKey && !geminiKey) {
    throw new Error('No transcription method available. Install local Whisper or set OPENAI_API_KEY/GEMINI_API_KEY');
  }

  // Extract audio from video
  const audioPath = join(TEMP_DIR, `${jobId}-transcript-audio.mp3`);
  await runFFmpeg([
    '-y', '-i', videoAsset.path,
    '-vn', '-acodec', 'libmp3lame', '-q:a', '4',
    audioPath
  ], jobId);

  let transcription: { text: string; words: any[] } = { text: '', words: [] };

  // Fallback transcription via the LLM provider's audio understanding
  const transcribeWithLLMLocal = async () => {
    if (!geminiKey) throw new Error('No transcription method available');
    return transcribeAudioWithLLM(audioPath, videoAsset.duration as number, jobId);
  };

  if (hasLocalWhisper) {
    try {
      console.log(`[${jobId}] Using local Whisper...`);
      transcription = await runLocalWhisper(audioPath, jobId);
    } catch (whisperError: any) {
      console.log(`[${jobId}] Local Whisper failed: ${whisperError.message}`);
      console.log(`[${jobId}] Falling back to Gemini...`);
      transcription = await transcribeWithLLMLocal();
    }
  } else if (openaiKey) {
    console.log(`[${jobId}] Using OpenAI Whisper API...`);
    const { FormData, File } = await import('formdata-node');
    const audioBuffer = readFileSync(audioPath);
    const formData = new FormData();
    formData.append('file', new File([audioBuffer], 'audio.mp3', { type: 'audio/mp3' }));
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
        text: w.word,
        start: w.start,
        end: w.end,
      })),
    };
  } else if (geminiKey) {
    transcription = await transcribeWithLLMLocal();
  }

  // Clean up audio file
  try { unlinkSync(audioPath); } catch { }

  // Cache the transcript
  session.transcriptCache.set(videoAsset.id, {
    text: transcription.text,
    words: transcription.words || [],
    cachedAt: Date.now(),
  });

  console.log(`[${jobId}] Transcription cached: ${transcription.text.substring(0, 100)}...`);
  return transcription;
}

// Get transcript segment for a specific time range
export function getTranscriptSegment(transcription: { text: string; words?: any[] }, startTime: number, endTime: number): string {
  if (!transcription.words || transcription.words.length === 0) {
    return transcription.text;
  }

  const segmentWords = transcription.words.filter(w =>
    w.end >= startTime && w.start <= endTime
  );

  if (segmentWords.length === 0) {
    // Fall back to full transcript if no words in range
    return transcription.text;
  }

  return segmentWords.map(w => w.text).join(' ');
}

// Generate chapters for a session
async function handleSessionChapters(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  const jobId = sessionId;
  const audioPath = join(session.dir, `audio-${Date.now()}.mp3`);

  try {
    if (!hasLLMProvider()) {
      sendJSON(res, { error: 'No LLM provider configured. Set GEMINI_API_KEY or OPENAI_API_BASE_URL in .dev.vars' }, 400);
      return;
    }

    console.log(`\n[${jobId}] === CHAPTER GENERATION (Session) ===`);

    // Explicit target only — library-order guessing is nondeterministic after restarts
    let body = '';
    for await (const chunk of req) body += chunk;
    const options = body ? JSON.parse(body) : {};
    if (!options.assetId) {
      sendJSON(res, {
        error: 'assetId is required',
        hint: 'Pass the id of the video asset to generate chapters from; GET /session/:id/assets lists assets.',
      }, 400);
      return;
    }
    const videoAsset = session.assets.get(options.assetId);
    if (!videoAsset || videoAsset.type !== 'video') {
      sendJSON(res, {
        error: `No video asset with id ${options.assetId} in session`,
        hint: 'GET /session/:id/assets lists available assets.',
      }, 400);
      return;
    }
    const videoPath = videoAsset.path;
    const { existsSync } = await import('fs');
    if (!existsSync(videoPath)) {
      sendJSON(res, { error: 'Video file no longer exists on disk. Please re-upload.' }, 400);
      return;
    }
    console.log(`[${jobId}] Using video asset: ${videoAsset.filename}`);

    const job = enqueueJob({
      sessionId,
      kind: 'chapters',
      lane: 'llm',
      run: async () => {
    try {
    const totalDuration = await getVideoDuration(videoPath);

    // Extract audio
    console.log(`[${jobId}] Extracting audio from: ${videoPath}`);
    await runFFmpeg(['-y', '-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-ab', '64k', '-ar', '16000', '-ac', '1', audioPath], jobId);

    const { stat } = await import('fs/promises');
    const audioStats = await stat(audioPath);
    console.log(`\n[${jobId}] Audio: ${(audioStats.size / 1024 / 1024).toFixed(1)} MB`);

    // Send audio to the LLM provider for chapter analysis
    console.log(`[${jobId}] Analyzing with LLM provider...`);
    const responseText = await generateWithLLM(`Analyze this audio from a video that is ${totalDuration.toFixed(1)} seconds long.

Identify logical chapter breaks based on topic changes or natural transitions.

For each chapter:
1. START timestamp (seconds from beginning)
2. Concise, descriptive title (2-6 words)

Guidelines:
- First chapter starts at 0
- Aim for 3-8 chapters
- At least 30 seconds apart
- Engaging titles for YouTube

Return JSON: {"chapters": [{"start": 0, "title": "Introduction"}], "summary": "Brief summary"}`, { audioPath, responseMimeType: 'application/json' });

    console.log(`[${jobId}] LLM response:`, responseText.substring(0, 500));

    let result;
    try {
      result = parseLLMJson(responseText || '{}');
    } catch {
      result = { chapters: [], summary: '' };
    }

    // If no chapters detected, create automatic chapters based on duration
    if (!result.chapters || result.chapters.length === 0) {
      console.log(`[${jobId}] No chapters from AI, creating automatic chapters...`);

      // Create chapters every ~60 seconds, or split into 4-6 sections
      const chapterInterval = Math.max(30, Math.min(90, totalDuration / 5));
      const autoChapters: Array<{ start: number; title: string }> = [];

      for (let time = 0; time < totalDuration - 10; time += chapterInterval) {
        const chapterNum = autoChapters.length + 1;
        autoChapters.push({
          start: Math.round(time * 10) / 10,
          title: time === 0 ? 'Introduction' : `Part ${chapterNum}`
        });
      }

      result.chapters = autoChapters;
      result.summary = 'Auto-generated chapters based on video duration';
      console.log(`[${jobId}] Created ${autoChapters.length} automatic chapters`);
    }

    const youtubeChapters = (result.chapters || [])
      .sort((a: any, b: any) => a.start - b.start)
      .map((ch: any) => `${formatTimestamp(ch.start)} ${ch.title}`)
      .join('\n');

    // Cleanup
    try { unlinkSync(audioPath); } catch { }

    console.log(`[${jobId}] Generated ${result.chapters?.length || 0} chapters`);

    return {
      success: true,
      chapters: result.chapters || [],
      youtubeFormat: youtubeChapters,
      summary: result.summary || '',
      videoDuration: totalDuration,
    };

    } catch (error: any) {
      try { unlinkSync(audioPath); } catch { }
      throw error;
    }
      },
    });

    sendJobAccepted(res, sessionId, job);

  } catch (error: any) {
    console.error(`[${jobId}] Error:`, error.message);
    try { unlinkSync(audioPath); } catch { }
    sendJSON(res, { error: error.message }, 500);
  }
}

async function handleTranscribe(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  const jobId = sessionId.substring(0, 8);
  const audioPath = join(TEMP_DIR, `${jobId}-caption-audio.mp3`);

  try {
    // Check for transcription options in order of preference:
    // 1. Local Whisper (free, accurate)
    // 2. OpenAI Whisper API (paid, accurate)
    // 3. Gemini (paid, less accurate timestamps)
    const hasLocalWhisper = await checkLocalWhisper();
    const openaiKey = process.env.OPENAI_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;

    if (!hasLocalWhisper && !openaiKey && !geminiKey) {
      sendJSON(res, { error: 'No transcription method available. Install local Whisper (pip3 install openai-whisper) or set GEMINI_API_KEY in .dev.vars' }, 400);
      return;
    }

    // Parse request body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const { assetId, startTime, endTime } = JSON.parse(body || '{}');

    // Determine which method to use
    const useLocalWhisper = hasLocalWhisper;
    const useOpenAIWhisper = !hasLocalWhisper && !!openaiKey;
    const useGemini = !hasLocalWhisper && !openaiKey && !!geminiKey;

    const method = useLocalWhisper ? 'Local Whisper' : useOpenAIWhisper ? 'OpenAI Whisper' : 'Gemini';
    console.log(`\n[${jobId}] === TRANSCRIBE FOR CAPTIONS (${method}) ===`);

    if (useLocalWhisper) {
      console.log(`[${jobId}] Using local Whisper for accurate word-level timestamps (free)`);
    } else if (useOpenAIWhisper) {
      console.log(`[${jobId}] Using OpenAI Whisper API for accurate word-level timestamps`);
    } else {
      console.log(`[${jobId}] Using Gemini (timestamps may drift - install local Whisper for accurate sync)`);
    }

    // Explicit target only — library-order guessing is nondeterministic after restarts
    if (!assetId) {
      sendJSON(res, {
        error: 'assetId is required',
        hint: 'Pass the id of the video asset to transcribe; GET /session/:id/assets lists assets.',
      }, 400);
      return;
    }
    const videoAsset = session.assets.get(assetId);

    if (!videoAsset) {
      sendJSON(res, { error: 'No video asset found' }, 400);
      return;
    }

    console.log(`[${jobId}] Transcribing: ${videoAsset.filename}`);

    // Get video duration
    const totalDuration = await getVideoDuration(videoAsset.path);
    console.log(`[${jobId}] Video duration: ${totalDuration.toFixed(2)}s`);

    // Duration of the audio actually transcribed — the trim window when
    // startTime/endTime were sent. Every downstream consumer (LLM prompt
    // duration hints, plain-text fallback spacing, the response) must use
    // THIS, not the asset length, or fallback timestamps get stretched
    // across the full asset.
    const transcribedDuration = Math.max(
      0,
      (endTime !== undefined ? Math.min(endTime, totalDuration) : totalDuration) - (startTime || 0)
    );
    if (startTime !== undefined || endTime !== undefined) {
      console.log(`[${jobId}] Transcribing window: ${(startTime || 0).toFixed(2)}s → +${transcribedDuration.toFixed(2)}s`);
    }

    // Unreachable via the UI today (0.1s resize floor), but a degenerate window
    // would extract empty audio and surface as a misleading no-speech 400.
    if (transcribedDuration <= 0) {
      sendJSON(res, { error: 'Requested transcription window is empty (starts at or beyond the end of the media).' }, 400);
      return;
    }

    const enqueuedJob = enqueueJob({
      sessionId,
      kind: 'transcribe',
      lane: 'transcribe',
      run: async () => {
    try {
    // Extract audio as MP3 (with optional trim for resized clips)
    console.log(`[${jobId}] Extracting audio...`);
    const ffmpegArgs = ['-y'];
    if (startTime !== undefined && startTime > 0) {
      ffmpegArgs.push('-ss', String(startTime));
    }
    ffmpegArgs.push('-i', videoAsset.path);
    if (endTime !== undefined) {
      // -ss before -i (input seeking) makes this relative to the new start.
      // transcribedDuration is the clamped window, so -t always matches what
      // every downstream consumer (LLM hints, fallback spacing, response) uses.
      ffmpegArgs.push('-t', String(transcribedDuration));
    }
    ffmpegArgs.push('-vn', '-acodec', 'libmp3lame', '-ab', '64k', '-ar', '16000', '-ac', '1', audioPath);
    await runFFmpeg(ffmpegArgs, jobId);

    const { stat } = await import('fs/promises');
    const audioStats = await stat(audioPath);
    console.log(`[${jobId}] Audio extracted: ${(audioStats.size / 1024 / 1024).toFixed(1)} MB`);

    // Transcribe using the available method
    let transcription;

    if (useLocalWhisper) {
      // === Local Whisper - Free and accurate word-level timestamps ===
      try {
        transcription = await runLocalWhisper(audioPath, jobId);
        console.log(`[${jobId}] Local Whisper complete: ${transcription.words?.length || 0} words`);
      } catch (whisperError: any) {
        console.log(`[${jobId}] Local Whisper failed: ${whisperError.message}`);
        if (geminiKey) {
          console.log(`[${jobId}] Falling back to LLM transcription...`);
          transcription = await transcribeAudioWithLLM(audioPath, transcribedDuration.toFixed(1) as any, jobId);
        } else {
          throw whisperError;
        }
      }

    } else if (useOpenAIWhisper) {
      // === OpenAI Whisper API - Accurate word-level timestamps ===
      console.log(`[${jobId}] Sending to OpenAI Whisper for transcription...`);
      const audioBuffer = readFileSync(audioPath);

      // Create FormData for multipart upload
      const FormData = (await import('formdata-node')).FormData;
      const { Blob } = await import('buffer');

      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: 'audio/mp3' }), 'audio.mp3');
      formData.append('model', 'whisper-1');
      formData.append('response_format', 'verbose_json');
      formData.append('timestamp_granularities[]', 'word');

      const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
        },
        body: formData as any,
      });

      if (!whisperResponse.ok) {
        const errorText = await whisperResponse.text();
        console.error(`[${jobId}] Whisper API error:`, errorText);
        throw new Error(`Whisper API error: ${whisperResponse.status} - ${errorText}`);
      }

      const whisperResult: any = await whisperResponse.json();
      console.log(`[${jobId}] Whisper transcription complete: ${whisperResult.words?.length || 0} words`);

      transcription = {
        text: whisperResult.text || '',
        words: (whisperResult.words || []).map((w: any) => ({
          text: w.word || '',
          start: w.start || 0,
          end: w.end || 0,
        }))
      };

    } else if (useGemini) {
      // === LLM audio transcription - estimated timestamps (less accurate) ===
      console.log(`[${jobId}] Sending audio for LLM transcription...`);
      const audioBuffer = readFileSync(audioPath);
      const audioBase64 = audioBuffer.toString('base64');

      const responseText = await callGeminiSDK([
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/mp3', data: audioBase64 } },
            {
              text: `Transcribe this audio with word-level timestamps. The audio is ${transcribedDuration.toFixed(1)} seconds long.

IMPORTANT: Return ONLY valid JSON, no markdown, no explanation. The response must be parseable JSON.

Return this exact JSON structure:
{
  "text": "full transcript text here",
  "words": [
    {"text": "word1", "start": 0.0, "end": 0.5},
    {"text": "word2", "start": 0.5, "end": 1.0}
  ]
}

Guidelines:
- Include every spoken word
- Timestamps should be in seconds (decimals allowed)
- "start" is when the word begins, "end" is when it ends
- Words should be in order
- Estimate timing based on natural speech patterns if exact timing is unclear
- Do not include filler sounds like "um" or "uh" unless they're clearly intentional`
            }
          ]
        }
      ]);
      console.log(`[${jobId}] LLM response length: ${responseText.length} chars`);
      console.log(`[${jobId}] LLM raw response:`, responseText.substring(0, 1000));

      // Parse the JSON response
      try {
        // First try direct parse
        transcription = JSON.parse(responseText);
      } catch (e1) {
        try {
          // Try to extract JSON from markdown code blocks
          const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (codeBlockMatch) {
            transcription = JSON.parse(codeBlockMatch[1].trim());
          } else {
            // Try to extract any JSON object
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              transcription = JSON.parse(jsonMatch[0]);
            } else {
              throw new Error('No JSON found in response');
            }
          }
        } catch (e2) {
          console.error(`[${jobId}] Failed to parse Gemini response:`, responseText);

          // Last resort: try to create a simple transcription from the text
          // If Gemini just returned plain text, use that as the transcript
          if (responseText && responseText.length > 10 && !responseText.startsWith('{')) {
            console.log(`[${jobId}] Falling back to plain text transcription`);
            const plainText = responseText.replace(/```[\s\S]*?```/g, '').trim();
            const wordsArray = plainText.split(/\s+/).filter(w => w.length > 0);
            const avgWordDuration = transcribedDuration / wordsArray.length;

            transcription = {
              text: plainText,
              words: wordsArray.map((word, i) => ({
                text: word.replace(/[.,!?;:'"]/g, ''),
                start: i * avgWordDuration,
                end: (i + 1) * avgWordDuration,
              }))
            };
          } else {
            throw new Error('Failed to parse transcription response from Gemini');
          }
        }
      }
    }

    // Cleanup
    try { unlinkSync(audioPath); } catch { }

    const words = (transcription.words || []).map((w: any) => ({
      text: w.text || '',
      start: parseFloat(w.start) || 0,
      end: parseFloat(w.end) || 0,
    })).filter((w: any) => w.text.trim().length > 0); // Filter out empty words

    console.log(`[${jobId}] Transcription complete: ${words.length} words`);
    console.log(`[${jobId}] Text: "${(transcription.text || '').substring(0, 200)}..."`);

    // Check if transcription is empty
    if (words.length === 0 && (!transcription.text || transcription.text.trim().length === 0)) {
      console.error(`[${jobId}] Empty transcription - Gemini returned no words`);
      console.error(`[${jobId}] This could mean: no speech in video, audio too quiet, or unsupported language`);

      const windowRequested = startTime !== undefined || endTime !== undefined;
      throw httpError(400, `No speech detected${windowRequested ? ' in the selected clip range' : ''}. Make sure the video has clear, audible speech.`);
    }

    console.log(`[${jobId}] === TRANSCRIPTION DONE ===\n`);

    return {
      success: true,
      text: transcription.text || '',
      words: words,
      // Duration of the transcribed window (word times are relative to it),
      // not the asset length — assetDuration carries that separately
      duration: transcribedDuration,
      assetDuration: totalDuration,
    };

    } catch (error: any) {
      try { unlinkSync(audioPath); } catch { }
      throw error;
    }
      },
    });

    sendJobAccepted(res, sessionId, enqueuedJob);

  } catch (error: any) {
    console.error(`[${jobId}] Error:`, error.message);
    try { unlinkSync(audioPath); } catch { }
    sendJSON(res, { error: error.message }, 500);
  }
}

// Handle transcribe and extract keywords endpoint
async function handleTranscribeAndExtract(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  const jobId = sessionId.substring(0, 8);

  try {
    console.log(`\n[${jobId}] === TRANSCRIBE & EXTRACT KEYWORDS ===`);

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

    const job = enqueueJob({
      sessionId,
      kind: 'transcribe-extract',
      lane: 'transcribe',
      run: async () => {
    // Step 1: Transcribe
    const transcription = await transcribeVideo(videoAsset.path, jobId);
    console.log(`[${jobId}] Transcript: "${transcription.text.substring(0, 100)}..."`);

    // Step 2: Extract keywords
    const keywords = extractKeywordsFromTranscript(transcription.text, transcription.words);
    console.log(`[${jobId}] Found ${keywords.length} keywords`);

    // Step 3: Fetch GIFs from GIPHY for each keyword
    const gifAssets: any[] = [];
    for (const kw of keywords) {
      try {
        console.log(`[${jobId}] Searching GIPHY for "${kw.keyword}"...`);
        const gifs = await searchGiphy(kw.keyword, 1);

        if (gifs.length > 0) {
          // Get the fixed height small GIF URL
          const gifUrl = gifs[0].images?.fixed_height?.url ||
            gifs[0].images?.original?.url;

          if (gifUrl) {
            const asset = await downloadGifAsAsset(session, gifUrl, kw.keyword, kw.timestamp);
            gifAssets.push({
              assetId: asset.id,
              keyword: kw.keyword,
              timestamp: kw.timestamp,
              confidence: kw.confidence,
              filename: asset.filename,
              thumbnailUrl: `/session/${sessionId}/assets/${asset.id}/thumbnail`,
            });
          }
        }
      } catch (error: any) {
        console.warn(`[${jobId}] Failed to get GIF for "${kw.keyword}":`, error.message);
      }
    }

    console.log(`[${jobId}] Downloaded ${gifAssets.length} GIFs`);
    console.log(`[${jobId}] === TRANSCRIPTION COMPLETE ===\n`);

    return {
      success: true,
      transcript: transcription.text,
      keywords: keywords,
      gifAssets: gifAssets,
    };
      },
    });

    sendJobAccepted(res, sessionId, job);

  } catch (error: any) {
    console.error(`[${jobId}] Error:`, error.message);
    sendJSON(res, { error: error.message }, 500);
  }
}

export const transcriptionRoutes: SessionRoute[] = [
  { method: 'POST', action: 'chapters', handler: handleSessionChapters },
  { method: 'POST', action: 'transcribe', handler: handleTranscribe },
  { method: 'POST', action: 'transcribe-and-extract', handler: handleTranscribeAndExtract },
];
