import type { SessionRoute } from './route-table.ts';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { parseBody, sendJSON } from './http-helpers.ts';
import { requireSession, saveAssetMetadata } from './session-store.ts';
import { runFFmpeg } from './ffmpeg-helpers.ts';
import { callFal } from './fal-gateway.ts';
import { generateWithLLM, hasLLMProvider } from './llm-gateway.ts';

// Image generation lane (Picasso agent) through the generative provider
// gateway.



// Generate image using the generative provider (Picasso agent)
async function handleGenerateImage(req, res, sessionId) {
  const session = requireSession(res, sessionId);
  if (!session) return;

  const falApiKey = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!falApiKey) {
    sendJSON(res, { error: 'FAL_KEY or FAL_API_KEY not configured in .dev.vars' }, 500);
    return;
  }

  try {
    const body = await parseBody(req);
    const {
      prompt,
      aspectRatio = '16:9',
      resolution = '1K',
      numImages = 1
    } = body;

    if (!prompt) {
      sendJSON(res, { error: 'prompt is required' }, 400);
      return;
    }

    const jobId = sessionId.substring(0, 8);
    console.log(`\n[${jobId}] === PICASSO: GENERATE IMAGE ===`);
    console.log(`[${jobId}] User prompt: ${prompt}`);
    console.log(`[${jobId}] Aspect ratio: ${aspectRatio}, Resolution: ${resolution}`);

    // Enhance prompt using LLM for better image generation results
    let enhancedPrompt = prompt;
    if (hasLLMProvider()) {
      try {
        console.log(`[${jobId}] Enhancing prompt with Picasso AI...`);

        const systemPrompt = `You are Picasso, an expert AI prompt engineer specializing in image generation. Your role is to transform simple user requests into detailed, visually compelling prompts that produce stunning images.

## Your Expertise
- Deep knowledge of photography, cinematography, art styles, and visual composition
- Understanding of lighting (golden hour, studio, dramatic, soft, etc.)
- Mastery of artistic movements (impressionism, surrealism, photorealism, etc.)
- Knowledge of camera perspectives, lenses, and depth of field
- Understanding of color theory and mood creation

## Prompt Enhancement Guidelines

1. **Visual Details**: Add specific visual elements - textures, materials, colors, patterns
2. **Lighting**: Specify lighting conditions that enhance the mood (soft diffused light, dramatic rim lighting, golden hour glow, neon accents)
3. **Composition**: Include framing, perspective, and focal points (close-up, wide shot, bird's eye view, rule of thirds)
4. **Style**: Add artistic style when appropriate (cinematic, photorealistic, digital art, oil painting, etc.)
5. **Atmosphere**: Include mood and atmosphere descriptors (ethereal, moody, vibrant, serene, dynamic)
6. **Quality Markers**: Add quality enhancers (highly detailed, 8K, professional photography, masterpiece)

## Rules
- Keep the enhanced prompt under 200 words
- Preserve the user's core intent - don't change WHAT they want, enhance HOW it looks
- Don't add text/words to appear in the image unless requested
- Output ONLY the enhanced prompt, no explanations or markdown
- Make every image feel premium, professional, and visually striking`;

        const enhanced = await generateWithLLM(`Enhance this image prompt:\n\n"${prompt}"`, { systemPrompt });
        if (enhanced && enhanced.trim().length > 10) {
          enhancedPrompt = enhanced.trim();
          console.log(`[${jobId}] Enhanced prompt: ${enhancedPrompt.substring(0, 100)}...`);
        }
      } catch (enhanceError) {
        console.warn(`[${jobId}] Prompt enhancement failed, using original:`, enhanceError.message);
      }
    } else {
      console.log(`[${jobId}] No LLM provider, using original prompt`);
    }

    // Call the image-gen model with the enhanced prompt
    console.log(`[${jobId}] Sending to image-gen provider...`);
    const falResult = await callFal('fal-ai/nano-banana-pro', {
      prompt: enhancedPrompt,
      num_images: Math.min(numImages, 4),
      aspect_ratio: aspectRatio,
      resolution,
      output_format: 'png',
    }, jobId, { queue: false });
    console.log(`[${jobId}] Generated ${falResult.data?.images?.length || 0} images`);

    // SDK returns { data, requestId }
    const images = falResult.data?.images;
    if (!images || images.length === 0) {
      throw new Error('No images generated');
    }

    // Download and save each generated image as an asset
    const generatedAssets = [];

    for (let i = 0; i < images.length; i++) {
      const imageData = images[i];
      const imageId = randomUUID();
      const imagePath = join(session.assetsDir, `${imageId}.png`);
      const thumbPath = join(session.assetsDir, `${imageId}_thumb.jpg`);

      console.log(`[${jobId}] Downloading image ${i + 1}...`);

      // Download image
      const imageResponse = await fetch(imageData.url);
      if (!imageResponse.ok) {
        throw new Error(`Failed to download image: ${imageResponse.status}`);
      }

      const buffer = await imageResponse.arrayBuffer();
      writeFileSync(imagePath, Buffer.from(buffer));

      // Generate thumbnail
      try {
        await runFFmpeg([
          '-y', '-i', imagePath,
          '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
          '-frames:v', '1',
          thumbPath
        ], jobId);
      } catch (e) {
        console.warn(`[${jobId}] Thumbnail generation failed:`, e.message);
      }

      const { stat } = await import('fs/promises');
      const stats = await stat(imagePath);

      // Create short filename from prompt
      const shortPrompt = prompt.substring(0, 30).replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '-');

      const asset = {
        id: imageId,
        type: 'image',
        filename: `picasso-${shortPrompt}.png`,
        path: imagePath,
        thumbPath: existsSync(thumbPath) ? thumbPath : null,
        duration: 5, // Default 5 seconds for images on timeline
        size: stats.size,
        width: imageData.width || 1024,
        height: imageData.height || 1024,
        createdAt: Date.now(),
        aiGenerated: true,
        generatedBy: 'picasso',
        prompt: prompt, // Original user prompt
        enhancedPrompt: enhancedPrompt !== prompt ? enhancedPrompt : undefined, // Enhanced prompt if different
      };

      session.assets.set(imageId, asset);
      generatedAssets.push({
        id: imageId,
        filename: asset.filename,
        width: asset.width,
        height: asset.height,
        thumbnailUrl: `/session/${sessionId}/assets/${imageId}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${imageId}/stream`,
      });

      console.log(`[${jobId}] Saved image: ${asset.filename} (${(stats.size / 1024).toFixed(1)} KB)`);
    }

    saveAssetMetadata(session); // Persist asset metadata to disk
    console.log(`[${jobId}] === PICASSO COMPLETE ===\n`);

    sendJSON(res, {
      success: true,
      images: generatedAssets,
      description: falResult.description,
    });

  } catch (error) {
    console.error('Image generation error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}


export const imageGenRoutes: SessionRoute[] = [
  { method: 'POST', action: 'generate-image', handler: handleGenerateImage },
];
