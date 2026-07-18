import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_TRACKS,
  PROJECT_SCHEMA_VERSION,
  createDefaultProjectState,
  ensureProjectDefaults,
  migrateProject,
} from '../scripts/project-schema.js';

describe('migrateProject', () => {
  it('stamps unversioned projects as v1 (pre-ladder baseline)', () => {
    const migrated = migrateProject({ clips: [] });
    expect(migrated.version).toBe(1);
  });

  it('leaves a current-version project untouched apart from the stamp', () => {
    const project = { version: PROJECT_SCHEMA_VERSION, clips: [{ id: 'c1' }], custom: 'kept' };
    const migrated = migrateProject(project);
    expect(migrated).toEqual(project);
  });

  it('passes versions above ours through untouched (no downgrade)', () => {
    const future = { version: 99, futureField: { nested: true } };
    const migrated = migrateProject(future);
    expect(migrated.version).toBe(99);
    expect(migrated.futureField).toEqual({ nested: true });
  });

  it('ignores non-numeric version values', () => {
    expect(migrateProject({ version: '2' }).version).toBe(1);
  });
});

describe('createDefaultProjectState', () => {
  it('carries the schema version and the six-track layout', () => {
    const state = createDefaultProjectState();
    expect(state.version).toBe(PROJECT_SCHEMA_VERSION);
    expect(state.tracks).toEqual(DEFAULT_PROJECT_TRACKS);
    expect(state.settings).toEqual({ width: 1920, height: 1080, fps: 30 });
  });
});

describe('ensureProjectDefaults', () => {
  it('produces a fully defaulted, versioned project from nothing', () => {
    const project = ensureProjectDefaults();
    expect(project.version).toBe(PROJECT_SCHEMA_VERSION);
    expect(project.tracks).toHaveLength(6);
    expect(project.clips).toEqual([]);
    expect(project.captionData).toEqual({});
    expect(project.timelineTransitions).toEqual([]);
    expect(project.renderOptions).toBeNull();
  });

  it('preserves client-owned settings fields while enforcing dimension defaults', () => {
    const project = ensureProjectDefaults({
      settings: { captionSplitMode: 'left', width: 0 },
    });
    expect(project.settings.captionSplitMode).toBe('left');
    expect(project.settings.width).toBe(1920);
    expect(project.settings.height).toBe(1080);
    expect(project.settings.fps).toBe(30);
  });

  it('falls back to default tracks when tracks are missing or empty', () => {
    expect(ensureProjectDefaults({ tracks: [] }).tracks).toEqual(DEFAULT_PROJECT_TRACKS);
    const custom = [{ id: 'X1', type: 'video', name: 'X1', order: 0 }];
    expect(ensureProjectDefaults({ tracks: custom }).tracks).toEqual(custom);
  });

  it('hardens non-array collections', () => {
    const project = ensureProjectDefaults({ clips: 'garbage', transitions: null, timelineTransitions: 7 });
    expect(project.clips).toEqual([]);
    expect(project.transitions).toEqual([]);
    expect(project.timelineTransitions).toEqual([]);
  });

  it('merges partial brand themes over the default theme', () => {
    const project = ensureProjectDefaults({ brandTheme: { accentColor: '#123456' } });
    expect(project.brandTheme.accentColor).toBe('#123456');
    expect(project.brandTheme.fontFamily).toBe('Inter');
  });

  it('keeps the stored version across a defaults round-trip', () => {
    const project = ensureProjectDefaults({ version: PROJECT_SCHEMA_VERSION, clips: [] });
    expect(ensureProjectDefaults(project).version).toBe(PROJECT_SCHEMA_VERSION);
  });
});
