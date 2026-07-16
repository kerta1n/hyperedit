import { X } from 'lucide-react';
import type { CaptionSplitMode } from '@/react-app/hooks/useProject';

const CAPTION_SPLIT_OPTIONS: Array<{ value: CaptionSplitMode; label: string }> = [
  { value: 'both', label: 'Show in both clips' },
  { value: 'left', label: 'Keep in left clip' },
  { value: 'right', label: 'Keep in right clip' },
];

interface TrackPropertiesPanelProps {
  trackId: string;
  trackName: string;
  autoSnap: boolean;
  onToggleAutoSnap: (enabled: boolean) => void;
  captionSplitMode?: CaptionSplitMode;
  onChangeCaptionSplitMode?: (mode: CaptionSplitMode) => void;
  onClose: () => void;
}

export default function TrackPropertiesPanel({
  trackId,
  trackName,
  autoSnap,
  onToggleAutoSnap,
  captionSplitMode = 'both',
  onChangeCaptionSplitMode,
  onClose,
}: TrackPropertiesPanelProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/50">
        <span className="text-xs font-medium text-zinc-400">{trackName} Properties</span>
        <button
          onClick={onClose}
          className="p-1 hover:bg-zinc-700 rounded transition-colors"
          title="Close"
        >
          <X className="w-3.5 h-3.5 text-zinc-500" />
        </button>
      </div>

      <div className="p-3 space-y-3 overflow-y-auto flex-1">
        <div className="flex items-center justify-between">
          <span
            className="text-xs text-zinc-300 cursor-default"
            title="If enabled, deleting a clip on this track will auto-snap the remaining clips to the left."
          >
            Auto-snap
          </span>
          <button
            onClick={() => onToggleAutoSnap(!autoSnap)}
            className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 ${
              autoSnap ? 'bg-blue-500' : 'bg-zinc-600'
            }`}
            title={autoSnap ? 'Disable auto-snap' : 'Enable auto-snap'}
          >
            <span
              className={`absolute top-0.5 left-0 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${
                autoSnap ? 'translate-x-[14px]' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {/* Subtitles-track-only: what happens to a word the cut lands in */}
        {trackId === 'T1' && onChangeCaptionSplitMode && (
          <div>
            <span
              className="text-xs font-medium text-zinc-300 block mb-2 cursor-default"
              title="When you cut a caption in the middle of a word, choose which clip keeps that word."
            >
              Cutting through a word
            </span>
            <select
              value={captionSplitMode}
              onChange={(e) => onChangeCaptionSplitMode(e.target.value as CaptionSplitMode)}
              className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-white"
            >
              {CAPTION_SPLIT_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  );
}
