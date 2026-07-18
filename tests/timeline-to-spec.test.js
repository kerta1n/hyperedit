import { describe, expect, it } from 'vitest';
import { timelineToRemotionSpec } from '../scripts/remotion-core/timeline-to-spec.js';

const SESSION_ID = 'test-session';

function buildSpec(overrides = {}) {
  return timelineToRemotionSpec({
    project: {
      settings: { width: 1920, height: 1080, fps: 30 },
      clips: [],
      ...overrides.project,
    },
    assets: overrides.assets || [],
    captionData: overrides.captionData || {},
    sessionId: SESSION_ID,
    ...overrides.args,
  });
}

describe('timelineToRemotionSpec', () => {
  it('converts a V1 clip into a spec clip with a session stream src', () => {
    const spec = buildSpec({
      project: {
        clips: [{ id: 'clip-1', trackId: 'V1', assetId: 'asset-1', start: 1, duration: 4, inPoint: 0.5, outPoint: 4.5 }],
      },
      assets: [{ id: 'asset-1', type: 'video' }],
    });

    expect(spec.version).toBe('2.0');
    expect(spec.clips).toHaveLength(1);
    const clip = spec.clips[0];
    expect(clip.src).toBe(`http://localhost:3333/session/${SESSION_ID}/assets/asset-1/stream`);
    expect(clip.startSec).toBe(1);
    expect(clip.durationSec).toBe(4);
    expect(clip.inPointSec).toBe(0.5);
    expect(clip.outPointSec).toBe(4.5);
  });

  it('converts clip-relative caption word timings to absolute spec times', () => {
    const spec = buildSpec({
      project: {
        clips: [
          { id: 'v1', trackId: 'V1', assetId: 'asset-1', start: 0, duration: 20 },
          { id: 'cap1', trackId: 'T1', assetId: '', start: 10, duration: 2 },
        ],
      },
      assets: [{ id: 'asset-1', type: 'video' }],
      captionData: {
        cap1: { words: [{ text: 'hello', start: 0.5, end: 0.9 }, { text: 'world', start: 1.0, end: 1.4 }] },
      },
    });

    expect(spec.captions).toHaveLength(1);
    const caption = spec.captions[0];
    expect(caption.clipId).toBe('cap1');
    expect(caption.startSec).toBe(10);
    expect(caption.endSec).toBe(12);
    expect(caption.words[0]).toMatchObject({ text: 'hello', startSec: 10.5, endSec: 10.9 });
    expect(caption.words[1]).toMatchObject({ text: 'world', startSec: 11.0, endSec: 11.4 });
    // Caption clips never become media clips
    expect(spec.clips.map((c) => c.id)).toEqual(['v1']);
  });

  it('routes A2 audio clips into the voiceover lane', () => {
    const spec = buildSpec({
      project: {
        clips: [{ id: 'vo', trackId: 'A2', assetId: 'audio-1', start: 2, duration: 6 }],
      },
      assets: [{ id: 'audio-1', type: 'audio' }],
    });

    expect(spec.voiceover).toHaveLength(1);
    expect(spec.voiceover[0]).toMatchObject({ assetId: 'audio-1', startSec: 2, durationSec: 6 });
  });

  it('passes clip transforms through untouched', () => {
    const transform = { x: 10, y: -20, scale: 0.5, rotation: 15, opacity: 0.8 };
    const spec = buildSpec({
      project: {
        clips: [{ id: 'clip-1', trackId: 'V2', assetId: 'asset-1', start: 0, duration: 3, transform }],
      },
      assets: [{ id: 'asset-1', type: 'video' }],
    });

    expect(spec.clips[0].transform).toMatchObject(transform);
  });
});
