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
  const clipEnd = (spec.clips || []).reduce((max, clip) => Math.max(max, (clip.startSec || 0) + (clip.durationSec || 0)), 0);
  const captionEnd = (spec.captions || []).reduce((max, caption) => Math.max(max, caption.endSec || 0), 0);
  const voiceEnd = (spec.voiceover || []).reduce((max, voice) => {
    const end = (voice.startSec || 0) + (voice.durationSec || 0);
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
  const presetId = style.presetId || fallbackPreset;
  const preset = CAPTION_PRESETS[presetId] || CAPTION_PRESETS['clean-lower-third'];
  return {
    ...preset,
    ...style,
    presetId,
  };
}

export function normalizeSpec(rawSpec = {}) {
  const now = new Date().toISOString();
  const spec = {
    version: '1.0',
    id: rawSpec.id || `spec-${Date.now()}`,
    title: rawSpec.title || 'Untitled HyperEdit Project',
    createdAt: rawSpec.createdAt || now,
    updatedAt: rawSpec.updatedAt || now,
    settings: {
      width: rawSpec.settings?.width || 1920,
      height: rawSpec.settings?.height || 1080,
      fps: rawSpec.settings?.fps || 30,
      backgroundColor: rawSpec.settings?.backgroundColor || '#000000',
    },
    tracks: (rawSpec.tracks && rawSpec.tracks.length ? rawSpec.tracks : DEFAULT_TRACKS)
      .map((track, index) => ({
        id: track.id || `track-${index}`,
        type: track.type || 'video',
        name: track.name || track.id || `Track ${index + 1}`,
        order: Number.isFinite(track.order) ? track.order : index,
      }))
      .sort((a, b) => a.order - b.order),
    clips: (rawSpec.clips || []).map((clip, index) => ({
      id: clip.id || `clip-${index}`,
      trackId: clip.trackId || 'V1',
      assetId: clip.assetId,
      src: clip.src,
      assetType: clip.assetType || 'video',
      startSec: Math.max(0, clip.startSec || 0),
      durationSec: Math.max(0.05, clip.durationSec || 0.05),
      inPointSec: Math.max(0, clip.inPointSec || 0),
      outPointSec: Number.isFinite(clip.outPointSec) ? clip.outPointSec : ((clip.inPointSec || 0) + (clip.durationSec || 0.05)),
      playbackRate: Number.isFinite(clip.playbackRate) ? clip.playbackRate : 1,
      volume: Number.isFinite(clip.volume) ? clip.volume : 1,
      muted: Boolean(clip.muted),
      transform: clip.transform || {},
      transitionIn: clip.transitionIn || { type: 'none', durationSec: 0 },
      transitionOut: clip.transitionOut || { type: 'none', durationSec: 0 },
      segmentRole: clip.segmentRole || 'generic',
    })),
    captions: (rawSpec.captions || []).map((caption, index) => {
      const text = caption.text || '';
      return {
        id: caption.id || `caption-${index}`,
        clipId: caption.clipId,
        startSec: Math.max(0, caption.startSec || 0),
        endSec: Math.max(caption.startSec || 0.05, caption.endSec || ((caption.startSec || 0) + 0.05)),
        text,
        words: caption.words || textToWords(text, caption.startSec || 0, caption.endSec || (caption.startSec || 0) + 0.05),
        style: normalizeCaptionStyle(caption.style || {}),
        segmentRole: caption.segmentRole || 'generic',
      };
    }),
    voiceover: (rawSpec.voiceover || []).map((voice) => ({
      assetId: voice.assetId,
      src: voice.src,
      startSec: Math.max(0, voice.startSec || 0),
      durationSec: Number.isFinite(voice.durationSec) ? voice.durationSec : undefined,
      volume: Number.isFinite(voice.volume) ? voice.volume : 1,
    })),
    brandTheme: createDefaultBrandTheme(rawSpec.brandTheme || {}),
    adTemplate: rawSpec.adTemplate || createHookBodyCtaTemplate(getSpecDurationSec(rawSpec)),
    meta: rawSpec.meta || {},
  };

  if (!spec.adTemplate?.segments) {
    spec.adTemplate = createHookBodyCtaTemplate(getSpecDurationSec(spec));
  }

  spec.captions = tagCaptionSegments(spec.captions, spec.adTemplate);
  return spec;
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

export function generateAdVariants(baseSpecInput, options = {}) {
  const baseSpec = normalizeSpec(baseSpecInput);
  const count = Math.max(1, Number(options.count || 1));

  const template = baseSpec.adTemplate || createHookBodyCtaTemplate(getSpecDurationSec(baseSpec));
  const hooks = options.hooks?.length ? options.hooks : template.segments.hook.textOptions;
  const bodies = options.bodies?.length ? options.bodies : template.segments.body.textOptions;
  const ctas = options.ctas?.length ? options.ctas : template.segments.cta.textOptions;

  const variants = [];

  for (let index = 0; index < count; index += 1) {
    const hook = pickFrom(hooks, index, template.segments.hook.textOptions[0] || 'Hook');
    const body = pickFrom(bodies, index * 2, template.segments.body.textOptions[0] || 'Body');
    const cta = pickFrom(ctas, index * 3, template.segments.cta.textOptions[0] || 'CTA');

    const variant = deepClone(baseSpec);
    variant.id = `${baseSpec.id}-v${index + 1}`;
    variant.title = `${baseSpec.title} • Variant ${index + 1}`;
    variant.updatedAt = new Date().toISOString();
    variant.meta = {
      ...(variant.meta || {}),
      variantIndex: index + 1,
      strategy: 'hook-body-cta-rotation',
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

      updated.text = text;
      updated.words = textToWords(text, caption.startSec, caption.endSec);
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
};
