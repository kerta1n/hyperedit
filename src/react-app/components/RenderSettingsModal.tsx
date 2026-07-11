import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, ChevronDown, Info, Trash2, PenLine } from 'lucide-react';
import { useDeliverables } from '@/react-app/hooks/useDeliverables';
import type { RenderItem } from '@/react-app/hooks/useDeliverables';
import type {
  RenderOptions,
  VideoCodec,
  AudioCodec,
  ContainerFormat,
  HwAccelMode,
} from '@/react-app/hooks/useProject';
import { defaultRenderOptions } from '@/react-app/hooks/useProject';

// ── Codec compatibility data ────────────────────────────────────────

const CODEC_LABELS: Record<VideoCodec, string> = {
  h264: 'H.264 (MP4)',
  h265: 'H.265 / HEVC',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  prores: 'ProRes',
};

const AUDIO_CODEC_LABELS: Record<AudioCodec, string> = {
  aac: 'AAC',
  mp3: 'MP3',
  'pcm-16': 'PCM-16 (Lossless)',
  opus: 'Opus',
};

const CONTAINER_LABELS: Record<ContainerFormat, string> = {
  mp4: '.mp4',
  webm: '.webm',
  mkv: '.mkv',
  mov: '.mov',
};

const CODEC_AUDIO_MAP: Record<VideoCodec, { options: AudioCodec[]; default: AudioCodec }> = {
  h264: { options: ['aac', 'mp3', 'pcm-16'], default: 'aac' },
  h265: { options: ['aac', 'pcm-16'], default: 'aac' },
  vp8: { options: ['opus', 'pcm-16'], default: 'opus' },
  vp9: { options: ['opus', 'pcm-16'], default: 'opus' },
  av1: { options: ['aac', 'opus', 'pcm-16'], default: 'opus' },
  prores: { options: ['aac', 'pcm-16'], default: 'pcm-16' },
};

// Container options depend on BOTH video codec AND audio codec (per Remotion encoding guide)
const CONTAINER_MAP: Record<string, ContainerFormat[]> = {
  'h264+aac': ['mp4', 'mkv', 'mov'],
  'h264+mp3': ['mp4', 'mkv', 'mov'],
  'h264+pcm-16': ['mkv', 'mov'],
  'h265+aac': ['mp4', 'mkv'],
  'h265+pcm-16': ['mkv'],
  'vp8+opus': ['webm'],
  'vp8+pcm-16': ['mkv'],
  'vp9+opus': ['webm'],
  'vp9+pcm-16': ['mkv'],
  'av1+aac': ['mp4', 'mkv'],
  'av1+opus': ['webm', 'mkv'],
  'av1+pcm-16': ['mkv'],
  'prores+aac': ['mov', 'mkv'],
  'prores+pcm-16': ['mov', 'mkv'],
};

function getValidContainers(codec: VideoCodec, audioCodec: AudioCodec): ContainerFormat[] {
  return CONTAINER_MAP[`${codec}+${audioCodec}`] || ['mp4'];
}

function getDefaultContainer(codec: VideoCodec, audioCodec: AudioCodec): ContainerFormat {
  const options = getValidContainers(codec, audioCodec);
  return options[0];
}

const CRF_RANGES: Record<VideoCodec, { min: number; max: number; good: number; balanced: number; small: number }> = {
  h264: { min: 0, max: 51, good: 15, balanced: 23, small: 28 },
  h265: { min: 0, max: 51, good: 18, balanced: 28, small: 32 },
  vp8: { min: 4, max: 63, good: 8, balanced: 15, small: 20 },
  vp9: { min: 0, max: 63, good: 15, balanced: 31, small: 40 },
  av1: { min: 0, max: 63, good: 15, balanced: 30, small: 40 },
  prores: { min: 0, max: 0, good: 0, balanced: 0, small: 0 },
};

const RESOLUTION_PRESETS = [
  { label: '1920×1080 (1080p)', w: 1920, h: 1080 },
  { label: '2560×1440 (1440p)', w: 2560, h: 1440 },
  { label: '3840×2160 (4K)', w: 3840, h: 2160 },
  { label: '1280×720 (720p)', w: 1280, h: 720 },
  { label: '1080×1920 (9:16 Vertical)', w: 1080, h: 1920 },
  { label: '1080×1080 (1:1 Square)', w: 1080, h: 1080 },
  { label: 'Custom', w: 0, h: 0 },
];

const FPS_OPTIONS = [24, 25, 30, 50, 60];
const SAMPLE_RATE_OPTIONS = [22050, 44100, 48000, 96000];
const AUDIO_BITRATE_OPTIONS = ['96k', '128k', '192k', '256k', '320k'];
const SCALE_OPTIONS = [
  { label: '0.25× (Quarter)', value: 0.25 },
  { label: '0.5× (Half)', value: 0.5 },
  { label: '1× (Full)', value: 1 },
  { label: '2× (Double)', value: 2 },
];
const X264_PRESET_OPTIONS = [
  { label: 'Placebo (Slowest)', value: 'placebo' },
  { label: 'Very Slow', value: 'veryslow' },
  { label: 'Slower', value: 'slower' },
  { label: 'Slow', value: 'slow' },
  { label: 'Medium', value: 'medium' },
  { label: 'Fast (Default)', value: 'fast' },
  { label: 'Faster', value: 'faster' },
  { label: 'Very Fast', value: 'veryfast' },
  { label: 'Super Fast', value: 'superfast' },
  { label: 'Ultra Fast', value: 'ultrafast' },
];
const PRORES_PROFILE_OPTIONS = [
  { label: 'Proxy', value: 'proxy' },
  { label: 'Light', value: 'light' },
  { label: 'Standard', value: 'standard' },
  { label: 'HQ (Default)', value: 'hq' },
  { label: '4444', value: '4444' },
  { label: '4444 XQ', value: '4444-xq' },
];

// ── Built-in presets ────────────────────────────────────────────────

interface Preset {
  id: string;
  label: string;
  options: Partial<RenderOptions>;
}

const BUILT_IN_PRESETS: Preset[] = [
  {
    id: 'social-vertical',
    label: 'Social Media (Vertical)',
    options: {
      codec: 'h264', crf: 23, qualityMode: 'crf', hardwareAcceleration: 'disable', outputWidth: 1080, outputHeight: 1920,
      outputFps: 30, audioCodec: 'aac', audioBitrate: '128k', containerFormat: 'mp4',
      sampleRate: 48000, x264Preset: 'fast', scale: 1, muted: false,
    },
  },
  {
    id: 'youtube-hd',
    label: 'YouTube HD',
    options: {
      codec: 'h264', crf: 18, qualityMode: 'crf', hardwareAcceleration: 'disable', outputWidth: 1920, outputHeight: 1080,
      outputFps: 30, audioCodec: 'aac', audioBitrate: '192k', containerFormat: 'mp4',
      sampleRate: 48000, x264Preset: 'medium', scale: 1, muted: false,
    },
  },
  {
    id: 'youtube-4k',
    label: 'YouTube 4K',
    options: {
      codec: 'h264', crf: 15, qualityMode: 'crf', hardwareAcceleration: 'disable', outputWidth: 3840, outputHeight: 2160,
      outputFps: 30, audioCodec: 'aac', audioBitrate: '256k', containerFormat: 'mp4',
      sampleRate: 48000, x264Preset: 'medium', scale: 1, muted: false,
    },
  },
  {
    id: 'max-quality',
    label: 'Maximum Quality',
    options: {
      codec: 'h264', crf: 14, qualityMode: 'crf', hardwareAcceleration: 'disable', outputWidth: 1920, outputHeight: 1080,
      outputFps: 60, audioCodec: 'aac', audioBitrate: '320k', containerFormat: 'mp4',
      sampleRate: 48000, x264Preset: 'slow', scale: 1, muted: false,
    },
  },
  {
    id: 'small-file',
    label: 'Small File',
    options: {
      codec: 'h264', crf: 28, qualityMode: 'crf', hardwareAcceleration: 'disable', outputWidth: 1280, outputHeight: 720,
      outputFps: 30, audioCodec: 'aac', audioBitrate: '96k', containerFormat: 'mp4',
      sampleRate: 44100, x264Preset: 'fast', scale: 1, muted: false,
    },
  },
  {
    id: 'web-optimized',
    label: 'Web Optimized',
    options: {
      codec: 'vp9', crf: 30, qualityMode: 'crf', hardwareAcceleration: 'disable', outputWidth: 1920, outputHeight: 1080,
      outputFps: 30, audioCodec: 'opus', audioBitrate: '128k', containerFormat: 'webm',
      sampleRate: 48000, scale: 1, muted: false,
    },
  },
  {
    id: 'prores-master',
    label: 'ProRes Master',
    options: {
      codec: 'prores', crf: null, qualityMode: 'crf', hardwareAcceleration: 'disable', outputWidth: 1920, outputHeight: 1080,
      outputFps: 30, audioCodec: 'pcm-16', audioBitrate: '320k', containerFormat: 'mov',
      proResProfile: 'hq', sampleRate: 48000, scale: 1, muted: false,
    },
  },
];

// ── Component ───────────────────────────────────────────────────────

interface RenderSettingsModalProps {
  renderOptions: RenderOptions;
  onClose: () => void;
  onExport: (options: RenderOptions) => void;
  onUpdateOptions: (options: RenderOptions) => void;
  isExporting: boolean;
  recommendedConcurrency: number;
  sessionId: string;
}

export default function RenderSettingsModal({
  renderOptions,
  onClose,
  onExport,
  onUpdateOptions,
  isExporting,
  recommendedConcurrency,
  sessionId,
}: RenderSettingsModalProps) {
  // Normalize on open: CRF is incompatible with hardware acceleration (Remotion
  // constraint) — saved projects from before this rule may carry both.
  const [opts, setOpts] = useState<RenderOptions>(() =>
    renderOptions.hardwareAcceleration !== 'disable' && renderOptions.qualityMode === 'crf' && renderOptions.codec !== 'prores'
      ? { ...renderOptions, qualityMode: 'bitrate' }
      : renderOptions
  );
  const [customResolution, setCustomResolution] = useState(false);
  const [crfDrag, setCrfDrag] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'settings' | 'gallery'>('settings');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const {
    renders, selectedIds, loading: rendersLoading, error: rendersError,
    pendingDelete, fetchRenders, deleteRenders, renameRender,
    toggleSelect, clearSelection, totalSelectedSize, setPendingDelete,
  } = useDeliverables();

  useEffect(() => {
    if (activeTab === 'gallery' && sessionId) {
      fetchRenders(sessionId);
    }
  }, [activeTab, sessionId, fetchRenders]);

  // Detect if the current resolution matches a preset
  useEffect(() => {
    const match = RESOLUTION_PRESETS.find(p => p.w === opts.outputWidth && p.h === opts.outputHeight);
    setCustomResolution(!match || match.label === 'Custom');
  }, [opts.outputWidth, opts.outputHeight]);

  // Sync parent state AFTER commit — calling onUpdateOptions inside setOpts
  // updater functions fires Home's setter mid-render (React re-executes
  // updaters during render) and trips the setState-in-render invariant.
  // The callback goes through a ref: Home passes an inline arrow that ALSO
  // saves the project, so keying the effect on its identity re-saved on every
  // Home re-render (= every render-progress tick).
  const onUpdateOptionsRef = useRef(onUpdateOptions);
  useEffect(() => {
    onUpdateOptionsRef.current = onUpdateOptions;
  });
  useEffect(() => {
    onUpdateOptionsRef.current(opts);
  }, [opts]);

  const update = useCallback((partial: Partial<RenderOptions>) => {
    setOpts(prev => ({ ...prev, ...partial, presetId: 'custom' }));
  }, []);

  // Apply a preset
  const applyPreset = useCallback((presetId: string) => {
    if (presetId === 'custom') {
      setOpts({ ...defaultRenderOptions, presetId: 'custom' });
      return;
    }
    const preset = BUILT_IN_PRESETS.find(p => p.id === presetId);
    if (!preset) return;
    setOpts({ ...defaultRenderOptions, ...preset.options, presetId: preset.id });
  }, []);

  // Available audio codecs for current video codec
  const audioOptions = useMemo(() => CODEC_AUDIO_MAP[opts.codec], [opts.codec]);
  // Available containers depends on BOTH video codec + audio codec
  const containerOptions = useMemo(() => getValidContainers(opts.codec, opts.audioCodec), [opts.codec, opts.audioCodec]);
  const crfRange = useMemo(() => CRF_RANGES[opts.codec], [opts.codec]);
  const isProRes = opts.codec === 'prores';
  // CRF is incompatible with hardware-accelerated encoding (Remotion constraint)
  const hwAccelActive = opts.hardwareAcceleration !== 'disable';
  const showCrf = !isProRes && opts.qualityMode === 'crf' && !hwAccelActive;
  const showBitrate = !isProRes && (opts.qualityMode === 'bitrate' || hwAccelActive);

  // When codec changes, cascade audio + container to compatible defaults
  const handleCodecChange = useCallback((codec: VideoCodec) => {
    const audio = CODEC_AUDIO_MAP[codec];
    const crf = CRF_RANGES[codec];
    const defaultAudio = audio.default;
    const defaultContainer = getDefaultContainer(codec, defaultAudio);
    update({
      codec,
      audioCodec: defaultAudio,
      containerFormat: defaultContainer,
      crf: codec === 'prores' ? null : crf.balanced,
      // Leaving ProRes must not resurrect CRF while hardware acceleration is on
      qualityMode: codec === 'prores' ? 'crf' : (opts.hardwareAcceleration !== 'disable' ? 'bitrate' : opts.qualityMode),
    });
  }, [update, opts.qualityMode, opts.hardwareAcceleration]);

  // When audio codec changes, cascade container to compatible default if needed
  const handleAudioCodecChange = useCallback((audioCodec: AudioCodec) => {
    const validContainers = getValidContainers(opts.codec, audioCodec);
    const containerStillValid = validContainers.includes(opts.containerFormat);
    update({
      audioCodec,
      containerFormat: containerStillValid ? opts.containerFormat : validContainers[0],
    });
  }, [update, opts.codec, opts.containerFormat]);

  // Resolution preset selection
  const handleResolutionPreset = useCallback((label: string) => {
    const preset = RESOLUTION_PRESETS.find(p => p.label === label);
    if (!preset) return;
    if (preset.label === 'Custom') {
      setCustomResolution(true);
    } else {
      setCustomResolution(false);
      update({ outputWidth: preset.w, outputHeight: preset.h });
    }
  }, [update]);

  // Matched resolution label
  const resolvedResLabel = useMemo(() => {
    const match = RESOLUTION_PRESETS.find(p => p.w === opts.outputWidth && p.h === opts.outputHeight);
    return match ? match.label : 'Custom';
  }, [opts.outputWidth, opts.outputHeight]);

  // CRF quality label (use drag value if actively dragging)
  const displayCrf = crfDrag ?? opts.crf;
  const crfLabel = useMemo(() => {
    if (displayCrf === null) return '';
    if (displayCrf <= crfRange.good) return 'High Quality';
    if (displayCrf <= crfRange.balanced) return 'Balanced';
    return 'Small File';
  }, [displayCrf, crfRange]);

  return (<>
    {createPortal(
    <div
      id="render-settings-backdrop"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      style={{ isolation: 'isolate' }}
      onClick={(e) => { if ((e.target as HTMLElement).id === 'render-settings-backdrop') onClose(); }}
    >
      {/* Modal — max-w-5xl and no overflow-y-auto so everything fits without scrolling */}
      <div className="bg-zinc-900 rounded-2xl border border-zinc-800 w-full max-w-5xl flex flex-col shadow-2xl">
        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-800">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Download className="w-5 h-5 text-orange-400" />
            Export
          </h2>

          <div className="flex gap-1 bg-zinc-800 rounded-lg p-0.5">
            <QualityModeButton active={activeTab === 'settings'} label="Render Settings" onClick={() => setActiveTab('settings')} />
            <QualityModeButton active={activeTab === 'gallery'} label="Gallery" onClick={() => setActiveTab('gallery')} />
          </div>

          <button
            onClick={onClose}
            className="p-1.5 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-zinc-400" />
          </button>
        </div>

        <div className="relative">
        <div className={activeTab !== 'settings' ? 'invisible' : ''}>
        {/* Preset dropdown */}
        <div className="px-6 pt-4 pb-0">
          <Field label="Preset">
            <div className="relative w-52">
              <select
                value={opts.presetId}
                onChange={e => applyPreset(e.target.value)}
                className="appearance-none w-full pl-3 pr-8 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-xs font-medium text-zinc-300 focus:outline-none focus:border-orange-500 transition-colors cursor-pointer"
              >
                <option value="custom">Custom</option>
                {BUILT_IN_PRESETS.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
            </div>
          </Field>
        </div>

        {/* ── Main content (2 columns, compact) ──────────────────── */}
        <div className="px-6 py-4 grid grid-cols-2 gap-x-8 gap-y-0">
          {/* LEFT COLUMN — Video */}
          <div className="space-y-2.5">
            <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Video</h3>

            {/* Resolution */}
            <Field label="Resolution">
              <Select
                value={resolvedResLabel}
                options={RESOLUTION_PRESETS.map(p => p.label)}
                onChange={handleResolutionPreset}
              />
              {customResolution && (
                <div className="flex items-center gap-2 mt-1">
                  <NumberInput value={opts.outputWidth} min={16} max={7680} onChange={v => update({ outputWidth: v })} suffix="px" />
                  <span className="text-zinc-500 text-xs">×</span>
                  <NumberInput value={opts.outputHeight} min={16} max={4320} onChange={v => update({ outputHeight: v })} suffix="px" />
                </div>
              )}
            </Field>

            {/* Frame Rate + Container side by side */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Frame Rate">
                <Select
                  value={String(opts.outputFps)}
                  options={FPS_OPTIONS.map(String)}
                  labels={FPS_OPTIONS.map(f => `${f} fps`)}
                  onChange={v => update({ outputFps: Number(v) })}
                />
              </Field>
              <Field label="Container">
                <Select
                  value={opts.containerFormat}
                  options={containerOptions}
                  labels={containerOptions.map(c => CONTAINER_LABELS[c])}
                  onChange={v => update({ containerFormat: v as ContainerFormat })}
                />
              </Field>
            </div>

            {/* Video Codec */}
            <Field label="Video Codec">
              <Select
                value={opts.codec}
                options={Object.keys(CODEC_LABELS) as VideoCodec[]}
                labels={Object.values(CODEC_LABELS)}
                onChange={v => handleCodecChange(v as VideoCodec)}
              />
            </Field>

            {/* Quality mode (CRF vs Bitrate) — not for ProRes */}
            {!isProRes ? (
              <>
                <Field label="Quality Mode">
                  <div className="flex gap-1 bg-zinc-800 rounded-lg p-0.5">
                    <QualityModeButton
                      active={showCrf}
                      label="CRF"
                      onClick={() => update({ qualityMode: 'crf' })}
                      disabled={hwAccelActive}
                      title={hwAccelActive ? 'CRF is incompatible with hardware acceleration — set Hardware Acceleration to Disable to use CRF' : undefined}
                    />
                    <QualityModeButton active={showBitrate} label="Bitrate" onClick={() => update({ qualityMode: 'bitrate' })} />
                  </div>
                  {hwAccelActive && (
                    <span className="text-[10px] text-zinc-500 mt-0.5 block">
                      Hardware acceleration requires bitrate mode.
                    </span>
                  )}
                </Field>

                {showCrf && (
                  <Field label={`CRF — ${crfLabel} (${displayCrf})`}>
                    <input
                      type="range"
                      min={crfRange.min}
                      max={crfRange.max}
                      step={1}
                      value={displayCrf ?? crfRange.balanced}
                      onInput={e => setCrfDrag(Number((e.target as HTMLInputElement).value))}
                      onChange={e => {
                        const v = Number(e.target.value);
                        setCrfDrag(null);
                        update({ crf: v });
                      }}
                      className="w-full accent-orange-500 cursor-grab active:cursor-grabbing"
                    />
                    <div className="flex justify-between text-[10px] text-zinc-500 -mt-0.5">
                      <span>High Quality</span>
                      <span>Balanced</span>
                      <span>Small File</span>
                    </div>
                  </Field>
                )}

                {showBitrate && (
                  <Field label="Video Bitrate">
                    <input
                      type="text"
                      value={opts.videoBitrate}
                      onChange={e => update({ videoBitrate: e.target.value })}
                      placeholder="e.g. 10M, 5000K"
                      className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-orange-500 transition-colors"
                    />
                  </Field>
                )}
              </>
            ) : (
              /* ProRes uses profiles instead of CRF/Bitrate */
              <Field label="ProRes Profile">
                <Select
                  value={opts.proResProfile}
                  options={PRORES_PROFILE_OPTIONS.map(o => o.value)}
                  labels={PRORES_PROFILE_OPTIONS.map(o => o.label)}
                  onChange={v => update({ proResProfile: v })}
                />
                <span className="text-[10px] text-zinc-500 mt-0.5 block">
                  ProRes uses profiles instead of CRF/Bitrate for quality control.
                </span>
              </Field>
            )}

            {/* Encoder Speed — x264-only; hardware encoders use their own presets */}
            {opts.codec === 'h264' && !hwAccelActive ? (
              <Field label="Encoder Speed">
                <Select
                  value={opts.x264Preset}
                  options={X264_PRESET_OPTIONS.map(o => o.value)}
                  labels={X264_PRESET_OPTIONS.map(o => o.label)}
                  onChange={v => update({ x264Preset: v })}
                />
              </Field>
            ) : (
              <span className="text-[10px] text-zinc-500 block">
                {opts.codec === 'h264'
                  ? 'Encoder speed presets are x264-only — not used with hardware acceleration.'
                  : 'Encoder speed presets are only available for H.264 (x264).'}
              </span>
            )}

            {/* Custom FFmpeg flags — toggle switch inside video section */}
            <div className="pt-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-400 font-medium">Custom FFmpeg Flags</span>
                <ToggleSwitch
                  checked={opts.enableCustomFfmpegFlags}
                  onChange={v => update({ enableCustomFfmpegFlags: v })}
                />
              </div>
              {opts.enableCustomFfmpegFlags && (
                <textarea
                  value={opts.customFfmpegFlags}
                  onChange={e => update({ customFfmpegFlags: e.target.value })}
                  placeholder="e.g. -g 60 -bf 2 -flags +cgop"
                  rows={2}
                  className="w-full mt-1.5 px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-white font-mono placeholder-zinc-500 focus:outline-none focus:border-orange-500 transition-colors resize-none"
                />
              )}
            </div>
          </div>

          {/* RIGHT COLUMN — Audio + Advanced */}
          <div className="space-y-2.5">
            <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Audio</h3>

            {/* Audio Codec */}
            <Field label="Audio Codec">
              <Select
                value={opts.audioCodec}
                options={audioOptions.options}
                labels={audioOptions.options.map(a => AUDIO_CODEC_LABELS[a])}
                onChange={v => handleAudioCodecChange(v as AudioCodec)}
              />
            </Field>

            {/* Audio Bitrate + Sample Rate side by side */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Audio Bitrate">
                <Select
                  value={opts.audioBitrate}
                  options={AUDIO_BITRATE_OPTIONS}
                  onChange={v => update({ audioBitrate: v })}
                />
              </Field>
              <Field label="Sample Rate">
                <Select
                  value={String(opts.sampleRate)}
                  options={SAMPLE_RATE_OPTIONS.map(String)}
                  labels={SAMPLE_RATE_OPTIONS.map(r => `${r} Hz`)}
                  onChange={v => update({ sampleRate: Number(v) })}
                />
              </Field>
            </div>

            {/* Mute Audio */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-zinc-400 font-medium">Mute Audio</span>
              <ToggleSwitch checked={opts.muted} onChange={v => update({ muted: v })} />
            </div>

            {/* ── Advanced ─────────────────────────────────────────── */}
            <div className="pt-1.5 mt-1 border-t border-zinc-800/60 space-y-2.5">
              <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Advanced</h3>

              {/* Hardware Acceleration */}
              <Field label="Hardware Acceleration">
                <Select
                  value={opts.hardwareAcceleration}
                  options={['if-possible', 'required', 'disable'] as HwAccelMode[]}
                  labels={['If Possible', 'Required', 'Disable']}
                  onChange={v => update(
                    // CRF can't ride along with hardware acceleration
                    v === 'disable'
                      ? { hardwareAcceleration: v as HwAccelMode }
                      : { hardwareAcceleration: v as HwAccelMode, qualityMode: 'bitrate' }
                  )}
                />
                <div className="flex items-start gap-1.5 mt-1">
                  <Info className="w-3 h-3 text-zinc-500 shrink-0 mt-0.5" />
                  <span className="text-[10px] text-zinc-500 leading-tight">
                    VideoToolbox on macOS, NVENC on Windows/Linux with an NVIDIA GPU. Requires bitrate mode; falls back to software when unavailable ("Required" fails instead).
                  </span>
                </div>
              </Field>

              {/* Render Scale */}
              <Field label="Render Scale">
                <Select
                  value={String(opts.scale)}
                  options={SCALE_OPTIONS.map(o => String(o.value))}
                  labels={SCALE_OPTIONS.map(o => o.label)}
                  onChange={v => update({ scale: Number(v) })}
                />
              </Field>

              {/* Concurrency */}
              <Field label="Concurrency">
                <NumberInput value={opts.concurrency} min={1} max={16} onChange={v => update({ concurrency: v })} />
                <div className="flex items-start gap-1.5 mt-1">
                  <Info className="w-3 h-3 text-zinc-500 shrink-0 mt-0.5" />
                  <span className="text-[10px] text-zinc-500 leading-tight">
                    Recommended for your system: {recommendedConcurrency}. Controls parallel Chrome instances — lower = less RAM, higher = faster.
                  </span>
                </div>
              </Field>
            </div>
          </div>
        </div>

        {/* ── Footer with Export button ───────────────────────────── */}
        <div className="px-6 py-3 border-t border-zinc-800 flex justify-end">
          <button
            id="render-export-button"
            onClick={() => onExport(opts)}
            disabled={isExporting}
            className="px-6 py-2.5 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-white transition-all flex items-center gap-2 shadow-lg shadow-orange-500/20"
          >
            <Download className="w-4 h-4" />
            {isExporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
        </div>

        {activeTab === 'gallery' && (
          <div className="absolute inset-0 flex flex-col bg-zinc-900">
            <div className="px-6 py-4 overflow-y-auto flex-1">
              {rendersLoading && (
                <div className="flex items-center justify-center h-40 text-zinc-500 text-sm">Loading renders…</div>
              )}
              {rendersError && !rendersLoading && (
                <div className="flex items-center justify-center h-40 text-red-400 text-sm">{rendersError}</div>
              )}
              {!rendersLoading && !rendersError && renders.length === 0 && (
                <div className="flex items-center justify-center h-40 text-zinc-500 text-sm">
                  No renders yet. Export something first.
                </div>
              )}
              {!rendersLoading && renders.length > 0 && (
                <div className="grid grid-cols-4 gap-3">
                  {renders.map(r => (
                    <RenderCard
                      key={r.id}
                      render={r}
                      isSelected={selectedIds.includes(r.id)}
                      isRenaming={renamingId === r.id}
                      renameValue={renameValue}
                      onSelect={() => toggleSelect(r.id)}
                      onRenameChange={setRenameValue}
                      onRenameCommit={async () => {
                        if (renameValue.trim()) await renameRender(sessionId, r.id, renameValue.trim());
                        setRenamingId(null);
                      }}
                      onRenameCancel={() => setRenamingId(null)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="px-6 py-3 border-t border-zinc-800 flex items-center justify-between">
              <button
                onClick={() => selectedIds.length > 0 && setPendingDelete([...selectedIds])}
                disabled={selectedIds.length === 0}
                className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-red-900/40 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm text-red-400 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                Delete
              </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const r = renders.find(x => x.id === selectedIds[0]);
                    if (r) { setRenamingId(r.id); setRenameValue(r.title); }
                  }}
                  disabled={selectedIds.length !== 1}
                  className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm text-zinc-300 transition-colors"
                >
                  <PenLine className="w-4 h-4" />
                  Edit title
                </button>

                <button
                  onClick={async () => {
                    for (const r of renders.filter(x => selectedIds.includes(x.id))) {
                      const link = document.createElement('a');
                      link.href = `http://localhost:3333${r.downloadUrl}`;
                      link.download = r.filename;
                      document.body.appendChild(link);
                      link.click();
                      document.body.removeChild(link);
                      await new Promise(resolve => setTimeout(resolve, 500));
                    }
                  }}
                  disabled={selectedIds.length === 0}
                  className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-white transition-all shadow-lg shadow-orange-500/20"
                >
                  <Download className="w-4 h-4" />
                  {selectedIds.length > 0 ? `Download (${formatFileSize(totalSelectedSize)})` : 'Download'}
                </button>
              </div>
            </div>
          </div>
        )}
        </div>

      </div>
    </div>,
    document.body
  )}

    {pendingDelete && createPortal(
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={(e) => { if (e.target === e.currentTarget) setPendingDelete(null); }}
      >
        <div className="bg-zinc-900 rounded-xl border border-zinc-700 p-6 max-w-sm w-full mx-4 text-white">
          <h3 className="text-base font-semibold text-red-400 mb-2 flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-red-400" />
            Delete {pendingDelete.length === 1 ? 'render' : `${pendingDelete.length} renders`}?
          </h3>
          <p className="text-sm text-zinc-500 mb-5">
            The video file{pendingDelete.length > 1 ? 's' : ''} and associated data will be permanently deleted. This cannot be undone.
          </p>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setPendingDelete(null)}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm text-white transition-colors"
            >Cancel</button>
            <button
              onClick={async () => {
                await deleteRenders(sessionId, pendingDelete);
                setPendingDelete(null);
                clearSelection();
              }}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg text-sm font-medium transition-colors"
            >Delete</button>
          </div>
        </div>
      </div>,
      document.body
    )}
  </>);
}

// ── Shared UI primitives ────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-zinc-400 font-medium">{label}</label>
      {children}
    </div>
  );
}

function Select<T extends string>({
  value,
  options,
  labels,
  onChange,
}: {
  value: T;
  options: T[];
  labels?: string[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value as T)}
        className="w-full appearance-none px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-orange-500 transition-colors pr-8 cursor-pointer"
      >
        {options.map((opt, i) => (
          <option key={opt} value={opt}>
            {labels ? labels[i] : opt}
          </option>
        ))}
      </select>
      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  onChange,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div className="relative flex-1">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={e => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
        className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-orange-500 transition-colors"
      />
      {suffix && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500 pointer-events-none">{suffix}</span>
      )}
    </div>
  );
}

function QualityModeButton({ active, label, onClick, disabled, title }: { active: boolean; label: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${disabled
          ? 'text-zinc-600 cursor-not-allowed'
          : active
            ? 'bg-orange-600/30 text-orange-400 shadow-sm'
            : 'text-zinc-400 hover:text-zinc-200'
        }`}
    >
      {label}
    </button>
  );
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${checked ? 'bg-orange-500' : 'bg-zinc-700'
        }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition duration-200 ease-in-out ${checked ? 'translate-x-4' : 'translate-x-0'
          }`}
      />
    </button>
  );
}

function RenderCard({
  render, isSelected, isRenaming, renameValue,
  onSelect, onRenameChange, onRenameCommit, onRenameCancel,
}: {
  render: RenderItem;
  isSelected: boolean;
  isRenaming: boolean;
  renameValue: string;
  onSelect: () => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
}) {
  const thumbSrc = render.thumbnailUrl ? `http://localhost:3333${render.thumbnailUrl}` : null;

  return (
    <div
      onClick={onSelect}
      className={`cursor-pointer rounded-lg overflow-hidden border transition-all select-none ${
        isSelected
          ? 'border-orange-500 ring-2 ring-orange-500/40'
          : 'border-zinc-700/50 hover:border-orange-500/40'
      }`}
    >
      <div className="relative aspect-video bg-zinc-800">
        {thumbSrc ? (
          <img src={thumbSrc} alt={render.title} className="w-full h-full object-cover" draggable={false} />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-zinc-700 to-zinc-800 flex items-center justify-center">
            <Download className="w-6 h-6 text-zinc-500" />
          </div>
        )}
      </div>

      <div className="p-2 space-y-0.5">
        {isRenaming ? (
          <input
            autoFocus
            value={renameValue}
            onChange={e => onRenameChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onRenameCommit(); if (e.key === 'Escape') onRenameCancel(); }}
            onBlur={onRenameCommit}
            onClick={e => e.stopPropagation()}
            className="w-full px-1.5 py-0.5 bg-zinc-700 border border-orange-500 rounded text-xs text-white focus:outline-none"
          />
        ) : (
          <div className="text-xs font-medium text-white truncate" title={render.title}>
            {render.title}
          </div>
        )}

        <div className="text-[10px] text-zinc-400 flex items-center gap-1 truncate">
          <span>{render.duration != null ? formatDuration(render.duration) : '—'}</span>
          <span>&bull;</span>
          <span>{formatFileSize(render.fileSize)}</span>
          <span>&bull;</span>
          <span title={render.createdAt ? new Date(render.createdAt).toLocaleString() : ''}>
            {render.createdAt ? formatRelativeDate(render.createdAt) : '—'}
          </span>
        </div>
      </div>
    </div>
  );
}

function formatRelativeDate(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}
