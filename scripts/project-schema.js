// Project state schema: defaults + version migration ladder for project.json.
// Every server read/write path funnels through ensureProjectDefaults, so the
// ladder runs at one choke point. The render spec has its own versioning in
// remotion-core/spec.js (SPEC_VERSION_*, migrateSpecToV2).

export const PROJECT_SCHEMA_VERSION = 1;

// Migration ladder: entry N migrates a version-N project to N+1.
// Unversioned projects predate the ladder and are structurally v1
// (owner decision 2026-07-08: ladder starts at v1, no legacy migration).
const PROJECT_MIGRATIONS = {
  // 1: (project) => ({ ...project, newField: derive(project) }),
};

export function migrateProject(project = {}) {
  let current = {
    ...project,
    version: typeof project.version === 'number' ? project.version : 1,
  };
  while (current.version < PROJECT_SCHEMA_VERSION) {
    const step = PROJECT_MIGRATIONS[current.version];
    if (!step) break; // gap in the ladder — serve as-is, defaults pass hardens
    current = { ...step(current), version: current.version + 1 };
  }
  // Versions above ours (file written by a newer server) pass through untouched.
  return current;
}

export const DEFAULT_PROJECT_TRACKS = [
  { id: 'T1', type: 'text', name: 'T1', order: 0 },
  { id: 'V3', type: 'video', name: 'V3', order: 1 },
  { id: 'V2', type: 'video', name: 'V2', order: 2 },
  { id: 'V1', type: 'video', name: 'V1', order: 3 },
  { id: 'A1', type: 'audio', name: 'A1', order: 4 },
  { id: 'A2', type: 'audio', name: 'A2', order: 5 },
];

const DEFAULT_BRAND_THEME = {
  name: 'HyperEdit Growth Theme',
  fontFamily: 'Inter',
  accentColor: '#f97316',
  secondaryColor: '#22d3ee',
  backgroundColor: '#0a0a0a',
  textColor: '#ffffff',
  glow: 0.4,
  motionSpeed: 1,
};

export function createDefaultProjectState() {
  return {
    version: PROJECT_SCHEMA_VERSION,
    tracks: [...DEFAULT_PROJECT_TRACKS],
    clips: [],
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
    },
    captionData: {},
    transitions: [],
    brandTheme: { ...DEFAULT_BRAND_THEME },
    adTemplate: null,
  };
}

export function ensureProjectDefaults(project = {}) {
  const migrated = migrateProject(project);
  return {
    ...createDefaultProjectState(),
    ...migrated,
    tracks: Array.isArray(migrated.tracks) && migrated.tracks.length > 0
      ? migrated.tracks
      : [...DEFAULT_PROJECT_TRACKS],
    clips: Array.isArray(migrated.clips) ? migrated.clips : [],
    // Spread first so client-owned settings fields (e.g. captionSplitMode)
    // survive the defaults pass instead of being rebuilt away
    settings: {
      ...(migrated.settings || {}),
      width: migrated.settings?.width || 1920,
      height: migrated.settings?.height || 1080,
      fps: migrated.settings?.fps || 30,
    },
    captionData: migrated.captionData || {},
    transitions: Array.isArray(migrated.transitions) ? migrated.transitions : [],
    timelineTransitions: Array.isArray(migrated.timelineTransitions) ? migrated.timelineTransitions : [],
    brandTheme: {
      ...DEFAULT_BRAND_THEME,
      ...(migrated.brandTheme || {}),
    },
    adTemplate: migrated.adTemplate || null,
    renderOptions: migrated.renderOptions || null,
  };
}
