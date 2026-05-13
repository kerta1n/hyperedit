import {
  createDefaultBrandTheme,
  createHookBodyCtaTemplate,
  normalizeCaptionStyle,
  normalizeSpec,
  textToWords,
} from './spec.js';

const DEFAULT_TRACKS = [
  { id: 'T1', type: 'text', name: 'T1', order: 0 },
  { id: 'V3', type: 'video', name: 'V3', order: 1 },
  { id: 'V2', type: 'video', name: 'V2', order: 2 },
  { id: 'V1', type: 'video', name: 'V1', order: 3 },
  { id: 'A1', type: 'audio', name: 'A1', order: 4 },
  { id: 'A2', type: 'audio', name: 'A2', order: 5 },
];

function getProjectDurationSec(clips = []) {
  return clips.reduce((max, clip) => Math.max(max, (clip.start || 0) + (clip.duration || 0)), 0);
}

function inferSegmentRole(clip, adTemplate) {
  const start = clip.startSec || 0;
  const segments = adTemplate?.segments;
  if (!segments) return 'generic';

  if (start >= segments.hook.startSec && start < segments.hook.endSec) return 'hook';
  if (start >= segments.body.startSec && start < segments.body.endSec) return 'body';
  if (start >= segments.cta.startSec && start <= segments.cta.endSec) return 'cta';
  return 'generic';
}

function buildAssetSrc({ sessionId, assetId, asset, baseUrl = 'http://localhost:3333' }) {
  if (asset?.publicPath) {
    return asset.publicPath;
  }

  if (asset?.path && !sessionId) {
    return asset.path;
  }

  if (sessionId && assetId) {
    return `${baseUrl}/session/${sessionId}/assets/${assetId}/stream`;
  }

  return asset?.path || '';
}

function convertCaptionWords(words = [], captionStartSec, captionEndSec, fallbackText) {
  if (!words.length) {
    return textToWords(fallbackText || '', captionStartSec, captionEndSec);
  }

  return words.map((word) => ({
    text: word.text,
    startSec: captionStartSec + (word.start || 0),
    endSec: captionStartSec + (word.end || 0),
  }));
}

export function timelineToRemotionSpec({
  project,
  assets = [],
  captionData = {},
  transitions: userTransitions = [],
  timelineTransitions: userTimelineTransitions = [],
  sessionId,
  baseUrl = 'http://localhost:3333',
  specId,
  title,
  brandTheme,
  adTemplate,
  defaultCaptionPreset = 'clean-lower-third',
}) {
  const safeProject = project || {};
  const tracks = (safeProject.tracks && safeProject.tracks.length ? safeProject.tracks : DEFAULT_TRACKS)
    .map((track, index) => ({
      id: track.id,
      type: track.type,
      name: track.name || track.id,
      order: Number.isFinite(track.order) ? track.order : index,
    }))
    .sort((a, b) => a.order - b.order);

  const trackMap = new Map(tracks.map((track) => [track.id, track]));
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const sourceClips = safeProject.clips || [];

  const durationSec = Math.max(2, getProjectDurationSec(sourceClips));
  const resolvedTemplate = adTemplate || createHookBodyCtaTemplate(durationSec);

  const clips = [];
  const captions = [];
  const voiceover = [];

  for (const clip of sourceClips) {
    const track = trackMap.get(clip.trackId);
    const startSec = Math.max(0, clip.start || 0);
    const durationSec = Math.max(0.05, clip.duration || 0.05);
    const inPointSec = Math.max(0, clip.inPoint || 0);
    const outPointSec = Number.isFinite(clip.outPoint) ? clip.outPoint : inPointSec + durationSec;

    if (track?.type === 'text' || clip.trackId === 'T1') {
      const data = captionData[clip.id];
      const words = data?.words || [];
      const text = words.length ? words.map((word) => word.text).join(' ') : '';
      const captionStartSec = startSec;
      const captionEndSec = startSec + durationSec;
      const role = inferSegmentRole({ startSec }, resolvedTemplate);

      const presetFromRole = role === 'hook' || role === 'cta' ? 'highlight-mode' : defaultCaptionPreset;

      captions.push({
        id: `cap-${clip.id}`,
        clipId: clip.id,
        startSec: captionStartSec,
        endSec: captionEndSec,
        text,
        words: convertCaptionWords(words, captionStartSec, captionEndSec, text),
        style: normalizeCaptionStyle(data?.style || {}, presetFromRole),
        segmentRole: role,
      });

      continue;
    }

    const asset = assetMap.get(clip.assetId);
    const assetType = asset?.type || (track?.type === 'audio' ? 'audio' : 'video');
    const role = inferSegmentRole({ startSec }, resolvedTemplate);

    const remotionClip = {
      id: clip.id,
      trackId: clip.trackId,
      assetId: clip.assetId,
      src: buildAssetSrc({ sessionId, assetId: clip.assetId, asset, baseUrl }),
      assetType,
      startSec,
      durationSec,
      inPointSec,
      outPointSec,
      playbackRate: 1,
      volume: 1,
      muted: track?.muted === true,
      transform: clip.transform || {},
      transitionIn: clip.transitionIn || { type: 'fade', durationSec: 0.12 },
      transitionOut: clip.transitionOut || { type: 'fade', durationSec: 0.12 },
      segmentRole: role,
    };

    clips.push(remotionClip);

    if (track?.type === 'audio' || assetType === 'audio') {
      if (clip.trackId === 'A2') {
        voiceover.push({
          assetId: clip.assetId,
          src: remotionClip.src,
          startSec,
          durationSec,
          volume: 1,
        });
      }
    }
  }

  const spec = normalizeSpec({
    version: '2.0',
    id: specId || `session-${sessionId || Date.now()}`,
    title: title || 'HyperEdit Remotion Project',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: {
      width: safeProject.settings?.width || 1920,
      height: safeProject.settings?.height || 1080,
      fps: safeProject.settings?.fps || 30,
      backgroundColor: '#000000',
    },
    tracks,
    clips,
    captions,
    voiceover,
    ...(userTransitions.length > 0 ? { transitions: userTransitions } : {}),
    ...(userTimelineTransitions.length > 0 ? { timelineTransitions: userTimelineTransitions } : {}),
    brandTheme: createDefaultBrandTheme(brandTheme || {}),
    adTemplate: resolvedTemplate,
    meta: {
      generatedBy: 'timeline-to-remotion-spec',
      source: 'hyperedit-session-project',
    },
  });

  return spec;
}
