import { readFileSync, writeFileSync } from 'fs';
import { GoogleGenAI } from '@google/genai';
import { checkLocalWhisper, runLocalWhisper } from './whisper-helpers.ts';

// ============== LLM PROVIDER ABSTRACTION ==============
// The only server module (besides provider/gateway peers) allowed to name
// vendors. Call sites speak task vocabulary through generateWithLLM.

export interface LLMOptions {
  systemPrompt?: string;
  responseMimeType?: string;
  audioPath?: string;
  model?: string;
}

// Determine which LLM provider to use for text/code generation
export function getLLMProvider(): string | null {
  const explicit = process.env.LLM_PROVIDER;
  if (explicit) return explicit; // 'google' or 'openai'
  if (process.env.GEMINI_API_KEY) return 'google';
  if (process.env.OPENAI_API_BASE_URL) return 'openai';
  return null;
}

// Check if any LLM provider is configured
export function hasLLMProvider(): boolean {
  return !!getLLMProvider();
}

// Call OpenAI-compatible API (Ollama, etc.) via fetch
export async function callOpenAICompat(messages: Array<{ role: string; content: string }>, options: LLMOptions = {}): Promise<string> {
  const baseUrl = process.env.OPENAI_API_BASE_URL;
  if (!baseUrl) throw new Error('OPENAI_API_BASE_URL not configured');

  const model = options.model || process.env.LLM_MODEL || 'qwen3.5:9b';
  const apiKey = process.env.OPENAI_API_KEY || '';

  const body: any = {
    model,
    messages,
  };

  if (options.responseMimeType === 'application/json') {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI API error ${response.status}: ${errText.substring(0, 200)}`);
  }

  const result: any = await response.json();
  return result.choices?.[0]?.message?.content || '';
}

// Call Google GenAI SDK
export async function callGeminiSDK(contents: any[], options: LLMOptions = {}): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const ai = new GoogleGenAI({ apiKey });
  const config: any = {};
  if (options.responseMimeType) {
    config.responseMimeType = options.responseMimeType;
  }

  const response: any = await ai.models.generateContent({
    model: options.model || 'gemini-2.0-flash',
    contents,
    ...(Object.keys(config).length ? { config } : {}),
  });

  // Handle different SDK response formats
  if (typeof response.text === 'function') return await response.text();
  if (response.text) return response.text;
  if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
    return response.candidates[0].content.parts[0].text;
  }
  return '';
}

/**
 * Unified LLM call for text generation, optionally grounded in an audio file.
 * Routes to Google GenAI or OpenAI-compatible API based on env vars.
 *
 * @param prompt - The user prompt text
 * @param options.systemPrompt - Optional system prompt
 * @param options.responseMimeType - 'application/json' for JSON output
 * @param options.audioPath - Audio file the model should analyze.
 *   Providers with native audio understanding receive the audio inline;
 *   text-only providers receive a timestamped local-Whisper transcript instead.
 * @returns The LLM response text
 */
export async function generateWithLLM(prompt: string, options: LLMOptions = {}): Promise<string> {
  const provider = getLLMProvider();
  if (!provider) throw new Error('No LLM provider configured. Set GEMINI_API_KEY or OPENAI_API_BASE_URL in .dev.vars');

  if (provider === 'openai') {
    let userPrompt = prompt;
    if (options.audioPath) {
      userPrompt = `${prompt}\n\nTimestamped transcript of the audio:\n${await transcribeForTextPrompt(options.audioPath)}`;
    }
    const messages: Array<{ role: string; content: string }> = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: userPrompt });
    return callOpenAICompat(messages, options);
  } else {
    // Google GenAI
    const parts: any[] = [{ text: prompt }];
    if (options.audioPath) {
      // Audio precedes the text part — the shape the audio-analysis calls always used
      parts.unshift({ inlineData: { mimeType: 'audio/mp3', data: readFileSync(options.audioPath).toString('base64') } });
    }
    const contents = [{ role: 'user', parts }];
    // For Gemini, embed system prompt as a preceding user message
    if (options.systemPrompt) {
      contents.unshift({ role: 'user', parts: [{ text: options.systemPrompt }] });
    }
    return callGeminiSDK(contents, options);
  }
}

// Text-only providers cannot hear audio: build a timestamped transcript via
// local Whisper for embedding into the prompt.
async function transcribeForTextPrompt(audioPath: string): Promise<string> {
  if (!(await checkLocalWhisper())) {
    throw new Error('Audio analysis with a text-only LLM provider requires local Whisper (pip3 install openai-whisper torch)');
  }
  const transcription = await runLocalWhisper(audioPath, 'llm-audio');
  const words = transcription.words || [];
  if (words.length === 0) return transcription.text || '(no speech detected)';
  const bucketSeconds = 15;
  const lines: string[] = [];
  let bucketStart = 0;
  let current: string[] = [];
  for (const w of words) {
    if (w.start >= bucketStart + bucketSeconds && current.length) {
      lines.push(`[${bucketStart}s] ${current.join(' ')}`);
      bucketStart = Math.floor(w.start / bucketSeconds) * bucketSeconds;
      current = [];
    }
    current.push(w.text);
  }
  if (current.length) lines.push(`[${bucketStart}s] ${current.join(' ')}`);
  return lines.join('\n');
}

// Transcription fallback through the LLM provider's audio understanding
// (estimated timestamps — less accurate than Whisper). This is the
// audio-transcription provider adapter; vendor SDK calls stay in callGeminiSDK.
export async function transcribeAudioWithLLM(
  audioPath: string,
  durationSeconds: number | string,
  jobId: string,
  { wordTimestamps = true }: { wordTimestamps?: boolean } = {},
): Promise<{ text: string; words: any[] }> {
  console.log(`[${jobId}]    Using LLM audio transcription...`);
  const audioBuffer = readFileSync(audioPath);
  if (audioBuffer.length < 1000) {
    console.log(`[${jobId}]    Audio file too small, video may have no audio track`);
    return { text: '', words: [] };
  }
  const instruction = wordTimestamps
    ? `Transcribe this audio with word timestamps. Duration: ${durationSeconds}s. Return JSON: {"text": "full transcript", "words": [{"text": "word", "start": 0.0, "end": 0.5}]}`
    : `Transcribe this audio. Return ONLY the text content. Duration: ${durationSeconds}s`;
  const respText = await callGeminiSDK([{
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'audio/mp3', data: audioBuffer.toString('base64') } },
      { text: instruction },
    ],
  }]);
  if (!wordTimestamps) return { text: respText || '', words: [] };
  try {
    return parseLLMJson(respText);
  } catch {
    return { text: respText, words: [] };
  }
}

// Generate image using Gemini Imagen (Nano Banana)
export async function generateImageWithGemini(prompt: string, apiKey: string | undefined, outputPath: string): Promise<boolean> {
  const ai = new GoogleGenAI({ apiKey });

  console.log(`    Generating image: "${prompt.substring(0, 50)}..."`);

  try {
    // Use Gemini's image generation model
    const response: any = await ai.models.generateContent({
      model: 'gemini-2.0-flash-exp-image-generation',
      contents: [{
        role: 'user',
        parts: [{
          text: `Generate a clean, simple image: ${prompt}.
Style: minimalist, iconic, suitable for video overlay.
Format: 1:1 square aspect ratio.
Background: clean, uncluttered.`
        }]
      }],
      config: {
        responseModalities: ['image', 'text'],
      }
    });

    // Extract image from response
    const parts = response.candidates?.[0]?.content?.parts || [];
    console.log(`    Response has ${parts.length} parts`);

    for (const part of parts) {
      if (part.inlineData?.data) {
        const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
        writeFileSync(outputPath, imageBuffer);
        console.log(`    ✓ Image saved: ${(imageBuffer.length / 1024).toFixed(1)} KB`);
        return true;
      }
      if (part.text) {
        console.log(`    Part contains text: "${part.text.substring(0, 100)}..."`);
      }
    }

    console.warn(`    ⚠️ No image data in response. Model may not support image generation.`);
    console.warn(`    Response structure:`, JSON.stringify(response.candidates?.[0]?.content || {}).substring(0, 200));
    return false;
  } catch (error: any) {
    console.error(`    ✗ Image generation failed: ${error.message}`);
    if (error.message.includes('not found') || error.message.includes('404')) {
      console.error(`    The model 'gemini-2.0-flash-exp-image-generation' may not be available.`);
    }
    return false;
  }
}

// Helper to parse JSON from LLM response (handles markdown fences)
export function parseLLMJson(text: string): any {
  // Try direct parse first
  try { return JSON.parse(text); } catch { }
  // Strip markdown code fences
  const stripped = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(stripped); } catch { }
  // Try to extract JSON object/array
  const objMatch = stripped.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch { } }
  const arrMatch = stripped.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch { } }
  throw new Error(`Failed to parse LLM JSON: ${text.substring(0, 200)}`);
}
