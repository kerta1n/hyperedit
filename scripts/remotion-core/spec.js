import { z } from 'zod';

export const SPEC_VERSION_V1 = '1.0';
export const SPEC_VERSION_V2 = '2.0';

const LEGACY_TRANSITION_TYPES = new Set(['none', 'fade', 'slide-left', 'slide-right', 'zoom']);
const JUNCTION_TRANSITION_TYPES = new Set(['none', 'crossfade', 'slide-left', 'slide-right', 'dip-to-black']);
const EASING_TYPES = new Set(['linear', 'ease-in', 'ease-out', 'ease-in-out']);

const CAPTION_PRESETS = {
  'clean-lower-third': {
    presetId: 'clean-lower-third',
    fontFamily: 'Inter',
    fontSize: 52,
    fontWeight: 'bold',
    color: '#FFFFFF',
    strokeColor: '#000000',
    strokeWidth: 4,
    position: 'bottom',
    animation: 'fade',
    backgroundColor: 'rgba(0,0,0,0.45)',
    highlightColor: '#FFD700',
    textCase: 'none',
    maxWidthPercent: 86,
    lineHeight: 1.2,
    letterSpacing: 0.2,
    shadow: true,
  },
  'highlight-mode': {
    presetId: 'highlight-mode',
    fontFamily: 'Inter',
    fontSize: 58,
    fontWeight: 'black',
    color: '#FFFFFF',
    strokeColor: '#0A0A0A',
    strokeWidth: 5,
    position: 'bottom',
    animation: 'highlight',
    backgroundColor: 'rgba(0,0,0,0.38)',
    highlightColor: '#FDE047',
    textCase: 'upper',
    maxWidthPercent: 90,
    lineHeight: 1.2,
    letterSpacing: 0.3,
    shadow: true,
  },
};

const DEFAULT_TRACKS = [
  { id: 'T1', type: 'text', name: 'T1', order: 0 },
  { id: 'V3', type: 'video', name: 'V3', order: 1 },
  { id: 'V2', type: 'video', name: 'V2', order: 2 },
  { id: 'V1', type: 'video', name: 'V1', order: 3 },
  { id: 'A1', type: 'audio', name: 'A1', order: 4 },
  { id: 'A2', type: 'audio', name: 'A2', order: 5 },
];

const TONE_PROFILES = {
  'direct-response': {
    id: 'direct-response',
    hookPrefix: ['Stop scrolling: ', 'Quick truth: '],
    ctaSuffix: ' today.',
  },
  educational: {
    id: 'educational',
    hookPrefix: ['Here’s the logic: ', 'Let’s break it down: '],
    ctaSuffix: ' Learn more.',
  },
  playful: {
    id: 'playful',
    hookPrefix: ['🔥 ', '✨ '],
    ctaSuffix: ' Let’s go!',
  },
  premium: {
    id: 'premium',
    hookPrefix: ['Premium fix: ', 'High-performance move: '],
    ctaSuffix: ' Upgrade now.',
  },
};

const CAPTION_STYLE_PROFILES = {
  balanced: {
    hook: {},
    body: {},
    cta: {},
  },
  punchy: {
    hook: { textCase: 'upper', animation: 'pop', fontWeight: 'black', fontSizeDelta: 6 },
    body: { animation: 'fade', fontSizeDelta: 2 },
    cta: { textCase: 'upper', animation: 'highlight', fontWeight: 'black', fontSizeDelta: 4 },
  },
  minimal: {
    hook: { animation: 'fade', backgroundColor: 'rgba(0,0,0,0.2)', strokeWidth: 2, fontSizeDelta: -4 },
    body: { animation: 'fade', backgroundColor: 'rgba(0,0,0,0.22)', strokeWidth: 2, fontSizeDelta: -5 },
    cta: { animation: 'fade', backgroundColor: 'rgba(0,0,0,0.24)', strokeWidth: 2, fontSizeDelta: -3 },
  },
};

const zLegacyTransition = z.object({
  type: z.enum(['none', 'fade', 'slide-left', 'slide-right', 'zoom']).default('none'),
  durationSec: z.number().finite().min(0).default(0),
  easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']).optional(),
}).passthrough();

const zJunctionTransition = z.object({
  id: z.string().min(1),
  fromClipId: z.string().min(1),
  toClipId: z.string().min(1),
  type: z.enum(['none', 'crossfade', 'slide-left', 'slide-right', 'dip-to-black']),
  durationSec: z.number().finite().min(0),
  easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']).optional(),
  fallbackBehavior: z.enum(['cut', 'clamp', 'crossfade']).optional(),
}).passthrough();

const zCaptionStyle = z.object({
  presetId: z.enum(['clean-lower-third', 'highlight-mode']),
  fontFamily: z.string(),
  fontSize: z.number().finite().min(8),
  fontWeight: z.enum(['normal', 'bold', 'black']),
  color: z.string(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().finite().min(0).optional(),
  position: z.enum(['top', 'center', 'bottom']),
  animation: z.enum(['none', 'karaoke', 'fade', 'pop', 'bounce', 'typewriter', 'highlight']),
  highlightColor: z.string().optional(),
  textCase: z.enum(['none', 'upper']).optional(),
  maxWidthPercent: z.number().finite().min(1).max(100).optional(),
  lineHeight: z.number().finite().min(0.5).max(3).optional(),
  letterSpacing: z.number().finite().min(-10).max(20).optional(),
  shadow: z.boolean().optional(),
}).passthrough();

const zClipTransform = z.object({
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  scale: z.number().finite().optional(),
  rotation: z.number().finite().optional(),
  opacity: z.number().finite().optional(),
}).passthrough();

const zTrack = z.object({
  id: z.string().min(1),
  type: z.enum(['video', 'audio', 'text']),
  name: z.string().min(1),
  order: z.number().finite(),
}).passthrough();

const zClip = z.object({
  id: z.string().min(1),
  trackId: z.string().min(1),
  assetId: z.string().optional(),
  src: z.string().optional(),
  assetType: z.enum(['video', 'image', 'audio']).optional(),
  startSec: z.number().finite().min(0),
  durationSec: z.number().finite().positive(),
  inPointSec: z.number().finite().min(0),
  outPointSec: z.number().finite().min(0),
  playbackRate: z.number().finite().positive().optional(),
  volume: z.number().finite().min(0).max(4).optional(),
  muted: z.boolean().optional(),
  transform: zClipTransform.optional(),
  transitionIn: zLegacyTransition.optional(),
  transitionOut: zLegacyTransition.optional(),
  segmentRole: z.enum(['hook', 'body', 'cta', 'generic']).optional(),
}).passthrough();

const zCaptionWord = z.object({
  text: z.string(),
  startSec: z.number().finite().min(0),
  endSec: z.number().finite().min(0),
}).passthrough();

const zCaption = z.object({
  id: z.string().min(1),
  clipId: z.string().optional(),
  startSec: z.number().finite().min(0),
  endSec: z.number().finite().min(0),
  text: z.string(),
  words: z.array(zCaptionWord).optional(),
  style: zCaptionStyle,
  segmentRole: z.enum(['hook', 'body', 'cta', 'generic']).optional(),
}).passthrough();

const zVoiceover = z.object({
  assetId: z.string().optional(),
  src: z.string().optional(),
  startSec: z.number().finite().min(0),
  durationSec: z.number().finite().positive().optional(),
  volume: z.number().finite().min(0).max(4),
}).passthrough();

const zBrandTheme = z.object({
  name: z.string(),
  fontFamily: z.string(),
  accentColor: z.string(),
  secondaryColor: z.string(),
  backgroundColor: z.string(),
  textColor: z.string(),
  glow: z.number().finite().min(0).max(1),
  motionSpeed: z.number().finite().min(0.25).max(3),
}).passthrough();

const zAdSegment = z.object({
  id: z.enum(['hook', 'body', 'cta']),
  startSec: z.number().finite().min(0),
  endSec: z.number().finite().min(0),
  textOptions: z.array(z.string()),
  captionPreset: z.enum(['clean-lower-third', 'highlight-mode']),
}).passthrough();

const zAdTemplate = z.object({
  name: z.string(),
  segments: z.object({
    hook: zAdSegment,
    body: zAdSegment,
    cta: zAdSegment,
  }).passthrough(),
}).passthrough();

const zSpecV2 = z.object({
  version: z.literal(SPEC_VERSION_V2),
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  settings: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    backgroundColor: z.string(),
  }).passthrough(),
  tracks: z.array(zTrack),
  clips: z.array(zClip),
  captions: z.array(zCaption),
  voiceover: z.array(zVoiceover),
  transitions: z.array(zJunctionTransition),
  brandTheme: zBrandTheme,
  adTemplate: zAdTemplate,
  meta: z.record(z.any()).optional(),
}).passthrough().superRefine((spec, ctx) => {
  const clipMap = new Map(spec.clips.map((clip) => [clip.id, clip]));

  spec.transitions.forEach((transition, index) => {
    const from = clipMap.get(transition.fromClipId);
    const to = clipMap.get(transition.toClipId);

    if (!from) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Transition references missing fromClipId: ${transition.fromClipId}`,
        path: ['transitions', index, 'fromClipId'],
      });
    }

    if (!to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Transition references missing toClipId: ${transition.toClipId}`,
        path: ['transitions', index, 'toClipId'],
      });
    }

    if (from && to && from.trackId !== to.trackId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Transition clips must be on same track (${from.trackId} vs ${to.trackId})`,
        path: ['transitions', index],
      });
    }
  });
});

function numberOr(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function positiveNumberOr(value, fallback, min = 0.0001) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function stringOr(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function arrayOr(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function ensureLegacyTransition(value, fallbackType = 'none') {
  const type = LEGACY_TRANSITION_TYPES.has(value?.type) ? value.type : fallbackType;
  return {
    type,
    durationSec: Math.max(0, numberOr(value?.durationSec, 0)),
    easing: EASING_TYPES.has(value?.easing) ? value.easing : 'ease-in-out',
  };
}

function ensureJunctionTransition(value, index = 0) {
  const type = JUNCTION_TRANSITION_TYPES.has(value?.type) ? value.type : 'none';
  return {
    id: stringOr(value?.id, `transition-${index + 1}`),
    fromClipId: stringOr(value?.fromClipId, ''),
    toClipId: stringOr(value?.toClipId, ''),
    type,
    durationSec: Math.max(0, numberOr(value?.durationSec, 0)),
    easing: EASING_TYPES.has(value?.easing) ? value.easing : 'ease-in-out',
    fallbackBehavior: value?.fallbackBehavior === 'cut' || value?.fallbackBehavior === 'crossfade' ? value.fallbackBehavior : 'clamp',
  };
}

function mapLegacyTransitionToJunction(type) {
  if (type === 'fade') return 'crossfade';
  if (type === 'slide-left') return 'slide-left';
  if (type === 'slide-right') return 'slide-right';
  return 'none';
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createDefaultBrandTheme(overrides = {}) {
  return {
    name: 'HyperEdit Growth Theme',
    fontFamily: 'Inter',
    accentColor: '#f97316',
    secondaryColor: '#22d3ee',
    backgroundColor: '#0a0a0a',
    textColor: '#ffffff',
    glow: 0.4,
    motionSpeed: 1,
    ...overrides,
  };
}

function getSpecDurationSec(spec) {
  const clipEnd = (spec.clips || []).reduce((max, clip) => Math.max(max, numberOr(clip.startSec, 0) + numberOr(clip.durationSec, 0)), 0);
  const captionEnd = (spec.captions || []).reduce((max, caption) => Math.max(max, numberOr(caption.endSec, 0)), 0);
  const voiceEnd = (spec.voiceover || []).reduce((max, voice) => {
    const end = numberOr(voice.startSec, 0) + numberOr(voice.durationSec, 0);
    return Math.max(max, end);
  }, 0);
  return Math.max(2, clipEnd, captionEnd, voiceEnd);
}

export function createHookBodyCtaTemplate(durationSec = 8, overrides = {}) {
  const hookEnd = Math.max(1.5, durationSec * 0.2);
  const ctaStart = Math.max(hookEnd + 0.5, durationSec * 0.78);

  return {
    name: 'hook-body-cta',
    segments: {
      hook: {
        id: 'hook',
        startSec: 0,
        endSec: hookEnd,
        textOptions: [
          'Stop scrolling: your sleep setup is broken.',
          'Your neck pain is coming from your pillow.',
          'This one upgrade changed my mornings overnight.',
        ],
        captionPreset: 'highlight-mode',
      },
      body: {
        id: 'body',
        startSec: hookEnd,
        endSec: ctaStart,
        textOptions: [
          'Cloud Pillow gives ergonomic support, cooling airflow, and all-night comfort.',
          'Memory-gel core + breathable shell = deep sleep without overheating.',
          'Built for side and back sleepers, with premium pressure relief.',
        ],
        captionPreset: 'clean-lower-third',
      },
      cta: {
        id: 'cta',
        startSec: ctaStart,
        endSec: durationSec,
        textOptions: [
          'Tap to get 30% off today.',
          'Shop now and wake up pain-free.',
          'Try Cloud Pillow risk-free tonight.',
        ],
        captionPreset: 'highlight-mode',
      },
    },
    ...overrides,
  };
}

export function normalizeCaptionStyle(style = {}, fallbackPreset = 'clean-lower-third') {
  const presetId = CAPTION_PRESETS[style.presetId] ? style.presetId : fallbackPreset;
  const preset = CAPTION_PRESETS[presetId] || CAPTION_PRESETS['clean-lower-third'];

  return {
    ...preset,
    ...style,
    presetId,
    fontFamily: stringOr(style.fontFamily, preset.fontFamily),
    fontSize: clamp(numberOr(style.fontSize, preset.fontSize), 8, 220),
    fontWeight: style.fontWeight === 'normal' || style.fontWeight === 'bold' || style.fontWeight === 'black'
      ? style.fontWeight
      : preset.fontWeight,
    color: stringOr(style.color, preset.color),
    position: style.position === 'top' || style.position === 'center' || style.position === 'bottom'
      ? style.position
      : preset.position,
    animation: ['none', 'karaoke', 'fade', 'pop', 'bounce', 'typewriter', 'highlight'].includes(style.animation)
      ? style.animation
      : preset.animation,
    textCase: style.textCase === 'upper' ? 'upper' : 'none',
    shadow: typeof style.shadow === 'boolean' ? style.shadow : Boolean(preset.shadow),
  };
}

function getRoleForTime(timeSec, adTemplate) {
  const segments = adTemplate?.segments;
  if (!segments) return 'generic';
  if (timeSec >= segments.hook.startSec && timeSec < segments.hook.endSec) return 'hook';
  if (timeSec >= segments.body.startSec && timeSec < segments.body.endSec) return 'body';
  if (timeSec >= segments.cta.startSec && timeSec <= segments.cta.endSec) return 'cta';
  return 'generic';
}

export function tagCaptionSegments(captions = [], adTemplate) {
  return captions.map((caption) => ({
    ...caption,
    segmentRole: caption.segmentRole || getRoleForTime(caption.startSec || 0, adTemplate),
  }));
}

export function textToWords(text = '', startSec = 0, endSec = 1) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];

  const duration = Math.max(0.05, endSec - startSec);
  const perWord = duration / tokens.length;

  return tokens.map((token, index) => ({
    text: token,
    startSec: startSec + index * perWord,
    endSec: index === tokens.length - 1 ? endSec : startSec + (index + 1) * perWord,
  }));
}

function normalizeTemplate(template, durationSec) {
  if (template?.segments?.hook && template?.segments?.body && template?.segments?.cta) {
    return {
      ...createHookBodyCtaTemplate(durationSec),
      ...template,
      segments: {
        hook: {
          ...createHookBodyCtaTemplate(durationSec).segments.hook,
          ...(template.segments.hook || {}),
          id: 'hook',
          textOptions: arrayOr(template.segments.hook?.textOptions, []),
        },
        body: {
          ...createHookBodyCtaTemplate(durationSec).segments.body,
          ...(template.segments.body || {}),
          id: 'body',
          textOptions: arrayOr(template.segments.body?.textOptions, []),
        },
        cta: {
          ...createHookBodyCtaTemplate(durationSec).segments.cta,
          ...(template.segments.cta || {}),
          id: 'cta',
          textOptions: arrayOr(template.segments.cta?.textOptions, []),
        },
      },
    };
  }

  return createHookBodyCtaTemplate(durationSec);
}

function normalizeTracks(rawTracks = []) {
  return (rawTracks.length ? rawTracks : DEFAULT_TRACKS)
    .map((track, index) => ({
      id: stringOr(track.id, `track-${index + 1}`),
      type: track.type === 'audio' || track.type === 'text' ? track.type : 'video',
      name: stringOr(track.name, track.id || `Track ${index + 1}`),
      order: numberOr(track.order, index),
    }))
    .sort((a, b) => a.order - b.order);
}

function normalizeClips(rawClips = []) {
  return rawClips.map((clip, index) => {
    const startSec = Math.max(0, numberOr(clip.startSec, 0));
    const durationSec = positiveNumberOr(clip.durationSec, 0.05, 0.05);
    const inPointSec = Math.max(0, numberOr(clip.inPointSec, 0));
    const outPointSec = Number.isFinite(clip.outPointSec)
      ? Math.max(inPointSec, Number(clip.outPointSec))
      : inPointSec + durationSec;

    return {
      id: stringOr(clip.id, `clip-${index + 1}`),
      trackId: stringOr(clip.trackId, 'V1'),
      assetId: typeof clip.assetId === 'string' ? clip.assetId : undefined,
      src: typeof clip.src === 'string' ? clip.src : undefined,
      assetType: clip.assetType === 'image' || clip.assetType === 'audio' ? clip.assetType : 'video',
      startSec,
      durationSec,
      inPointSec,
      outPointSec,
      playbackRate: positiveNumberOr(clip.playbackRate, 1, 0.05),
      volume: clamp(numberOr(clip.volume, 1), 0, 4),
      muted: Boolean(clip.muted),
      transform: clip.transform || {},
      transitionIn: ensureLegacyTransition(clip.transitionIn, 'none'),
      transitionOut: ensureLegacyTransition(clip.transitionOut, 'none'),
      segmentRole: clip.segmentRole === 'hook' || clip.segmentRole === 'body' || clip.segmentRole === 'cta'
        ? clip.segmentRole
        : 'generic',
    };
  });
}

function normalizeCaptions(rawCaptions = []) {
  return rawCaptions.map((caption, index) => {
    const startSec = Math.max(0, numberOr(caption.startSec, 0));
    const endSec = Math.max(startSec + 0.05, numberOr(caption.endSec, startSec + 0.05));
    const text = stringOr(caption.text, '');

    const words = Array.isArray(caption.words)
      ? caption.words.map((word) => ({
        text: stringOr(word.text, ''),
        startSec: Math.max(startSec, numberOr(word.startSec, startSec)),
        endSec: Math.max(startSec, numberOr(word.endSec, endSec)),
      }))
      : textToWords(text, startSec, endSec);

    return {
      id: stringOr(caption.id, `caption-${index + 1}`),
      clipId: typeof caption.clipId === 'string' ? caption.clipId : undefined,
      startSec,
      endSec,
      text,
      words,
      style: normalizeCaptionStyle(caption.style || {}),
      segmentRole: caption.segmentRole === 'hook' || caption.segmentRole === 'body' || caption.segmentRole === 'cta'
        ? caption.segmentRole
        : 'generic',
    };
  });
}

function normalizeVoiceover(rawVoiceover = []) {
  return rawVoiceover.map((voice) => ({
    assetId: typeof voice.assetId === 'string' ? voice.assetId : undefined,
    src: typeof voice.src === 'string' ? voice.src : undefined,
    startSec: Math.max(0, numberOr(voice.startSec, 0)),
    durationSec: Number.isFinite(voice.durationSec) ? positiveNumberOr(voice.durationSec, 0.05, 0.05) : undefined,
    volume: clamp(numberOr(voice.volume, 1), 0, 4),
  }));
}

function deriveTransitionsFromLegacyClips(clips = []) {
  const byTrack = new Map();

  for (const clip of clips) {
    const list = byTrack.get(clip.trackId) || [];
    list.push(clip);
    byTrack.set(clip.trackId, list);
  }

  const transitions = [];

  for (const trackClips of byTrack.values()) {
    const sorted = [...trackClips].sort((a, b) => {
      if (a.startSec !== b.startSec) return a.startSec - b.startSec;
      return a.id.localeCompare(b.id);
    });

    for (let i = 0; i < sorted.length - 1; i += 1) {
      const fromClip = sorted[i];
      const toClip = sorted[i + 1];
      const preferred = toClip.transitionIn?.durationSec > 0 ? toClip.transitionIn : fromClip.transitionOut;
      const type = mapLegacyTransitionToJunction(preferred?.type);
      const durationSec = Math.max(0, numberOr(preferred?.durationSec, 0));

      if (type === 'none' || durationSec <= 0) continue;

      transitions.push({
        id: `legacy-${fromClip.id}-${toClip.id}`,
        fromClipId: fromClip.id,
        toClipId: toClip.id,
        type,
        durationSec,
        easing: EASING_TYPES.has(preferred?.easing) ? preferred.easing : 'ease-in-out',
        fallbackBehavior: 'clamp',
      });
    }
  }

  return transitions;
}

function clampTransitionsToOverlap(clips = [], rawTransitions = []) {
  const clipMap = new Map(clips.map((clip) => [clip.id, clip]));
  const normalized = [];
  const warnings = [];

  rawTransitions.forEach((transition, index) => {
    const clean = ensureJunctionTransition(transition, index);
    if (clean.type === 'none' || clean.durationSec <= 0) {
      return;
    }

    const from = clipMap.get(clean.fromClipId);
    const to = clipMap.get(clean.toClipId);
    if (!from || !to) {
      warnings.push(`Skipped transition ${clean.id}: missing clip reference`);
      return;
    }

    if (from.trackId !== to.trackId) {
      warnings.push(`Skipped transition ${clean.id}: clips are on different tracks (${from.trackId} vs ${to.trackId})`);
      return;
    }

    const overlapSec = (from.startSec + from.durationSec) - to.startSec;
    if (overlapSec <= 0) {
      warnings.push(`Skipped transition ${clean.id}: clips do not overlap`);
      return;
    }

    const clampedDuration = Math.min(clean.durationSec, overlapSec);
    if (clampedDuration < clean.durationSec) {
      warnings.push(`Clamped transition ${clean.id} from ${clean.durationSec.toFixed(3)}s to ${clampedDuration.toFixed(3)}s to fit overlap`);
    }

    normalized.push({
      ...clean,
      durationSec: clampedDuration,
    });
  });

  return {
    transitions: normalized,
    warnings,
  };
}

function normalizeBaseSpec(rawSpec = {}) {
  const now = new Date().toISOString();
  const tracks = normalizeTracks(arrayOr(rawSpec.tracks));
  const clips = normalizeClips(arrayOr(rawSpec.clips));
  const captions = normalizeCaptions(arrayOr(rawSpec.captions));
  const voiceover = normalizeVoiceover(arrayOr(rawSpec.voiceover));
  const durationSec = getSpecDurationSec({ clips, captions, voiceover });
  const adTemplate = normalizeTemplate(rawSpec.adTemplate, durationSec);

  const spec = {
    version: SPEC_VERSION_V1,
    id: stringOr(rawSpec.id, `spec-${Date.now()}`),
    title: stringOr(rawSpec.title, 'Untitled HyperEdit Project'),
    createdAt: stringOr(rawSpec.createdAt, now),
    updatedAt: stringOr(rawSpec.updatedAt, now),
    settings: {
      width: Math.max(16, Math.round(numberOr(rawSpec.settings?.width, 1920))),
      height: Math.max(16, Math.round(numberOr(rawSpec.settings?.height, 1080))),
      fps: Math.max(1, Math.round(numberOr(rawSpec.settings?.fps, 30))),
      backgroundColor: stringOr(rawSpec.settings?.backgroundColor, '#000000'),
    },
    tracks,
    clips,
    captions,
    voiceover,
    brandTheme: createDefaultBrandTheme(rawSpec.brandTheme || {}),
    adTemplate,
    meta: typeof rawSpec.meta === 'object' && rawSpec.meta && !Array.isArray(rawSpec.meta) ? rawSpec.meta : {},
  };

  spec.captions = tagCaptionSegments(spec.captions, spec.adTemplate);
  return spec;
}

export class RemotionSpecValidationError extends Error {
  constructor(message, issues = [], payload = {}) {
    super(message);
    this.name = 'RemotionSpecValidationError';
    this.issues = issues;
    this.payload = payload;
  }
}

export function formatZodIssues(issues = []) {
  return issues.map((issue) => ({
    path: Array.isArray(issue.path) ? issue.path.join('.') : '',
    message: issue.message,
    code: issue.code,
  }));
}

export function migrateSpecToV2(rawSpec = {}, { fromVersion } = {}) {
  const base = normalizeBaseSpec(rawSpec);
  const sourceVersion = fromVersion || stringOr(rawSpec.version, SPEC_VERSION_V1);

  const rawTransitions = arrayOr(rawSpec.transitions).length > 0
    ? rawSpec.transitions
    : deriveTransitionsFromLegacyClips(base.clips);

  const { transitions, warnings } = clampTransitionsToOverlap(base.clips, rawTransitions);

  return {
    ...base,
    version: SPEC_VERSION_V2,
    transitions,
    meta: {
      ...(base.meta || {}),
      migration: {
        fromVersion: sourceVersion,
        toVersion: SPEC_VERSION_V2,
        migratedAt: new Date().toISOString(),
      },
      transitionWarnings: warnings,
    },
  };
}

export function validateSpecV2(spec) {
  const parsed = zSpecV2.safeParse(spec);
  if (!parsed.success) {
    throw new RemotionSpecValidationError(
      'Invalid Remotion spec payload',
      formatZodIssues(parsed.error.issues),
      {
        code: 'INVALID_REMOTION_SPEC',
      },
    );
  }

  return parsed.data;
}

export function parseSpecInput(rawSpec = {}, options = {}) {
  if (!rawSpec || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
    throw new RemotionSpecValidationError(
      'Spec must be a JSON object',
      [{ path: '', message: 'Expected object', code: 'invalid_type' }],
      {
        code: 'INVALID_REMOTION_SPEC',
        source: options.source || 'unknown',
      },
    );
  }

  const requestedVersion = stringOr(rawSpec.version, SPEC_VERSION_V1);
  let migrated = false;
  let normalized;

  if (requestedVersion === SPEC_VERSION_V2) {
    normalized = migrateSpecToV2(rawSpec, { fromVersion: SPEC_VERSION_V2 });
    normalized.meta = {
      ...(normalized.meta || {}),
      migration: {
        fromVersion: SPEC_VERSION_V2,
        toVersion: SPEC_VERSION_V2,
        migratedAt: new Date().toISOString(),
      },
    };
  } else if (requestedVersion === SPEC_VERSION_V1 || requestedVersion === '' || requestedVersion === 'v1') {
    normalized = migrateSpecToV2(rawSpec, { fromVersion: SPEC_VERSION_V1 });
    migrated = true;
  } else {
    throw new RemotionSpecValidationError(
      `Unsupported spec version: ${requestedVersion}`,
      [{ path: 'version', message: `Unsupported version ${requestedVersion}`, code: 'custom' }],
      {
        code: 'UNSUPPORTED_REMOTION_SPEC_VERSION',
        supportedVersions: [SPEC_VERSION_V1, SPEC_VERSION_V2],
      },
    );
  }

  const spec = validateSpecV2(normalized);

  return {
    spec,
    migration: {
      migrated,
      fromVersion: requestedVersion || SPEC_VERSION_V1,
      toVersion: SPEC_VERSION_V2,
    },
    warnings: arrayOr(spec.meta?.transitionWarnings),
  };
}

export function normalizeSpec(rawSpec = {}) {
  return parseSpecInput(rawSpec, { source: 'normalizeSpec' }).spec;
}

function replaceTemplateTokens(text, values) {
  return text
    .replaceAll('{{HOOK}}', values.hook)
    .replaceAll('{{BODY}}', values.body)
    .replaceAll('{{CTA}}', values.cta);
}

function pickFrom(values = [], index = 0, fallback = '') {
  if (!values.length) return fallback;
  return values[index % values.length];
}

function resolvePool(primary, secondary, fallback = []) {
  if (Array.isArray(primary) && primary.length) return primary;
  if (Array.isArray(secondary) && secondary.length) return secondary;
  return fallback;
}

function canonicalText(text) {
  return stringOr(text, '').replace(/\s+/g, ' ').trim();
}

function withSentenceEnding(text) {
  const clean = canonicalText(text);
  if (!clean) return clean;
  if (/[.!?]$/.test(clean)) return clean;
  return `${clean}.`;
}

function applyToneProfile(text, role, toneProfile, index) {
  const clean = canonicalText(text);
  if (!clean) return clean;

  const profile = TONE_PROFILES[toneProfile] || null;
  if (!profile) {
    return withSentenceEnding(clean);
  }

  let output = clean;

  if (role === 'hook' && profile.hookPrefix?.length) {
    const prefix = profile.hookPrefix[index % profile.hookPrefix.length];
    if (!output.toLowerCase().startsWith(prefix.toLowerCase())) {
      output = `${prefix}${output.charAt(0).toLowerCase()}${output.slice(1)}`;
    }
  }

  if (role === 'cta' && profile.ctaSuffix) {
    const noPunctuation = output.replace(/[.!?]+$/, '');
    if (!noPunctuation.toLowerCase().includes(profile.ctaSuffix.trim().toLowerCase().replace(/[.!?]/g, ''))) {
      output = `${noPunctuation}${profile.ctaSuffix}`;
    }
  }

  return withSentenceEnding(output);
}

function applyCaptionStyleProfile(style, role, captionStyleProfile) {
  const profile = CAPTION_STYLE_PROFILES[captionStyleProfile] || CAPTION_STYLE_PROFILES.balanced;
  const overrides = profile[role] || {};
  const { fontSizeDelta = 0, ...styleOverrides } = overrides;

  return normalizeCaptionStyle({
    ...style,
    ...styleOverrides,
    fontSize: clamp(numberOr(style.fontSize, 52) + fontSizeDelta, 18, 220),
  }, style.presetId || 'clean-lower-third');
}

export function generateAdVariants(baseSpecInput, options = {}) {
  const baseSpec = normalizeSpec(baseSpecInput);
  const count = Math.max(1, Math.round(numberOr(options.count, 1)));

  const template = baseSpec.adTemplate || createHookBodyCtaTemplate(getSpecDurationSec(baseSpec));

  const hooks = resolvePool(options.hookPool, options.hooks, template.segments.hook.textOptions);
  const bodies = resolvePool(options.bodyPool, options.bodies, template.segments.body.textOptions);
  const ctas = resolvePool(options.ctaPool, options.ctas, template.segments.cta.textOptions);

  const toneProfile = stringOr(options.toneProfile, 'direct-response');
  const captionStyleProfile = stringOr(options.captionStyleProfile, 'balanced');

  const variants = [];

  for (let index = 0; index < count; index += 1) {
    const rawHook = pickFrom(hooks, index, template.segments.hook.textOptions[0] || 'Hook');
    const rawBody = pickFrom(bodies, index * 2, template.segments.body.textOptions[0] || 'Body');
    const rawCta = pickFrom(ctas, index * 3, template.segments.cta.textOptions[0] || 'CTA');

    const hook = applyToneProfile(rawHook, 'hook', toneProfile, index);
    const body = applyToneProfile(rawBody, 'body', toneProfile, index);
    const cta = applyToneProfile(rawCta, 'cta', toneProfile, index);

    const variant = deepClone(baseSpec);
    variant.id = `${baseSpec.id}-v${index + 1}`;
    variant.title = `${baseSpec.title} • Variant ${index + 1}`;
    variant.updatedAt = new Date().toISOString();
    variant.meta = {
      ...(variant.meta || {}),
      variantIndex: index + 1,
      strategy: 'hook-body-cta-rotation-v2',
      profiles: {
        toneProfile,
        captionStyleProfile,
      },
      selections: { hook, body, cta },
    };

    variant.captions = variant.captions.map((caption) => {
      const updated = { ...caption };
      const currentRole = caption.segmentRole || getRoleForTime(caption.startSec, template);

      let text = replaceTemplateTokens(caption.text || '', { hook, body, cta });

      if (!caption.text || caption.text.trim().length === 0 || caption.text.includes('{{')) {
        if (currentRole === 'hook') text = hook;
        if (currentRole === 'body') text = body;
        if (currentRole === 'cta') text = cta;
      }

      if (currentRole === 'hook') {
        updated.style = normalizeCaptionStyle({ ...caption.style, presetId: template.segments.hook.captionPreset }, 'highlight-mode');
      } else if (currentRole === 'body') {
        updated.style = normalizeCaptionStyle({ ...caption.style, presetId: template.segments.body.captionPreset }, 'clean-lower-third');
      } else if (currentRole === 'cta') {
        updated.style = normalizeCaptionStyle({ ...caption.style, presetId: template.segments.cta.captionPreset }, 'highlight-mode');
      }

      if (currentRole === 'hook' || currentRole === 'body' || currentRole === 'cta') {
        updated.style = applyCaptionStyleProfile(updated.style, currentRole, captionStyleProfile);
      }

      updated.text = canonicalText(text);
      updated.words = textToWords(updated.text, caption.startSec, caption.endSec);
      updated.segmentRole = currentRole;
      return updated;
    });

    variants.push(variant);
  }

  return variants;
}

export {
  CAPTION_PRESETS,
  DEFAULT_TRACKS,
  TONE_PROFILES,
  CAPTION_STYLE_PROFILES,
};
