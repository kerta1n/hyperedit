import React, { useMemo } from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Video,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {
  RemotionCaption,
  RemotionCaptionStyle,
  RemotionClip,
  RemotionProjectSpec,
  RemotionTimelineTransition,
  RemotionTrack,
} from '../shared/remotion-core';
import { CAPTION_STYLE_PRESETS } from '../shared/remotion-core';
import { getTransition } from './transitions/registry';

interface ProjectTimelineProps {
  spec: RemotionProjectSpec;
}

// --- Resolved V2 transition ready for rendering ---
interface ResolvedTransition {
  id: string;
  transitionFileId: string;
  fromSrc: string | undefined;
  toSrc: string | undefined;
  fromAssetType: 'video' | 'image' | undefined;
  toAssetType: 'video' | 'image' | undefined;
  fromStartFrom: number;
  toStartFrom: number;
  startFrame: number;
  durationInFrames: number;
  params: Record<string, number | string | boolean>;
}

const DEFAULT_SPEC: RemotionProjectSpec = {
  version: '2.0',
  id: 'default-spec',
  title: 'Untitled',
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
    name: 'Default',
    fontFamily: 'Inter',
    accentColor: '#f97316',
    secondaryColor: '#3b82f6',
    backgroundColor: '#000000',
    textColor: '#ffffff',
    glow: 0.35,
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

const toFrames = (seconds: number, fps: number): number => Math.max(0, Math.round(seconds * fps));

const resolveCaptionStyle = (style: RemotionCaptionStyle): RemotionCaptionStyle => {
  const preset = CAPTION_STYLE_PRESETS[style.presetId] ?? {};
  return {
    ...preset,
    ...style,
  } as RemotionCaptionStyle;
};

const getTrackOrder = (trackId: string, tracks: RemotionTrack[]): number => {
  const track = tracks.find((t) => t.id === trackId);
  return track?.order ?? 999;
};

const clipTransformValues = (clip: RemotionClip) => {
  return {
    scale: clip.transform?.scale ?? 1,
    rotation: clip.transform?.rotation ?? 0,
    x: clip.transform?.x ?? 0,
    y: clip.transform?.y ?? 0,
    opacity: clip.transform?.opacity ?? 1,
  };
};

// --- Migration: convert legacy junction transitions to v2 timeline transitions ---
const migrateLegacyTransitions = (
  spec: RemotionProjectSpec,
): RemotionTimelineTransition[] => {
  if (!spec.transitions || spec.transitions.length === 0) return [];

  const clipMap = new Map(spec.clips.map((clip) => [clip.id, clip]));
  const result: RemotionTimelineTransition[] = [];

  const typeToFileId: Record<string, string> = {
    crossfade: 'builtin-crossfade',
    'slide-left': 'builtin-slide-left',
    'slide-right': 'builtin-slide-right',
    'dip-to-black': 'builtin-dip-to-black',
  };

  for (const t of spec.transitions) {
    const fromClip = clipMap.get(t.fromClipId);
    const toClip = clipMap.get(t.toClipId);
    if (!fromClip || !toClip) continue;

    const transitionFileId = t.type === 'custom'
      ? ((t as Record<string, unknown>).customTransitionId as string || 'builtin-crossfade')
      : (typeToFileId[t.type] || 'builtin-crossfade');

    // Compute startTime from clip overlap
    const fromEnd = fromClip.startSec + fromClip.durationSec;
    const overlapSec = fromEnd - toClip.startSec;
    const startTime = overlapSec > 0 ? toClip.startSec : fromEnd;

    result.push({
      id: t.id,
      startTime,
      durationSec: Math.min(t.durationSec, Math.max(0.01, overlapSec)),
      fromClipId: t.fromClipId,
      toClipId: t.toClipId,
      transitionFileId,
      easing: t.easing,
      params: {},
    });
  }

  return result;
};

// --- Resolve v2 timeline transitions for rendering ---
const resolveTimelineTransitions = (
  spec: RemotionProjectSpec,
  fps: number,
): ResolvedTransition[] => {
  // Prefer v2 timelineTransitions; fallback to migrated legacy transitions
  const sourceTransitions = (spec.timelineTransitions && spec.timelineTransitions.length > 0)
    ? spec.timelineTransitions
    : migrateLegacyTransitions(spec);

  if (sourceTransitions.length === 0) return [];

  const clipMap = new Map(spec.clips.map((clip) => [clip.id, clip]));
  const resolved: ResolvedTransition[] = [];

  for (const t of sourceTransitions) {
    const fromClip = t.fromClipId ? clipMap.get(t.fromClipId) : null;
    const toClip = t.toClipId ? clipMap.get(t.toClipId) : null;

    // Skip if both clips are null (no-op)
    if (!t.fromClipId && !t.toClipId) continue;
    // Skip if a referenced clip doesn't exist
    if (t.fromClipId && !fromClip) continue;
    if (t.toClipId && !toClip) continue;

    // Resolve clip sources:
    // - For null clipId: src is undefined (= black)
    // - For clips that cover the transition window: use their src directly
    // - For clips with a gap (don't cover the transition window): still use their src
    //   (Remotion will freeze-frame/extend the nearest frame)
    const fromSrc = fromClip?.src;
    const toSrc = toClip?.src;
    const fromAssetType = (fromClip?.assetType === 'video' || fromClip?.assetType === 'image')
      ? fromClip.assetType : undefined;
    const toAssetType = (toClip?.assetType === 'video' || toClip?.assetType === 'image')
      ? toClip.assetType : undefined;

    const startFrame = toFrames(t.startTime, fps);
    const durationInFrames = Math.max(1, toFrames(t.durationSec, fps));

    // Compute the frame offset into each clip's source media at the transition start.
    // This ensures the transition shows the correct frame, not frame 0.
    const fromStartFrom = fromClip
      ? toFrames((t.startTime - fromClip.startSec) + fromClip.inPointSec, fps)
      : 0;
    const toStartFrom = toClip
      ? toFrames((t.startTime - toClip.startSec) + toClip.inPointSec, fps)
      : 0;

    resolved.push({
      id: t.id,
      transitionFileId: t.transitionFileId,
      fromSrc,
      toSrc,
      fromAssetType,
      toAssetType,
      fromStartFrom,
      toStartFrom,
      startFrame,
      durationInFrames,
      params: t.params || {},
    });
  }

  return resolved;
};

// --- Transition Compositor: renders a single transition via its .tsx component ---
const TransitionCompositor: React.FC<{
  transition: ResolvedTransition;
}> = ({ transition }) => {
  const TransitionComp = getTransition(transition.transitionFileId);
  if (!TransitionComp) return null;

  return (
    <AbsoluteFill style={{ zIndex: 3500 }}>
      <TransitionComp
        fromSrc={transition.fromSrc}
        toSrc={transition.toSrc}
        fromAssetType={transition.fromAssetType}
        toAssetType={transition.toAssetType}
        fromStartFrom={transition.fromStartFrom}
        toStartFrom={transition.toStartFrom}
        params={transition.params}
      />
    </AbsoluteFill>
  );
};

const CaptionOverlay: React.FC<{
  caption: RemotionCaption;
  brandFont: string;
}> = ({ caption, brandFont }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const style = resolveCaptionStyle(caption.style);

  const globalTimeSec = caption.startSec + frame / fps;
  const activeWordIndex = caption.words?.findIndex((w) => globalTimeSec >= w.startSec && globalTimeSec < w.endSec) ?? -1;

  const enter = spring({
    frame,
    fps,
    config: { damping: 18, stiffness: 120 },
    durationInFrames: Math.min(12, Math.max(6, toFrames(0.4, fps))),
  });

  const offsetX = style.positionX ?? 0;
  const offsetY = style.positionY ?? 0;

  const positionStyle: React.CSSProperties = (() => {
    if (style.position === 'top') {
      return { top: `${7 + offsetY}%` };
    }
    if (style.position === 'center') {
      return { top: `${50 + offsetY}%`, transform: 'translate(-50%, -50%)' };
    }
    return { bottom: `${7 - offsetY}%` };
  })();

  const computedText = style.textCase === 'upper' ? caption.text.toUpperCase() : caption.text;

  const renderText = () => {
    if (!caption.words?.length || (style.animation !== 'karaoke' && style.animation !== 'highlight')) {
      return computedText;
    }

    return caption.words.map((word, idx) => {
      const highlighted = idx === activeWordIndex;
      return (
        <span
          key={`${caption.id}-${idx}`}
          style={{
            color: highlighted ? (style.highlightColor ?? style.color) : style.color,
            background: highlighted && style.animation === 'highlight' ? 'rgba(0,0,0,0.45)' : 'transparent',
            borderRadius: highlighted ? 8 : 0,
            padding: highlighted ? '2px 6px' : 0,
            transition: 'all 120ms ease',
          }}
        >
          {style.textCase === 'upper' ? word.text.toUpperCase() : word.text}
          {idx < caption.words!.length - 1 ? ' ' : ''}
        </span>
      );
    });
  };

  const fontWeight = style.fontWeight === 'black' ? 900 : style.fontWeight === 'bold' ? 700 : 400;

  const textOpacity = (style.textOpacity ?? 100) / 100;
  const bgEnabled = style.backgroundEnabled !== false;
  const bgPaddingScale = (style.backgroundPadding ?? 100) / 100;
  const basePadV = 6 * bgPaddingScale;
  const basePadH = 14 * bgPaddingScale;
  const bgRadius = ((style.backgroundRadius ?? 10) / 100) * 50;
  const bgOpacity = (style.backgroundOpacity ?? 45) / 100;
  const resolvedBgColor = bgEnabled ? `rgba(0,0,0,${bgOpacity})` : undefined;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none', zIndex: 5000 }}>
      <div
        style={{
          position: 'absolute',
          left: `${50 + offsetX}%`,
          width: `${style.maxWidthPercent ?? 88}%`,
          textAlign: 'center',
          ...positionStyle,
          opacity: enter * textOpacity,
        }}
      >
        <div
          style={{
            display: 'inline-block',
            fontFamily: style.fontFamily || brandFont,
            fontSize: style.fontSize,
            fontWeight,
            lineHeight: style.lineHeight ?? 1.2,
            letterSpacing: style.letterSpacing,
            color: style.color,
            backgroundColor: resolvedBgColor,
            padding: resolvedBgColor ? `${basePadV}px ${basePadH}px` : 0,
            borderRadius: resolvedBgColor ? bgRadius : 0,
            textShadow: style.shadow
              ? `0 2px 12px rgba(0,0,0,0.75), 0 0 ${Math.max(8, style.fontSize * 0.2)}px rgba(0,0,0,0.35)`
              : undefined,
            WebkitTextStroke: style.strokeWidth
              ? `${style.strokeWidth}px ${style.strokeColor ?? '#000000'}`
              : undefined,
          }}
        >
          {renderText()}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// --- VideoVisualClip: renders clip media with transforms, NO transition awareness ---
const VideoVisualClip: React.FC<{
  clip: RemotionClip;
  fps: number;
  tracks: RemotionTrack[];
}> = ({ clip, fps, tracks }) => {
  const trackOrder = getTrackOrder(clip.trackId, tracks);
  const transformValues = clipTransformValues(clip);

  const media = clip.assetType === 'video'
    ? (
      <Video
        src={clip.src ?? ''}
        startFrom={toFrames(clip.inPointSec, fps)}
        endAt={toFrames(clip.outPointSec, fps)}
        playbackRate={clip.playbackRate ?? 1}
        volume={clip.muted ? 0 : (clip.volume ?? 1)}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    )
    : (
      <Img
        src={clip.src ?? ''}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    );

  return (
    <AbsoluteFill
      style={{
        zIndex: 1000 - trackOrder,
        opacity: transformValues.opacity,
        overflow: 'hidden',
        transform: `translate3d(${transformValues.x}px, ${transformValues.y}px, 0) scale(${transformValues.scale}) rotate(${transformValues.rotation}deg)`,
      }}
    >
      {media}
    </AbsoluteFill>
  );
};

const AudioClip: React.FC<{
  clip: RemotionClip;
  fps: number;
}> = ({ clip, fps }) => {
  if (!clip.src) {
    return null;
  }

  return (
    <Audio
      src={clip.src}
      startFrom={toFrames(clip.inPointSec, fps)}
      endAt={toFrames(clip.outPointSec, fps)}
      volume={clip.muted ? 0 : (clip.volume ?? 1)}
      playbackRate={clip.playbackRate ?? 1}
    />
  );
};

export const ProjectTimeline: React.FC<ProjectTimelineProps> = ({ spec = DEFAULT_SPEC }) => {
  const safeSpec = spec ?? DEFAULT_SPEC;
  const fps = safeSpec.settings.fps || 30;

  const visualClips = useMemo(
    () => safeSpec.clips.filter((clip) => clip.assetType === 'video' || clip.assetType === 'image').sort((a, b) => {
      if (a.startSec !== b.startSec) return a.startSec - b.startSec;
      return getTrackOrder(a.trackId, safeSpec.tracks) - getTrackOrder(b.trackId, safeSpec.tracks);
    }),
    [safeSpec],
  );

  const audioClips = useMemo(
    () => safeSpec.clips.filter((clip) => clip.assetType === 'audio'),
    [safeSpec],
  );

  const resolvedTransitions = useMemo(
    () => resolveTimelineTransitions(safeSpec, fps),
    [safeSpec, fps],
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: safeSpec.settings.backgroundColor || safeSpec.brandTheme.backgroundColor,
      }}
    >
      {visualClips.map((clip) => (
        <Sequence
          key={`visual-${clip.id}`}
          from={toFrames(clip.startSec, fps)}
          durationInFrames={Math.max(1, toFrames(clip.durationSec, fps))}
        >
          <VideoVisualClip
            clip={clip}
            fps={fps}
            tracks={safeSpec.tracks}
          />
        </Sequence>
      ))}

      {audioClips.map((clip) => (
        <Sequence
          key={`audio-${clip.id}`}
          from={toFrames(clip.startSec, fps)}
          durationInFrames={Math.max(1, toFrames(clip.durationSec, fps))}
        >
          <AudioClip clip={clip} fps={fps} />
        </Sequence>
      ))}

      {(safeSpec.voiceover || []).map((voice, idx) => {
        if (!voice.src) {
          return null;
        }

        const durationFrames = Math.max(1, toFrames(voice.durationSec ?? 3600, fps));

        return (
          <Sequence
            key={`voiceover-${idx}`}
            from={toFrames(voice.startSec, fps)}
            durationInFrames={durationFrames}
          >
            <Audio src={voice.src} volume={voice.volume} />
          </Sequence>
        );
      })}

      {/* Unified transition compositor -- renders ALL transitions via their .tsx components */}
      {resolvedTransitions.map((transition) => (
        <Sequence
          key={`transition-${transition.id}`}
          from={transition.startFrame}
          durationInFrames={transition.durationInFrames}
        >
          <TransitionCompositor transition={transition} />
        </Sequence>
      ))}

      {/* Captions at zIndex 5000 -- always visible above transitions (3500) */}
      {safeSpec.captions.map((caption) => (
        <Sequence
          key={`caption-${caption.id}`}
          from={toFrames(caption.startSec, fps)}
          durationInFrames={Math.max(1, toFrames(caption.endSec - caption.startSec, fps))}
        >
          <CaptionOverlay caption={caption} brandFont={safeSpec.brandTheme.fontFamily} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
