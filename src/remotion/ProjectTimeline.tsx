import React, { useMemo } from 'react';
import {
  AbsoluteFill,
  Audio,
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
  RemotionProjectSpec,
  RemotionTrack,
} from '../shared/remotion-core';
import { CAPTION_STYLE_PRESETS } from '../shared/remotion-core';

interface ProjectTimelineProps {
  spec: RemotionProjectSpec;
}

const DEFAULT_SPEC: RemotionProjectSpec = {
  version: '1.0',
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

const transitionOpacity = (
  frame: number,
  durationInFrames: number,
  transitionInFrames: number,
  transitionOutFrames: number,
): number => {
  const inOpacity = transitionInFrames > 0
    ? interpolate(frame, [0, transitionInFrames], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
    : 1;

  const outOpacity = transitionOutFrames > 0
    ? interpolate(frame, [durationInFrames - transitionOutFrames, durationInFrames], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
    : 1;

  return inOpacity * outOpacity;
};

const clipTransformStyle = (clip: RemotionClip): React.CSSProperties => {
  const scale = clip.transform?.scale ?? 1;
  const rotation = clip.transform?.rotation ?? 0;
  const x = clip.transform?.x ?? 0;
  const y = clip.transform?.y ?? 0;
  const opacity = clip.transform?.opacity ?? 1;

  return {
    transform: `translate(${x}px, ${y}px) scale(${scale}) rotate(${rotation}deg)`,
    opacity,
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

  const positionStyle: React.CSSProperties = (() => {
    if (style.position === 'top') {
      return { top: '7%' };
    }
    if (style.position === 'center') {
      return { top: '50%', transform: 'translate(-50%, -50%)' };
    }
    return { bottom: '7%' };
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

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: '50%',
          width: `${style.maxWidthPercent ?? 88}%`,
          textAlign: 'center',
          ...positionStyle,
          opacity: enter,
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
            backgroundColor: style.backgroundColor,
            padding: style.backgroundColor ? '6px 14px' : 0,
            borderRadius: style.backgroundColor ? 10 : 0,
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

const getTrackOrder = (trackId: string, tracks: RemotionTrack[]): number => {
  const track = tracks.find((t) => t.id === trackId);
  return track?.order ?? 999;
};

const VideoVisualClip: React.FC<{
  clip: RemotionClip;
  fps: number;
  tracks: RemotionTrack[];
}> = ({ clip, fps, tracks }) => {
  const frame = useCurrentFrame();
  const durationInFrames = toFrames(clip.durationSec, fps);
  const transitionInFrames = toFrames(clip.transitionIn?.durationSec ?? 0, fps);
  const transitionOutFrames = toFrames(clip.transitionOut?.durationSec ?? 0, fps);

  const layerOpacity = transitionOpacity(frame, durationInFrames, transitionInFrames, transitionOutFrames);
  const trackOrder = getTrackOrder(clip.trackId, tracks);

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
        opacity: layerOpacity,
        ...clipTransformStyle(clip),
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
          <VideoVisualClip clip={clip} fps={fps} tracks={safeSpec.tracks} />
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
