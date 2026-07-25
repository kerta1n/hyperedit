import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { getMediaInfo, runFFmpeg } from './ffmpeg-helpers.ts';
import { sendJSON } from './http-helpers.ts';
import { saveAssetMetadata, sessions, type Session, type SessionAsset } from './session-store.ts';
import type { SessionRoute } from './route-table.ts';

// GIF search/add proxy + transcript keyword extraction that drives the
// auto-GIF flow.

// Known keywords/brands to detect in transcripts
const KNOWN_KEYWORDS = [
  // Tech companies
  'anthropic', 'claude', 'openai', 'chatgpt', 'gpt', 'google', 'gemini', 'bard',
  'microsoft', 'copilot', 'meta', 'llama', 'apple', 'siri', 'amazon', 'alexa',
  'nvidia', 'tesla', 'spacex', 'neuralink', 'twitter', 'x',
  // Social media
  'youtube', 'tiktok', 'instagram', 'facebook', 'snapchat', 'linkedin', 'reddit',
  'discord', 'twitch', 'spotify',
  // People
  'elon musk', 'sam altman', 'mark zuckerberg', 'sundar pichai', 'satya nadella',
  'tim cook', 'jensen huang', 'dario amodei', 'trump', 'biden',
  // General tech terms
  'artificial intelligence', 'machine learning', 'neural network', 'blockchain',
  'cryptocurrency', 'bitcoin', 'ethereum', 'nft', 'metaverse', 'virtual reality',
  'augmented reality', 'robotics', 'automation',
  // Products
  'iphone', 'android', 'windows', 'macbook', 'playstation', 'xbox', 'nintendo',
  'airpods', 'vision pro',
];

// Extract keywords from transcript with timestamps
export function extractKeywordsFromTranscript(transcript: string, words: any[]) {
  const foundKeywords: Array<{ keyword: string; timestamp: number; confidence: number }> = [];
  const lowerTranscript = transcript.toLowerCase();

  for (const keyword of KNOWN_KEYWORDS) {
    const lowerKeyword = keyword.toLowerCase();
    let searchIndex = 0;

    while (true) {
      const index = lowerTranscript.indexOf(lowerKeyword, searchIndex);
      if (index === -1) break;

      // Find the timestamp for this occurrence
      // We need to count characters to find which word this belongs to
      let charCount = 0;
      let timestamp = 0;
      let confidence = 0.9;

      for (const word of words) {
        const wordEnd = charCount + word.word.length + 1; // +1 for space
        if (index >= charCount && index < wordEnd) {
          timestamp = word.start;
          confidence = word.confidence || 0.9;
          break;
        }
        charCount = wordEnd;
      }

      // Avoid duplicates within 5 seconds
      const isDuplicate = foundKeywords.some(
        k => k.keyword === keyword && Math.abs(k.timestamp - timestamp) < 5
      );

      if (!isDuplicate) {
        foundKeywords.push({
          keyword,
          timestamp,
          confidence,
        });
      }

      searchIndex = index + keyword.length;
    }
  }

  // Sort by timestamp
  foundKeywords.sort((a, b) => a.timestamp - b.timestamp);

  return foundKeywords;
}

// Search GIPHY for a keyword
export async function searchGiphy(keyword: string, limit = 1): Promise<any[]> {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey || apiKey === 'YOUR_GIPHY_API_KEY_HERE') {
    throw new Error('GIPHY_API_KEY not configured. Get a free key at https://developers.giphy.com/');
  }

  const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(keyword)}&limit=${limit}&rating=g&lang=en`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GIPHY API error: ${response.status}`);
  }

  const data: any = await response.json();
  return data.data || [];
}

// Download GIF and save as asset
export async function downloadGifAsAsset(session: Session, gifUrl: string, keyword: string, timestamp: number): Promise<SessionAsset> {
  const jobId = randomUUID();
  const gifId = randomUUID();
  const gifPath = join(session.assetsDir, `${gifId}.gif`);
  const thumbPath = join(session.assetsDir, `${gifId}_thumb.jpg`);

  try {
    console.log(`[${jobId}] Downloading GIF for "${keyword}"...`);

    const response = await fetch(gifUrl);
    if (!response.ok) {
      throw new Error(`Failed to download GIF: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    writeFileSync(gifPath, Buffer.from(buffer));

    // Generate thumbnail
    try {
      await runFFmpeg([
        '-y', '-i', gifPath,
        '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2',
        '-frames:v', '1',
        thumbPath
      ], jobId);
    } catch (e) {
      console.warn(`[${jobId}] Thumbnail generation failed:`, (e as Error).message);
    }

    const { stat } = await import('fs/promises');
    const stats = await stat(gifPath);

    // Get GIF dimensions
    const info = await getMediaInfo(gifPath);

    const asset: SessionAsset = {
      id: gifId,
      type: 'image',
      filename: `${keyword.replace(/\s+/g, '-')}.gif`,
      path: gifPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: 3, // Default 3 seconds for GIFs
      size: stats.size,
      width: info.width || 200,
      height: info.height || 200,
      createdAt: Date.now(),
      // Extra metadata for auto-placement
      keyword,
      timestamp,
    };

    session.assets.set(gifId, asset);

    console.log(`[${jobId}] GIF saved: ${(stats.size / 1024).toFixed(1)} KB`);

    return asset;

  } catch (error) {
    try { unlinkSync(gifPath); } catch { }
    try { unlinkSync(thumbPath); } catch { }
    throw error;
  }
}

// Search GIPHY for trending GIFs
async function searchGiphyTrending(limit = 20): Promise<any[]> {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey || apiKey === 'YOUR_GIPHY_API_KEY_HERE') {
    throw new Error('GIPHY_API_KEY not configured. Get a free key at https://developers.giphy.com/');
  }

  const url = `https://api.giphy.com/v1/gifs/trending?api_key=${apiKey}&limit=${limit}&rating=g`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GIPHY API error: ${response.status}`);
  }

  const data: any = await response.json();
  return data.data || [];
}

// Handle GIPHY search endpoint
async function handleGiphySearch(req: IncomingMessage, res: ServerResponse, sessionId: string, url: URL) {
  const session = sessions.get(sessionId);
  if (!session) {
    sendJSON(res, { error: 'Session not found' }, 404);
    return;
  }

  try {
    const query = url.searchParams.get('q') || '';
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    if (!query.trim()) {
      sendJSON(res, { error: 'Search query (q) is required' }, 400);
      return;
    }

    const gifs = await searchGiphy(query, limit);

    // Format response
    const results = gifs.map(gif => ({
      id: gif.id,
      title: gif.title,
      url: gif.images.original.url,
      previewUrl: gif.images.fixed_width.url,
      thumbnailUrl: gif.images.fixed_width_still?.url || gif.images.fixed_width.url,
      width: parseInt(gif.images.original.width, 10),
      height: parseInt(gif.images.original.height, 10),
      source: 'giphy',
    }));

    sendJSON(res, { gifs: results });
  } catch (error: any) {
    console.error('GIPHY search error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}

// Handle GIPHY trending endpoint
async function handleGiphyTrending(req: IncomingMessage, res: ServerResponse, sessionId: string, url: URL) {
  const session = sessions.get(sessionId);
  if (!session) {
    sendJSON(res, { error: 'Session not found' }, 404);
    return;
  }

  try {
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const gifs = await searchGiphyTrending(limit);

    // Format response
    const results = gifs.map(gif => ({
      id: gif.id,
      title: gif.title,
      url: gif.images.original.url,
      previewUrl: gif.images.fixed_width.url,
      thumbnailUrl: gif.images.fixed_width_still?.url || gif.images.fixed_width.url,
      width: parseInt(gif.images.original.width, 10),
      height: parseInt(gif.images.original.height, 10),
      source: 'giphy',
    }));

    sendJSON(res, { gifs: results });
  } catch (error: any) {
    console.error('GIPHY trending error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}

// Handle adding a GIPHY GIF to assets
async function handleGiphyAdd(req: IncomingMessage, res: ServerResponse, sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) {
    sendJSON(res, { error: 'Session not found' }, 404);
    return;
  }

  try {
    // Parse request body
    const body: any = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });

    const { gifUrl, title } = body;
    if (!gifUrl) {
      sendJSON(res, { error: 'gifUrl is required' }, 400);
      return;
    }

    // Download and add to assets
    const asset = await downloadGifAsAsset(session, gifUrl, title || 'GIF', Date.now());
    saveAssetMetadata(session); // Persist asset metadata to disk

    sendJSON(res, {
      success: true,
      asset: {
        id: asset.id,
        filename: asset.filename,
        type: asset.type,
        duration: asset.duration,
        width: asset.width,
        height: asset.height,
        thumbnailUrl: `/session/${sessionId}/assets/${asset.id}/thumbnail`,
        streamUrl: `/session/${sessionId}/assets/${asset.id}/stream`,
      }
    });
  } catch (error: any) {
    console.error('GIPHY add error:', error);
    sendJSON(res, { error: error.message }, 500);
  }
}

export const giphyRoutes: SessionRoute[] = [
  { method: 'GET', action: 'giphy/search', handler: handleGiphySearch },
  { method: 'GET', action: 'giphy/trending', handler: handleGiphyTrending },
  { method: 'POST', action: 'giphy/add', handler: handleGiphyAdd },
];
