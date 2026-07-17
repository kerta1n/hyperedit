import { useCallback } from 'react';
import { Type, X, Palette, AlignCenter, Move } from 'lucide-react';
import type { CaptionStyle, CaptionData, CaptionWord } from '@/react-app/hooks/useProject';

interface CaptionPropertiesPanelProps {
  captionData: CaptionData;
  onUpdateStyle: (styleUpdates: Partial<CaptionStyle>) => void;
  onUpdateWords: (words: CaptionWord[]) => void;
  onClose: () => void;
}

const FONT_OPTIONS = [
  { value: 'Inter', label: 'Inter' },
  { value: 'Roboto', label: 'Roboto' },
  { value: 'Poppins', label: 'Poppins' },
  { value: 'Montserrat', label: 'Montserrat' },
  { value: 'Oswald', label: 'Oswald' },
  { value: 'Bebas Neue', label: 'Bebas Neue' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Helvetica', label: 'Helvetica' },
];

const ANIMATION_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'karaoke', label: 'Karaoke' },
  { value: 'highlight', label: 'Highlight Mode' },
  { value: 'fade', label: 'Fade In' },
  { value: 'pop', label: 'Pop' },
  { value: 'bounce', label: 'Bounce' },
];

const POSITION_OPTIONS = [
  { value: 'top', label: 'Top' },
  { value: 'center', label: 'Center' },
  { value: 'bottom', label: 'Bottom' },
];

const CAPTION_PRESETS: Array<{ id: 'clean' | 'highlight'; label: string; style: Partial<CaptionStyle> }> = [
  {
    id: 'clean',
    label: 'Clean Lower Third',
    style: {
      fontFamily: 'Inter',
      fontSize: 52,
      fontWeight: 'bold',
      color: '#FFFFFF',
      textOpacity: 100,
      strokeColor: '#000000',
      strokeWidth: 4,
      position: 'bottom',
      positionX: 0,
      positionY: 0,
      animation: 'fade',
      backgroundEnabled: true,
      backgroundPadding: 100,
      backgroundRadius: 10,
      backgroundOpacity: 45,
      highlightColor: '#FFD700',
    },
  },
  {
    id: 'highlight',
    label: 'Highlight Mode',
    style: {
      fontFamily: 'Inter',
      fontSize: 60,
      fontWeight: 'black',
      color: '#FFFFFF',
      textOpacity: 100,
      strokeColor: '#0A0A0A',
      strokeWidth: 5,
      position: 'bottom',
      positionX: 0,
      positionY: 0,
      animation: 'karaoke',
      backgroundEnabled: true,
      backgroundPadding: 100,
      backgroundRadius: 10,
      backgroundOpacity: 38,
      highlightColor: '#FDE047',
    },
  },
];

export default function CaptionPropertiesPanel({
  captionData,
  onUpdateStyle,
  onUpdateWords,
  onClose,
}: CaptionPropertiesPanelProps) {
  const style = captionData.style;

  const handleWordTextChange = useCallback((index: number, text: string) => {
    onUpdateWords(captionData.words.map((w, i) => (i === index ? { ...w, text } : w)));
  }, [onUpdateWords, captionData.words]);

  const handleFontChange = useCallback((value: string) => {
    onUpdateStyle({ fontFamily: value });
  }, [onUpdateStyle]);

  const handleFontSizeChange = useCallback((value: number) => {
    onUpdateStyle({ fontSize: value });
  }, [onUpdateStyle]);

  const handleFontWeightChange = useCallback((value: 'normal' | 'bold' | 'black') => {
    onUpdateStyle({ fontWeight: value });
  }, [onUpdateStyle]);

  const handleColorChange = useCallback((value: string) => {
    onUpdateStyle({ color: value });
  }, [onUpdateStyle]);

  const handleStrokeColorChange = useCallback((value: string) => {
    onUpdateStyle({ strokeColor: value });
  }, [onUpdateStyle]);

  const handleStrokeWidthChange = useCallback((value: number) => {
    onUpdateStyle({ strokeWidth: value });
  }, [onUpdateStyle]);

  const handlePositionChange = useCallback((value: 'top' | 'center' | 'bottom') => {
    onUpdateStyle({ position: value });
  }, [onUpdateStyle]);

  const handleAnimationChange = useCallback((value: CaptionStyle['animation']) => {
    onUpdateStyle({ animation: value });
  }, [onUpdateStyle]);

  const handleHighlightColorChange = useCallback((value: string) => {
    onUpdateStyle({ highlightColor: value });
  }, [onUpdateStyle]);

  const applyPreset = useCallback((presetId: 'clean' | 'highlight') => {
    const preset = CAPTION_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    onUpdateStyle(preset.style);
  }, [onUpdateStyle]);

  // Get caption text preview
  const textPreview = captionData.words.slice(0, 3).map(w => w.text).join(' ') +
    (captionData.words.length > 3 ? '...' : '');

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/50">
        <span className="text-xs font-medium text-zinc-400">Caption Properties</span>
        <button
          onClick={onClose}
          className="p-1 hover:bg-zinc-700 rounded transition-colors"
          title="Deselect caption"
        >
          <X className="w-3.5 h-3.5 text-zinc-500" />
        </button>
      </div>

      {/* Caption preview */}
      <div className="px-3 py-2 border-b border-zinc-800/50">
        <div className="flex items-center gap-2 text-xs text-white font-medium">
          <Type className="w-3.5 h-3.5 text-purple-400" />
          <span className="truncate">{textPreview || 'Caption'}</span>
        </div>
        <div className="text-[10px] text-zinc-500 mt-0.5">
          {captionData.words.length} words
        </div>
      </div>

      {/* Properties */}
      <div className="flex-1 overflow-auto p-3 space-y-4">
        {/* Word text — fix transcription typos in place; timing stays untouched */}
        <div>
          <span className="text-xs font-medium text-zinc-300 block mb-2">Words</span>
          <div className="space-y-1">
            {captionData.words.map((word, i) => (
              <input
                key={i}
                name={`caption-word-${i}`}
                type="text"
                value={word.text}
                onChange={(e) => handleWordTextChange(i, e.target.value)}
                className="w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white"
              />
            ))}
          </div>
        </div>

        {/* Direct-response presets */}
        <div>
          <span className="text-xs font-medium text-zinc-300 block mb-2">Ad Presets</span>
          <div className="grid grid-cols-1 gap-1.5">
            {CAPTION_PRESETS.map((preset) => (
              <button
                key={preset.id}
                onClick={() => applyPreset(preset.id)}
                className="px-2.5 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 hover:bg-zinc-700 transition-colors text-left"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {/* Font Family */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Type className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-300">Font</span>
          </div>
          <select
            value={style.fontFamily}
            onChange={(e) => handleFontChange(e.target.value)}
            className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-white"
          >
            {FONT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Font Size */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-zinc-300">Size</span>
            <span className="text-xs text-zinc-400">{style.fontSize}px</span>
          </div>
          <input
            type="range"
            min="24"
            max="96"
            step="2"
            value={style.fontSize}
            onChange={(e) => handleFontSizeChange(parseInt(e.target.value))}
            className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
          />
        </div>

        {/* Font Weight */}
        <div>
          <span className="text-xs font-medium text-zinc-300 block mb-2">Weight</span>
          <div className="flex gap-1">
            {(['normal', 'bold', 'black'] as const).map(weight => (
              <button
                key={weight}
                onClick={() => handleFontWeightChange(weight)}
                className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                  style.fontWeight === weight
                    ? 'bg-purple-500 text-white'
                    : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                }`}
              >
                {weight.charAt(0).toUpperCase() + weight.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Colors */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Palette className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-300">Colors</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-zinc-500 mb-1 block">Text</label>
              <input
                type="color"
                value={style.color}
                onChange={(e) => handleColorChange(e.target.value)}
                className="w-full h-8 rounded cursor-pointer bg-zinc-800 border border-zinc-700"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-500 mb-1 block">Stroke</label>
              <input
                type="color"
                value={style.strokeColor || '#000000'}
                onChange={(e) => handleStrokeColorChange(e.target.value)}
                className="w-full h-8 rounded cursor-pointer bg-zinc-800 border border-zinc-700"
              />
            </div>
          </div>
        </div>

        {/* Text Opacity */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-zinc-300">Text Opacity</span>
            <span className="text-xs text-zinc-400">{style.textOpacity ?? 100}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={style.textOpacity ?? 100}
            onChange={(e) => onUpdateStyle({ textOpacity: parseInt(e.target.value) })}
            className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
          />
        </div>

        {/* Stroke Width */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-zinc-300">Stroke Width</span>
            <span className="text-xs text-zinc-400">{style.strokeWidth || 0}px</span>
          </div>
          <input
            type="range"
            min="0"
            max="6"
            step="1"
            value={style.strokeWidth || 0}
            onChange={(e) => handleStrokeWidthChange(parseInt(e.target.value))}
            className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
          />
        </div>

        {/* Position */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <AlignCenter className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-300">Position</span>
          </div>
          <div className="flex gap-1">
            {POSITION_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => handlePositionChange(opt.value as 'top' | 'center' | 'bottom')}
                className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
                  style.position === opt.value
                    ? 'bg-purple-500 text-white'
                    : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* X/Y Position Offset */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Move className="w-3.5 h-3.5 text-zinc-500" />
            <span className="text-xs font-medium text-zinc-300">Position Offset</span>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500 w-4">X</span>
              <input
                type="range"
                min="-50"
                max="50"
                step="1"
                value={style.positionX ?? 0}
                onChange={(e) => onUpdateStyle({ positionX: parseInt(e.target.value) })}
                className="flex-1 h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
              />
              <span className="text-xs text-zinc-400 w-10 text-right">{style.positionX ?? 0}%</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500 w-4">Y</span>
              <input
                type="range"
                min="-50"
                max="50"
                step="1"
                value={style.positionY ?? 0}
                onChange={(e) => onUpdateStyle({ positionY: parseInt(e.target.value) })}
                className="flex-1 h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
              />
              <span className="text-xs text-zinc-400 w-10 text-right">{style.positionY ?? 0}%</span>
            </div>
          </div>
        </div>

        {/* Animation */}
        <div>
          <span className="text-xs font-medium text-zinc-300 block mb-2">Animation</span>
          <select
            value={style.animation}
            onChange={(e) => handleAnimationChange(e.target.value as CaptionStyle['animation'])}
            className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-white"
          >
            {ANIMATION_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Highlight Color (for karaoke/highlight modes) */}
        {(style.animation === 'karaoke' || style.animation === 'highlight') && (
          <div>
            <label className="text-xs font-medium text-zinc-300 block mb-2">Highlight Color</label>
            <input
              type="color"
              value={style.highlightColor || '#FFD700'}
              onChange={(e) => handleHighlightColorChange(e.target.value)}
              className="w-full h-8 rounded cursor-pointer bg-zinc-800 border border-zinc-700"
            />
          </div>
        )}

        {/* Background Box */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-zinc-300">Background Box</span>
            <button
              onClick={() => onUpdateStyle({ backgroundEnabled: !(style.backgroundEnabled !== false) })}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                style.backgroundEnabled !== false
                  ? 'bg-purple-500 text-white'
                  : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
              }`}
            >
              {style.backgroundEnabled !== false ? 'On' : 'Off'}
            </button>
          </div>

          {style.backgroundEnabled !== false && (
            <div className="space-y-3 pl-2 border-l-2 border-zinc-700/50">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-zinc-500">Padding</span>
                  <span className="text-[10px] text-zinc-500">{style.backgroundPadding ?? 100}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="200"
                  step="5"
                  value={style.backgroundPadding ?? 100}
                  onChange={(e) => onUpdateStyle({ backgroundPadding: parseInt(e.target.value) })}
                  className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-zinc-500">Rounding</span>
                  <span className="text-[10px] text-zinc-500">{style.backgroundRadius ?? 10}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={style.backgroundRadius ?? 10}
                  onChange={(e) => onUpdateStyle({ backgroundRadius: parseInt(e.target.value) })}
                  className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-zinc-500">Opacity</span>
                  <span className="text-[10px] text-zinc-500">{style.backgroundOpacity ?? 45}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={style.backgroundOpacity ?? 45}
                  onChange={(e) => onUpdateStyle({ backgroundOpacity: parseInt(e.target.value) })}
                  className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                />
              </div>
            </div>
          )}
        </div>

        {/* Time Offset */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-zinc-300">Time Offset</span>
            <span className="text-xs text-zinc-400">{(style.timeOffset || 0).toFixed(1)}s</span>
          </div>
          <input
            type="range"
            min="-5"
            max="5"
            step="0.1"
            value={style.timeOffset || 0}
            onChange={(e) => onUpdateStyle({ timeOffset: parseFloat(e.target.value) })}
            className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
          />
          <div className="flex justify-between text-[10px] text-zinc-500 mt-1">
            <span>Earlier</span>
            <span>Later</span>
          </div>
        </div>
      </div>
    </div>
  );
}
