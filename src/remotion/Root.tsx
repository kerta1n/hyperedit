import React from 'react';
import { Composition } from 'remotion';
import { DynamicAnimation } from './DynamicAnimation';
import { ProjectTimeline } from './ProjectTimeline';
import type { RemotionProjectSpec } from '../shared/remotion-core';

// Props passed from the CLI via --props
export interface DynamicAnimationProps {
  scenes: Scene[];
  title?: string;
  backgroundColor?: string;
  totalDuration?: number;
}

export interface ShapeConfig {
  type: 'circle' | 'rect' | 'triangle' | 'star' | 'polygon' | 'ellipse';
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  delay?: number;
  radius?: number;
  width?: number;
  height?: number;
  cornerRadius?: number;
  length?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  points?: number;
  innerRadius?: number;
  outerRadius?: number;
  rx?: number;
  ry?: number;
  animation?: 'none' | 'pop' | 'spin' | 'bounce' | 'float' | 'pulse' | 'draw';
}

export interface EmojiConfig {
  emoji: string; // Emoji character or name
  x?: number;
  y?: number;
  scale?: number;
  delay?: number;
  animation?: 'none' | 'pop' | 'bounce' | 'float' | 'pulse' | 'spin' | 'shake' | 'wave';
}

export interface GifConfig {
  src: string; // URL to the GIF
  x?: number; // Position as percentage (0-100)
  y?: number; // Position as percentage (0-100)
  width?: number; // Width in pixels
  height?: number; // Height in pixels
  scale?: number; // Size multiplier
  delay?: number; // Animation delay in frames
  loop?: boolean; // Whether to loop the GIF
  fit?: 'fill' | 'contain' | 'cover';
  playbackRate?: number; // Speed multiplier
  animation?: 'none' | 'pop' | 'bounce' | 'float' | 'pulse' | 'spin' | 'shake';
}

export interface LottieConfig {
  src: string; // URL to Lottie JSON file
  x?: number; // Position as percentage (0-100)
  y?: number; // Position as percentage (0-100)
  width?: number; // Width in pixels
  height?: number; // Height in pixels
  scale?: number; // Size multiplier
  delay?: number; // Animation delay in frames
  loop?: boolean; // Whether to loop
  playbackRate?: number; // Speed multiplier
  direction?: 'forward' | 'backward';
}

export interface Scene {
  id: string;
  type: 'title' | 'steps' | 'features' | 'stats' | 'text' | 'transition' | 'media' | 'chart' | 'countdown' | 'comparison' | 'shapes' | 'emoji' | 'gif' | 'lottie';
  duration: number; // in frames
  content: SceneContent;
  transition?: {
    type: 'none' | 'fade' | 'swipe-left' | 'swipe-right' | 'swipe-up' | 'swipe-down' | 'zoom-in' | 'zoom-out' | 'wipe-left' | 'wipe-right' | 'blur' | 'flip';
    duration?: number;
  };
}

export interface SceneContent {
  // For title/text scenes
  title?: string;
  subtitle?: string;
  // For steps/features scenes
  items?: Array<{
    icon?: string;
    label: string;
    description?: string;
    value?: number;
    color?: string;
  }>;
  // For stats scenes with counting animation
  stats?: Array<{
    value: string;
    label: string;
    numericValue?: number; // For animated counting
    prefix?: string;
    suffix?: string;
  }>;
  // Styling
  color?: string;
  backgroundColor?: string;
  // For shapes scenes
  shapes?: ShapeConfig[];
  shapesLayout?: 'scattered' | 'grid' | 'circle' | 'custom';
  // For emoji scenes
  emojis?: EmojiConfig[];
  emojiLayout?: 'scattered' | 'grid' | 'circle' | 'row' | 'custom';
  // For gif scenes
  gifs?: GifConfig[];
  gifLayout?: 'scattered' | 'grid' | 'circle' | 'row' | 'fullscreen' | 'custom';
  gifBackground?: string; // URL to background GIF
  // For lottie scenes
  lotties?: LottieConfig[];
  lottieLayout?: 'scattered' | 'grid' | 'circle' | 'row' | 'fullscreen' | 'custom';
  lottieBackground?: string; // URL to background Lottie JSON
  // Camera movement (on entire scene)
  camera?: {
    type: 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down' | 'ken-burns' | 'shake';
    intensity?: number;
  };
  // For media scenes - enhanced
  mediaAssetId?: string;
  mediaPath?: string;
  mediaType?: 'image' | 'video';
  mediaStyle?: 'fullscreen' | 'framed' | 'pip' | 'background' | 'split-left' | 'split-right' | 'circle' | 'phone-frame';
  // Video-specific controls
  videoStartFrom?: number; // Start from this frame
  videoEndAt?: number; // End at this frame
  videoVolume?: number; // 0-1
  videoPlaybackRate?: number; // 0.5 = slow-mo, 2 = fast
  videoLoop?: boolean;
  videoMuted?: boolean;
  // Media animation (applied to media itself)
  mediaAnimation?: {
    type: 'none' | 'ken-burns' | 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down' | 'rotate' | 'parallax';
    intensity?: number;
  };
  // Overlay text on media
  overlayText?: string;
  overlayPosition?: 'top' | 'center' | 'bottom';
  overlayStyle?: 'minimal' | 'bold' | 'gradient-bar';
  // For chart scenes
  chartType?: 'bar' | 'progress' | 'pie' | 'line';
  chartData?: Array<{ label: string; value: number; color?: string }>;
  maxValue?: number;
  // For countdown scenes
  countFrom?: number;
  countTo?: number;
  // For comparison scenes
  beforeLabel?: string;
  afterLabel?: string;
  beforeValue?: string;
  afterValue?: string;
  beforeMedia?: string;
  afterMedia?: string;
}

// Calculate duration from scenes
const calculateDuration = (props: DynamicAnimationProps): number => {
  if (props.totalDuration) {
    return props.totalDuration;
  }
  if (props.scenes && props.scenes.length > 0) {
    return props.scenes.reduce((sum, scene) => sum + (scene.duration || 60), 0);
  }
  return 300; // Default fallback
};

const defaultProjectSpec: RemotionProjectSpec = {
  version: '2.0',
  id: 'default-spec',
  title: 'Untitled Project',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  settings: {
    width: 1920,
    height: 1080,
    fps: 30,
    backgroundColor: '#000000',
  },
  tracks: [
    { id: 'T1', type: 'text', name: 'T1', order: 0 },
    { id: 'V3', type: 'video', name: 'V3', order: 1 },
    { id: 'V2', type: 'video', name: 'V2', order: 2 },
    { id: 'V1', type: 'video', name: 'V1', order: 3 },
    { id: 'A1', type: 'audio', name: 'A1', order: 4 },
    { id: 'A2', type: 'audio', name: 'A2', order: 5 },
  ],
  clips: [],
  captions: [],
  voiceover: [],
  transitions: [],
  brandTheme: {
    name: 'Default Theme',
    fontFamily: 'Inter',
    accentColor: '#f97316',
    secondaryColor: '#3b82f6',
    backgroundColor: '#000000',
    textColor: '#ffffff',
    glow: 0.3,
    motionSpeed: 1,
  },
  adTemplate: {
    name: 'hook-body-cta',
    segments: {
      hook: { id: 'hook', startSec: 0, endSec: 2, textOptions: ['Hook'], captionPreset: 'highlight-mode' },
      body: { id: 'body', startSec: 2, endSec: 6, textOptions: ['Body'], captionPreset: 'clean-lower-third' },
      cta: { id: 'cta', startSec: 6, endSec: 8, textOptions: ['CTA'], captionPreset: 'highlight-mode' },
    },
  },
};

const calculateProjectDuration = (spec: RemotionProjectSpec): number => {
  const fps = spec.settings.fps || 30;

  const clipMax = spec.clips.reduce((max, clip) => {
    return Math.max(max, clip.startSec + clip.durationSec);
  }, 0);

  const captionMax = spec.captions.reduce((max, caption) => {
    return Math.max(max, caption.endSec);
  }, 0);

  const voiceoverMax = (spec.voiceover || []).reduce((max, voice) => {
    const end = voice.startSec + (voice.durationSec || 0);
    return Math.max(max, end);
  }, 0);

  const durationSec = Math.max(2, clipMax, captionMax, voiceoverMax);
  return Math.max(1, Math.ceil(durationSec * fps));
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="DynamicAnimation"
        component={DynamicAnimation}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          scenes: [],
          backgroundColor: '#0a0a0a',
        }}
        calculateMetadata={({ props }) => {
          return {
            durationInFrames: calculateDuration(props as DynamicAnimationProps),
          };
        }}
      />
      <Composition
        id="ProjectTimeline"
        component={ProjectTimeline}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          spec: defaultProjectSpec,
        }}
        calculateMetadata={({ props }) => {
          const spec = ((props as { spec?: RemotionProjectSpec })?.spec) ?? defaultProjectSpec;
          return {
            durationInFrames: calculateProjectDuration(spec),
            width: spec.settings.width,
            height: spec.settings.height,
            fps: spec.settings.fps,
          };
        }}
      />
    </>
  );
};
