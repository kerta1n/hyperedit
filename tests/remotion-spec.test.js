import { describe, expect, it } from 'vitest';
import {
  RemotionSpecValidationError,
  SPEC_VERSION_V1,
  SPEC_VERSION_V2,
  normalizeCaptionStyle,
  normalizeSpec,
  parseSpecInput,
  textToWords,
} from '../scripts/remotion-core/spec.js';

describe('parseSpecInput versioning', () => {
  it('migrates a version-less spec from v1 to v2', () => {
    const { spec, migration } = parseSpecInput({});
    expect(spec.version).toBe(SPEC_VERSION_V2);
    expect(migration.migrated).toBe(true);
    expect(migration.fromVersion).toBe(SPEC_VERSION_V1);
  });

  it('accepts an explicit v2 spec without flagging migration', () => {
    const { spec, migration } = parseSpecInput({ version: SPEC_VERSION_V2 });
    expect(spec.version).toBe(SPEC_VERSION_V2);
    expect(migration.migrated).toBe(false);
  });

  it('rejects unsupported versions with a typed error', () => {
    try {
      parseSpecInput({ version: '3.0' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RemotionSpecValidationError);
      expect(err.payload.code).toBe('UNSUPPORTED_REMOTION_SPEC_VERSION');
      expect(err.payload.supportedVersions).toEqual([SPEC_VERSION_V1, SPEC_VERSION_V2]);
    }
  });

  it('rejects non-object payloads', () => {
    expect(() => parseSpecInput(null)).toThrow(RemotionSpecValidationError);
    expect(() => parseSpecInput([])).toThrow(RemotionSpecValidationError);
  });
});

describe('clip normalization', () => {
  it('clamps volume to [0, 4] and floors degenerate durations', () => {
    const spec = normalizeSpec({
      clips: [
        { id: 'loud', trackId: 'V1', volume: 9, durationSec: 0 },
        { id: 'negative', trackId: 'V1', volume: -3, durationSec: 1 },
      ],
    });
    const [loud, negative] = spec.clips;
    expect(loud.volume).toBe(4);
    expect(loud.durationSec).toBe(0.05);
    expect(negative.volume).toBe(0);
    expect(loud.playbackRate).toBe(1);
    expect(loud.muted).toBe(false);
  });
});

describe('junction transition clamping', () => {
  const overlappingClips = [
    { id: 'a', trackId: 'V1', startSec: 0, durationSec: 5 },
    { id: 'b', trackId: 'V1', startSec: 4, durationSec: 5 },
  ];

  it('clamps a transition longer than the clip overlap and records a warning', () => {
    const { spec, warnings } = parseSpecInput({
      clips: overlappingClips,
      transitions: [{ id: 't1', fromClipId: 'a', toClipId: 'b', type: 'crossfade', durationSec: 3 }],
    });
    expect(spec.transitions).toHaveLength(1);
    expect(spec.transitions[0].durationSec).toBe(1);
    expect(warnings.some((w) => w.includes('Clamped transition t1'))).toBe(true);
  });

  it('drops transitions between non-overlapping clips with a warning', () => {
    const { spec, warnings } = parseSpecInput({
      clips: [
        { id: 'a', trackId: 'V1', startSec: 0, durationSec: 2 },
        { id: 'b', trackId: 'V1', startSec: 5, durationSec: 2 },
      ],
      transitions: [{ id: 't2', fromClipId: 'a', toClipId: 'b', type: 'crossfade', durationSec: 1 }],
    });
    expect(spec.transitions).toHaveLength(0);
    expect(warnings.some((w) => w.includes('Skipped transition t2'))).toBe(true);
  });

  it('drops transitions referencing missing clips', () => {
    const { spec, warnings } = parseSpecInput({
      clips: overlappingClips,
      transitions: [{ id: 't3', fromClipId: 'a', toClipId: 'ghost', type: 'crossfade', durationSec: 1 }],
    });
    expect(spec.transitions).toHaveLength(0);
    expect(warnings.some((w) => w.includes('missing clip reference'))).toBe(true);
  });
});

describe('textToWords', () => {
  it('distributes words across the caption window in order', () => {
    const words = textToWords('hello brave world', 2, 5);
    expect(words).toHaveLength(3);
    expect(words[0].startSec).toBe(2);
    expect(words.at(-1).endSec).toBe(5);
    const texts = words.map((w) => w.text);
    expect(texts).toEqual(['hello', 'brave', 'world']);
  });

  it('returns an empty list for empty text', () => {
    expect(textToWords('', 0, 1)).toEqual([]);
  });
});

describe('normalizeCaptionStyle', () => {
  it('falls back to the clean-lower-third preset', () => {
    const style = normalizeCaptionStyle({});
    expect(style.presetId).toBe('clean-lower-third');
    expect(style.fontFamily).toBe('Inter');
  });

  it('keeps explicit overrides on top of the preset', () => {
    const style = normalizeCaptionStyle({ fontSize: 80 });
    expect(style.fontSize).toBe(80);
  });
});
