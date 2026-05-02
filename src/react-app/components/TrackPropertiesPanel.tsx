import { X, Volume2, VolumeX } from 'lucide-react';

interface TrackPropertiesPanelProps {
  trackId: string;
  trackName: string;
  autoSnap: boolean;
  onToggleAutoSnap: (enabled: boolean) => void;
  isMuted?: boolean;
  onToggleMute?: () => void;
  onClose: () => void;
}

export default function TrackPropertiesPanel({
  trackId,
  trackName,
  autoSnap,
  onToggleAutoSnap,
  isMuted = false,
  onToggleMute,
  onClose,
}: TrackPropertiesPanelProps) {
  const showMuteToggle = trackId !== 'T1' && onToggleMute;

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

        {showMuteToggle && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-300 cursor-default flex items-center gap-1.5">
              {isMuted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
              Mute
            </span>
            <button
              onClick={onToggleMute}
              className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 ${
                isMuted ? 'bg-red-500' : 'bg-zinc-600'
              }`}
              title={isMuted ? 'Unmute track' : 'Mute track'}
            >
              <span
                className={`absolute top-0.5 left-0 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${
                  isMuted ? 'translate-x-[14px]' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
