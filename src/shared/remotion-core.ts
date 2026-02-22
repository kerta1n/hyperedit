export type RemotionTrackType = 'video' | 'audio' | 'text';

export type CaptionPresetId = 'clean-lower-third' | 'highlight-mode';

export interface RemotionTransition {
  type: 'none' | 'fade' | 'slide-left' | 'slide-right' | 'zoom';
  durationSec: number;
}

export interface RemotionClipTransform {
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
}

export interface RemotionTrack {
  id: string;
  type: RemotionTrackType;
  name: string;
  order: number;
}

export interface RemotionClip {
  id: string;
  trackId: string;
  assetId?: string;
  src?: string;
  assetType?: 'video' | 'image' | 'audio';
  startSec: number;
  durationSec: number;
  inPointSec: number;
  outPointSec: number;
  playbackRate?: number;
  volume?: number;
  muted?: boolean;
  transform?: RemotionClipTransform;
  transitionIn?: RemotionTransition;
  transitionOut?: RemotionTransition;
  segmentRole?: 'hook' | 'body' | 'cta' | 'generic';
}

export interface RemotionCaptionWord {
  text: string;
  startSec: number;
  endSec: number;
}

export interface RemotionCaptionStyle {
  presetId: CaptionPresetId;
  fontFamily: string;
  fontSize: number;
  fontWeight: 'normal' | 'bold' | 'black';
  color: string;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  position: 'top' | 'center' | 'bottom';
  animation: 'none' | 'karaoke' | 'fade' | 'pop' | 'bounce' | 'typewriter' | 'highlight';
  highlightColor?: string;
  textCase?: 'none' | 'upper';
  maxWidthPercent?: number;
  lineHeight?: number;
  letterSpacing?: number;
  shadow?: boolean;
}

export interface RemotionCaption {
  id: string;
  clipId?: string;
  startSec: number;
  endSec: number;
  text: string;
  words?: RemotionCaptionWord[];
  style: RemotionCaptionStyle;
  segmentRole?: 'hook' | 'body' | 'cta' | 'generic';
}

export interface BrandTheme {
  name: string;
  fontFamily: string;
  accentColor: string;
  secondaryColor: string;
  backgroundColor: string;
  textColor: string;
  glow: number;
  motionSpeed: number;
}

export interface AdSegmentTemplate {
  id: 'hook' | 'body' | 'cta';
  startSec: number;
  endSec: number;
  textOptions: string[];
  captionPreset: CaptionPresetId;
}

export interface AdTemplate {
  name: string;
  segments: {
    hook: AdSegmentTemplate;
    body: AdSegmentTemplate;
    cta: AdSegmentTemplate;
  };
}

export interface VoiceoverLayer {
  assetId?: string;
  src?: string;
  startSec: number;
  durationSec?: number;
  volume: number;
}

export interface RemotionProjectSpec {
  version: '1.0';
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  settings: {
    width: number;
    height: number;
    fps: number;
    backgroundColor: string;
  };
  tracks: RemotionTrack[];
  clips: RemotionClip[];
  captions: RemotionCaption[];
  voiceover: VoiceoverLayer[];
  brandTheme: BrandTheme;
  adTemplate: AdTemplate;
  meta?: Record<string, unknown>;
}

export interface VariantGenerationOptions {
  count: number;
  hooks?: string[];
  bodies?: string[];
  ctas?: string[];
}

export const CAPTION_STYLE_PRESETS: Record<CaptionPresetId, Partial<RemotionCaptionStyle>> = {
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
    highlightColor: '#FDE047',
    backgroundColor: 'rgba(0,0,0,0.38)',
    maxWidthPercent: 90,
    lineHeight: 1.2,
    letterSpacing: 0.3,
    shadow: true,
  },
};
