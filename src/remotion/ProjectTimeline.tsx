import React, { useMemo } from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {
  RemotionCaption,
  RemotionCaptionStyle,
  RemotionClip,
  RemotionClipJunctionTransition,
  RemotionEasing,
  RemotionProjectSpec,
  RemotionTrack,
} from '../shared/remotion-core';
import { CAPTION_STYLE_PRESETS } from '../shared/remotion-core';

interface ProjectTimelineProps {
  spec: RemotionProjectSpec;
}

type ResolvedTransitionType = 'none' | 'crossfade' | 'slide-left' | 'slide-right' | 'dip-to-black';

interface ResolvedJunctionTransition {
  id: string;
  fromClipId: string;
  toClipId: string;
  type: ResolvedTransitionType;
  durationSec: number;
  durationInFrames: number;
  overlapSec: number;
  startFrame: number;
  easing: RemotionEasing;
}

interface ClipTransitionContext {
  incoming?: ResolvedJunctionTransition;
  outgoing?: ResolvedJunctionTransition;
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

const getEasing = (easing: RemotionEasing | undefined) => {
  if (easing === 'ease-in') return Easing.in(Easing.cubic);
  if (easing === 'ease-out') return Easing.out(Easing.cubic);
  if (easing === 'linear') return Easing.linear;
  return Easing.inOut(Easing.cubic);
};

const easedInterpolate = (
  frame: number,
  input: [number, number],
  output: [number, number],
  easing: RemotionEasing,
): number => {
  return interpolate(frame, input, output, {
    easing: getEasing(easing),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
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

const normalizeTransitionType = (type: string | undefined): ResolvedTransitionType => {
  if (type === 'crossfade' || type === 'slide-left' || type === 'slide-right' || type === 'dip-to-black') {
    return type;
  }
  return 'none';
};

const legacyTypeToV2 = (type: string | undefined): ResolvedTransitionType => {
  if (type === 'fade') return 'crossfade';
  if (type === 'slide-left') return 'slide-left';
  if (type === 'slide-right') return 'slide-right';
  return 'none';
};

const deriveLegacyJunctionTransitions = (clips: RemotionClip[]): RemotionClipJunctionTransition[] => {
  const byTrack = new Map<string, RemotionClip[]>();

  for (const clip of clips) {
    const trackClips = byTrack.get(clip.trackId) ?? [];
    trackClips.push(clip);
    byTrack.set(clip.trackId, trackClips);
  }

  const transitions: RemotionClipJunctionTransition[] = [];

  for (const trackClips of byTrack.values()) {
    const sorted = [...trackClips].sort((a, b) => {
      if (a.startSec !== b.startSec) return a.startSec - b.startSec;
      return a.id.localeCompare(b.id);
    });

    for (let i = 0; i < sorted.length - 1; i += 1) {
      const from = sorted[i];
      const to = sorted[i + 1];

      const preferred = to.transitionIn ?? from.transitionOut;
      const type = legacyTypeToV2(preferred?.type);
      const durationSec = preferred?.durationSec ?? 0;
      const easing = preferred?.easing ?? 'ease-in-out';

      if (type === 'none' || durationSec <= 0) {
        continue;
      }

      transitions.push({
        id: `legacy-${from.id}-${to.id}`,
        fromClipId: from.id,
        toClipId: to.id,
        type,
        durationSec,
        easing,
        fallbackBehavior: 'clamp',
      });
    }
  }

  return transitions;
};

const resolveJunctionTransitions = (
  spec: RemotionProjectSpec,
  fps: number,
): {
  transitionMap: Map<string, ClipTransitionContext>;
  dipTransitions: ResolvedJunctionTransition[];
} => {
  const clipMap = new Map(spec.clips.map((clip) => [clip.id, clip]));
  const transitionMap = new Map<string, ClipTransitionContext>();
  const dipTransitions: ResolvedJunctionTransition[] = [];

  const sourceTransitions = spec.transitions && spec.transitions.length > 0
    ? spec.transitions
    : deriveLegacyJunctionTransitions(spec.clips);

  const upsert = (clipId: string) => {
    const current = transitionMap.get(clipId);
    if (current) return current;
    const initial: ClipTransitionContext = {};
    transitionMap.set(clipId, initial);
    return initial;
  };

  for (const transition of sourceTransitions) {
    const fromClip = clipMap.get(transition.fromClipId);
    const toClip = clipMap.get(transition.toClipId);

    if (!fromClip || !toClip) {
      continue;
    }

    if (fromClip.trackId !== toClip.trackId) {
      continue;
    }

    const fromEndSec = fromClip.startSec + fromClip.durationSec;
    const overlapSec = fromEndSec - toClip.startSec;
    if (overlapSec <= 0) {
      // Invalid overlap constraints: graceful fallback to hard cut (skip transition).
      continue;
    }

    const requestedDurationSec = Math.max(0, transition.durationSec ?? 0);
    const resolvedDurationSec = Math.min(requestedDurationSec, overlapSec);
    if (resolvedDurationSec <= 0) {
      continue;
    }

    const resolvedType = normalizeTransitionType(transition.type);
    if (resolvedType === 'none') {
      continue;
    }

    const easing = transition.easing ?? 'ease-in-out';
    const resolved: ResolvedJunctionTransition = {
      id: transition.id,
      fromClipId: fromClip.id,
      toClipId: toClip.id,
      type: resolvedType,
      durationSec: resolvedDurationSec,
      durationInFrames: Math.max(1, toFrames(resolvedDurationSec, fps)),
      overlapSec,
      startFrame: toFrames(toClip.startSec, fps),
      easing,
    };

    upsert(fromClip.id).outgoing = resolved;
    upsert(toClip.id).incoming = resolved;

    if (resolved.type === 'dip-to-black') {
      dipTransitions.push(resolved);
    }
  }

  return {
    transitionMap,
    dipTransitions,
  };
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
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
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

const VideoVisualClip: React.FC<{
  clip: RemotionClip;
  fps: number;
  tracks: RemotionTrack[];
  transitionContext?: ClipTransitionContext;
}> = ({ clip, fps, tracks, transitionContext }) => {
  const frame = useCurrentFrame();
  const durationInFrames = Math.max(1, toFrames(clip.durationSec, fps));
  const trackOrder = getTrackOrder(clip.trackId, tracks);
  const transformValues = clipTransformValues(clip);

  let opacity = transformValues.opacity;
  let transitionTranslateXPercent = 0;

  const incoming = transitionContext?.incoming;
  const incomingFrames = incoming ? Math.min(incoming.durationInFrames, durationInFrames) : 0;
  if (incoming && incomingFrames > 0) {
    if (incoming.type === 'crossfade' || incoming.type === 'dip-to-black') {
      opacity *= easedInterpolate(frame, [0, incomingFrames], [0, 1], incoming.easing);
    }

    if (incoming.type === 'slide-left') {
      transitionTranslateXPercent += easedInterpolate(frame, [0, incomingFrames], [100, 0], incoming.easing);
    }

    if (incoming.type === 'slide-right') {
      transitionTranslateXPercent += easedInterpolate(frame, [0, incomingFrames], [-100, 0], incoming.easing);
    }
  }

  const outgoing = transitionContext?.outgoing;
  const outgoingFrames = outgoing ? Math.min(outgoing.durationInFrames, durationInFrames) : 0;
  if (outgoing && outgoingFrames > 0) {
    if (outgoing.type === 'crossfade' || outgoing.type === 'dip-to-black') {
      opacity *= easedInterpolate(
        frame,
        [durationInFrames - outgoingFrames, durationInFrames],
        [1, 0],
        outgoing.easing,
      );
    }

    if (outgoing.type === 'slide-left') {
      transitionTranslateXPercent += easedInterpolate(
        frame,
        [durationInFrames - outgoingFrames, durationInFrames],
        [0, -100],
        outgoing.easing,
      );
    }

    if (outgoing.type === 'slide-right') {
      transitionTranslateXPercent += easedInterpolate(
        frame,
        [durationInFrames - outgoingFrames, durationInFrames],
        [0, 100],
        outgoing.easing,
      );
    }
  }

  const media = clip.assetType === 'video'
    ? (
      <OffthreadVideo
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
        opacity,
        overflow: 'hidden',
        transform: `translate3d(calc(${transformValues.x}px + ${transitionTranslateXPercent}%), ${transformValues.y}px, 0) scale(${transformValues.scale}) rotate(${transformValues.rotation}deg)`,
      }}
    >
      {media}
    </AbsoluteFill>
  );
};

const DipToBlackOverlay: React.FC<{
  transition: ResolvedJunctionTransition;
}> = ({ transition }) => {
  const frame = useCurrentFrame();

  if (transition.durationInFrames <= 1) {
    return null;
  }

  const half = transition.durationInFrames / 2;
  const opacity = frame <= half
    ? easedInterpolate(frame, [0, half], [0, 1], transition.easing)
    : easedInterpolate(frame, [half, transition.durationInFrames], [1, 0], transition.easing);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: '#000000',
        opacity,
        zIndex: 4000,
        pointerEvents: 'none',
      }}
    />
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

  const { transitionMap, dipTransitions } = useMemo(
    () => resolveJunctionTransitions(safeSpec, fps),
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
            transitionContext={transitionMap.get(clip.id)}
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

      {dipTransitions.map((transition) => (
        <Sequence
          key={`dip-${transition.id}`}
          from={transition.startFrame}
          durationInFrames={transition.durationInFrames}
        >
          <DipToBlackOverlay transition={transition} />
        </Sequence>
      ))}

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
