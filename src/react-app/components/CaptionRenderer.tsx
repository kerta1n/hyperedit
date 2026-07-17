import { useMemo, useState, useEffect } from 'react';
import type { CaptionWord, CaptionStyle } from '@/react-app/hooks/useProject';

interface CaptionRendererProps {
  words: CaptionWord[];
  style: CaptionStyle;
  currentTime: number;
  isPlaying?: boolean;
  clipStart?: number;
  currentTimeRef?: React.RefObject<number>;
}

export default function CaptionRenderer({ words, style, currentTime, isPlaying, clipStart, currentTimeRef }: CaptionRendererProps) {
  const [liveTime, setLiveTime] = useState<number | null>(null);

  useEffect(() => {
    if (!isPlaying || !currentTimeRef) { setLiveTime(null); return; }
    let rafId: number;
    let lastUpdate = 0;
    const tick = (now: number) => {
      if (now - lastUpdate >= 100) {
        lastUpdate = now;
        setLiveTime(currentTimeRef.current - (clipStart ?? 0));
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, currentTimeRef, clipStart]);

  const effectiveTime = liveTime ?? currentTime;
  const adjustedTime = effectiveTime - (style.timeOffset || 0);

  // Find which words are visible and which is currently active
  const { visibleWords, activeWordIndex } = useMemo(() => {
    const visible: { word: CaptionWord; index: number }[] = [];
    let activeIndex = -1;

    words.forEach((word, index) => {
      // For most animations, show all words
      // For typewriter, only show words that have started
      if (style.animation === 'typewriter') {
        if (adjustedTime >= word.start) {
          visible.push({ word, index });
        }
      } else {
        visible.push({ word, index });
      }

      // Track the currently active word
      if (adjustedTime >= word.start && adjustedTime < word.end) {
        activeIndex = index;
      }
    });

    return { visibleWords: visible, activeWordIndex: activeIndex };
  }, [words, adjustedTime, style.animation]);

  // Compute background color with opacity control
  const resolvedBgColor = useMemo(() => {
    const enabled = style.backgroundEnabled !== false; // default true
    if (!enabled) return undefined;
    const bgOpacity = (style.backgroundOpacity ?? 45) / 100;
    return `rgba(0,0,0,${bgOpacity})`;
  }, [style.backgroundEnabled, style.backgroundOpacity]);

  // Get position styles with X/Y offsets
  const positionStyles = useMemo((): React.CSSProperties => {
    const offsetX = style.positionX ?? 0;
    const offsetY = style.positionY ?? 0;

    const base: React.CSSProperties = {
      position: 'absolute',
      textAlign: 'center',
      width: '90%',
      maxWidth: '90%',
    };

    switch (style.position) {
      case 'top':
        return {
          ...base,
          left: `${50 + offsetX}%`,
          top: `${8 + offsetY}%`,
          transform: 'translateX(-50%)',
        };
      case 'center':
        return {
          ...base,
          left: `${50 + offsetX}%`,
          top: `${50 + offsetY}%`,
          transform: 'translate(-50%, -50%)',
        };
      case 'bottom':
      default:
        return {
          ...base,
          left: `${50 + offsetX}%`,
          bottom: `${8 - offsetY}%`,
          transform: 'translateX(-50%)',
        };
    }
  }, [style.position, style.positionX, style.positionY]);

  // Get text styles
  const textStyles = useMemo((): React.CSSProperties => {
    const textOpacity = (style.textOpacity ?? 100) / 100;
    const bgEnabled = style.backgroundEnabled !== false;
    const bgPaddingScale = (style.backgroundPadding ?? 100) / 100;
    // Default padding: 4px 12px, scaled by backgroundPadding percentage
    const basePadV = 4 * bgPaddingScale;
    const basePadH = 12 * bgPaddingScale;
    // backgroundRadius: 0-100 linear, map to 0px-50px (50px is enough for oval effect)
    const bgRadius = ((style.backgroundRadius ?? 10) / 100) * 50;

    return {
      display: 'inline-block',
      fontFamily: style.fontFamily,
      fontSize: `${style.fontSize}px`,
      fontWeight: style.fontWeight === 'black' ? 900 : style.fontWeight === 'bold' ? 700 : 400,
      color: style.color,
      opacity: textOpacity,
      textShadow: style.strokeWidth
        ? `
          -${style.strokeWidth}px -${style.strokeWidth}px 0 ${style.strokeColor},
          ${style.strokeWidth}px -${style.strokeWidth}px 0 ${style.strokeColor},
          -${style.strokeWidth}px ${style.strokeWidth}px 0 ${style.strokeColor},
          ${style.strokeWidth}px ${style.strokeWidth}px 0 ${style.strokeColor}
        `
        : undefined,
      backgroundColor: bgEnabled ? resolvedBgColor : undefined,
      padding: bgEnabled && resolvedBgColor ? `${basePadV}px ${basePadH}px` : undefined,
      borderRadius: bgEnabled && resolvedBgColor ? `${bgRadius}px` : undefined,
      lineHeight: 1.4,
    };
  }, [style, resolvedBgColor]);

  // Get animation class/style for a word
  const getWordStyle = (wordIndex: number, word: CaptionWord): React.CSSProperties => {
    const isActive = wordIndex === activeWordIndex;
    const hasStarted = adjustedTime >= word.start;

    switch (style.animation) {
      case 'karaoke':
        return {
          color: isActive ? style.highlightColor || '#FFD700' : style.color,
          transition: 'color 0.1s ease',
        };

      case 'highlight':
        return {
          color: isActive ? style.highlightColor || '#FDE047' : style.color,
          backgroundColor: isActive ? 'rgba(0,0,0,0.45)' : 'transparent',
          borderRadius: isActive ? '6px' : undefined,
          padding: isActive ? '0 4px' : 0,
          display: 'inline-block',
          transition: 'all 0.12s ease',
        };

      case 'fade':
        return {
          opacity: hasStarted ? 1 : 0.3,
          transition: 'opacity 0.3s ease',
        };

      case 'pop':
        return {
          transform: isActive ? 'scale(1.2)' : 'scale(1)',
          display: 'inline-block',
          transition: 'transform 0.15s ease',
        };

      case 'bounce':
        return {
          transform: isActive ? 'translateY(-4px)' : 'translateY(0)',
          display: 'inline-block',
          transition: 'transform 0.15s ease',
        };

      case 'typewriter':
      case 'none':
      default:
        return {};
    }
  };

  if (visibleWords.length === 0) {
    return null;
  }

  return (
    // z-[60] keeps captions above the transition compositor canvas (zIndex 50
    // in VideoPreview) — mirrors the render, where captions (5000) sit above
    // transitions (3500). At z-40 a long-running transition like staticfacecam
    // hid captions for its whole active window.
    <div style={positionStyles} className="pointer-events-none z-[60]">
      <div style={textStyles}>
        {visibleWords.map(({ word, index }, i) => (
          <span
            key={`${index}-${word.text}`}
            style={getWordStyle(index, word)}
          >
            {word.text}
            {i < visibleWords.length - 1 ? ' ' : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
