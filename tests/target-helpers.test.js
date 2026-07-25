import { describe, it, expect } from 'vitest';
import { deriveTimelineVideoTarget } from '../src/react-app/utils/target-helpers.ts';

const video = (id, aiGenerated = false) => ({ id, type: 'video', aiGenerated });
const image = (id) => ({ id, type: 'image', aiGenerated: false });
const audio = (id) => ({ id, type: 'audio', aiGenerated: false });
const clip = (id, trackId, assetId, start) => ({ id, trackId, assetId, start });

describe('deriveTimelineVideoTarget', () => {
  it('returns null when no video is on the timeline, even with videos in the library', () => {
    const assets = [video('v1'), video('v2')];
    expect(deriveTimelineVideoTarget([], assets)).toBeNull();
  });

  it('picks the earliest video clip across all V tracks, not V1 specifically', () => {
    const assets = [video('base'), video('overlay')];
    const clips = [
      clip('c1', 'V1', 'base', 5),
      clip('c2', 'V2', 'overlay', 1),
    ];
    const target = deriveTimelineVideoTarget(clips, assets);
    expect(target.asset.id).toBe('overlay');
    expect(target.clip.id).toBe('c2');
  });

  it('is independent of asset-library order', () => {
    const clips = [clip('c1', 'V1', 'base', 0)];
    const a = deriveTimelineVideoTarget(clips, [video('other'), video('base')]);
    const b = deriveTimelineVideoTarget(clips, [video('base'), video('other')]);
    expect(a.asset.id).toBe('base');
    expect(b.asset.id).toBe('base');
  });

  it('lets an explicitly selected video clip win over the earliest', () => {
    const assets = [video('base'), video('late')];
    const clips = [
      clip('c1', 'V1', 'base', 0),
      clip('c2', 'V2', 'late', 10),
    ];
    const target = deriveTimelineVideoTarget(clips, assets, { selectedClipId: 'c2' });
    expect(target.asset.id).toBe('late');
  });

  it('ignores a selected clip that is not a video (audio track or image asset)', () => {
    const assets = [video('base'), audio('a'), image('img')];
    const clips = [
      clip('c1', 'V1', 'base', 0),
      clip('c2', 'A1', 'a', 0),
      clip('c3', 'V2', 'img', 0),
    ];
    expect(deriveTimelineVideoTarget(clips, assets, { selectedClipId: 'c2' }).asset.id).toBe('base');
    expect(deriveTimelineVideoTarget(clips, assets, { selectedClipId: 'c3' }).asset.id).toBe('base');
  });

  it('does not treat image or audio clips on tracks as video candidates', () => {
    const assets = [image('img'), audio('a')];
    const clips = [clip('c1', 'V1', 'img', 0), clip('c2', 'A1', 'a', 0)];
    expect(deriveTimelineVideoTarget(clips, assets)).toBeNull();
  });

  it('preferNonAi picks the earliest non-AI video over an earlier AI one', () => {
    const assets = [video('gen', true), video('source')];
    const clips = [
      clip('c1', 'V2', 'gen', 0),
      clip('c2', 'V1', 'source', 3),
    ];
    const target = deriveTimelineVideoTarget(clips, assets, { preferNonAi: true });
    expect(target.asset.id).toBe('source');
  });

  it('preferNonAi falls back to an AI video when nothing else is on the timeline', () => {
    const assets = [video('gen', true)];
    const clips = [clip('c1', 'V2', 'gen', 0)];
    const target = deriveTimelineVideoTarget(clips, assets, { preferNonAi: true });
    expect(target.asset.id).toBe('gen');
  });
});
