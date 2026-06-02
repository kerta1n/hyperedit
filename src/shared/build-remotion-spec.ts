import type {
  RemotionProjectSpec,
  RemotionClip,
  RemotionCaption,
  RemotionCaptionStyle,
  RemotionCaptionWord,
  RemotionTrack,
  RemotionTimelineTransition,
  RemotionClipTransform,
  VoiceoverLayer,
  CaptionPresetId,
} from './remotion-core';
import { CAPTION_STYLE_PRESETS } from './remotion-core';

interface SourceClip {
  id: string;
  assetId: string;
  trackId: string;
  start: number;
  duration: number;
  inPoint: number;
  outPoint: number;
  transform?: RemotionClipTransform;
}

interface SourceTrack {
  id: string;
  type: 'video' | 'audio' | 'text';
  name: string;
  order: number;
  muted?: boolean;
}

interface SourceAsset {
  id: string;
  type: 'video' | 'image' | 'audio';
}

interface SourceCaptionWord {
  text: string;
  start: number;
  end: number;
}

interface SourceCaptionData {
  words: SourceCaptionWord[];
  style: Partial<RemotionCaptionStyle> & { presetId?: CaptionPresetId };
}

interface SourceTransition {
  id: string;
  startTime: number;
  durationSec: number;
  fromClipId: string | null;
  toClipId: string | null;
  transitionFileId: string;
  easing?: string;
  params: Record<string, number | string | boolean>;
}

interface SourceSettings {
  width: number;
  height: number;
  fps: number;
}

export interface BuildSpecInput {
  clips: SourceClip[];
  tracks: SourceTrack[];
  assets: SourceAsset[];
  captionData: Record<string, SourceCaptionData>;
  timelineTransitions: SourceTransition[];
  settings: SourceSettings;
}

export interface BuildSpecOptions {
  resolveSrc: (assetId: string) => string;
}

const DEFAULT_TRACKS: RemotionTrack[] = [
  { id: 'T1', type: 'text', name: 'T1', order: 0 },
  { id: 'V3', type: 'video', name: 'V3', order: 1 },
  { id: 'V2', type: 'video', name: 'V2', order: 2 },
  { id: 'V1', type: 'video', name: 'V1', order: 3 },
  { id: 'A1', type: 'audio', name: 'A1', order: 4 },
  { id: 'A2', type: 'audio', name: 'A2', order: 5 },
];

function normalizeCaptionStyle(
  style: Partial<RemotionCaptionStyle>,
  fallbackPreset: CaptionPresetId = 'clean-lower-third',
): RemotionCaptionStyle {
  const presetId: CaptionPresetId =
    (style.presetId && CAPTION_STYLE_PRESETS[style.presetId]) ? style.presetId : fallbackPreset;
  const preset = CAPTION_STYLE_PRESETS[presetId] ?? CAPTION_STYLE_PRESETS['clean-lower-third'];
  return {
    ...preset,
    ...style,
    presetId,
  } as RemotionCaptionStyle;
}

function textToWords(text: string, startSec: number, endSec: number): RemotionCaptionWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const duration = Math.max(0.05, endSec - startSec);
  const perWord = duration / tokens.length;
  return tokens.map((token, i) => ({
    text: token,
    startSec: startSec + i * perWord,
    endSec: i === tokens.length - 1 ? endSec : startSec + (i + 1) * perWord,
  }));
}

export function buildRemotionSpec(
  input: BuildSpecInput,
  options: BuildSpecOptions,
): RemotionProjectSpec {
  const { clips: sourceClips, tracks: sourceTracks, assets, captionData, timelineTransitions, settings } = input;
  const { resolveSrc } = options;

  const tracks: RemotionTrack[] = (sourceTracks.length > 0 ? sourceTracks : DEFAULT_TRACKS)
    .map((t, i) => ({
      id: t.id,
      type: t.type,
      name: t.name || t.id,
      order: Number.isFinite(t.order) ? t.order : i,
      muted: t.muted,
    }))
    .sort((a, b) => a.order - b.order);

  const trackMap = new Map(tracks.map(t => [t.id, t]));
  const assetMap = new Map(assets.map(a => [a.id, a]));

  const clips: RemotionClip[] = [];
  const captions: RemotionCaption[] = [];
  const voiceover: VoiceoverLayer[] = [];

  for (const clip of sourceClips) {
    const track = trackMap.get(clip.trackId);
    const startSec = Math.max(0, clip.start || 0);
    const durationSec = Math.max(0.05, clip.duration || 0.05);
    const inPointSec = Math.max(0, clip.inPoint || 0);
    const outPointSec = Number.isFinite(clip.outPoint) ? clip.outPoint : inPointSec + durationSec;

    if (track?.type === 'text' || clip.trackId === 'T1') {
      const data = captionData[clip.id];
      if (!data) continue;
      const words = data.words || [];
      const text = words.length ? words.map(w => w.text).join(' ') : '';
      const captionStartSec = startSec;
      const captionEndSec = startSec + durationSec;

      const convertedWords: RemotionCaptionWord[] = words.length
        ? words.map(w => ({
            text: w.text,
            startSec: captionStartSec + (w.start || 0),
            endSec: captionStartSec + (w.end || 0),
          }))
        : textToWords(text, captionStartSec, captionEndSec);

      captions.push({
        id: `cap-${clip.id}`,
        clipId: clip.id,
        startSec: captionStartSec,
        endSec: captionEndSec,
        text,
        words: convertedWords,
        style: normalizeCaptionStyle(data.style || {}),
      });
      continue;
    }

    const asset = assetMap.get(clip.assetId);
    const assetType = asset?.type || (track?.type === 'audio' ? 'audio' : 'video');
    const src = resolveSrc(clip.assetId);

    const remotionClip: RemotionClip = {
      id: clip.id,
      trackId: clip.trackId,
      assetId: clip.assetId,
      src,
      assetType,
      startSec,
      durationSec,
      inPointSec,
      outPointSec,
      playbackRate: 1,
      volume: 1,
      muted: track?.muted || false,
      transform: clip.transform || {},
    };

    clips.push(remotionClip);

    if ((track?.type === 'audio' || assetType === 'audio') && clip.trackId === 'A2') {
      voiceover.push({
        assetId: clip.assetId,
        src,
        startSec,
        durationSec,
        volume: 1,
      });
    }
  }

  const tlTransitions: RemotionTimelineTransition[] = timelineTransitions.map(t => ({
    id: t.id,
    startTime: t.startTime,
    durationSec: t.durationSec,
    fromClipId: t.fromClipId,
    toClipId: t.toClipId,
    transitionFileId: t.transitionFileId,
    easing: t.easing,
    params: t.params,
  }));

  const durationSec = Math.max(
    2,
    sourceClips.reduce((max, c) => Math.max(max, (c.start || 0) + (c.duration || 0)), 0),
  );

  const hookEnd = Math.max(1.5, durationSec * 0.2);
  const ctaStart = Math.max(hookEnd + 0.5, durationSec * 0.78);

  return {
    version: '2.0',
    id: `preview-${Date.now()}`,
    title: 'HyperEdit Preview',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: {
      width: settings.width || 1920,
      height: settings.height || 1080,
      fps: settings.fps || 30,
      backgroundColor: '#000000',
    },
    tracks,
    clips,
    captions,
    voiceover,
    timelineTransitions: tlTransitions.length > 0 ? tlTransitions : undefined,
    brandTheme: {
      name: 'HyperEdit Growth Theme',
      fontFamily: 'Inter',
      accentColor: '#f97316',
      secondaryColor: '#22d3ee',
      backgroundColor: '#0a0a0a',
      textColor: '#ffffff',
      glow: 0.4,
      motionSpeed: 1,
    },
    adTemplate: {
      name: 'hook-body-cta',
      segments: {
        hook: { id: 'hook', startSec: 0, endSec: hookEnd, textOptions: ['Hook'], captionPreset: 'highlight-mode' },
        body: { id: 'body', startSec: hookEnd, endSec: ctaStart, textOptions: ['Body'], captionPreset: 'clean-lower-third' },
        cta: { id: 'cta', startSec: ctaStart, endSec: durationSec, textOptions: ['CTA'], captionPreset: 'highlight-mode' },
      },
    },
  };
}
