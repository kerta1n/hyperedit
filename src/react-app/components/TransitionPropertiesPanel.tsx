import { useCallback, useMemo } from 'react';
import { X } from 'lucide-react';
import type { TimelineTransition, TimelineClip } from '@/react-app/hooks/useProject';
import { getTransitionParams, getTransitionMeta, getRegisteredTransitions } from '@/remotion/transitions/registry';

interface TransitionPropertiesPanelProps {
  transition: TimelineTransition;
  clips: TimelineClip[];
  onUpdate: (id: string, updates: Partial<Omit<TimelineTransition, 'id'>>) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}

export default function TransitionPropertiesPanel({
  transition,
  clips,
  onUpdate,
  onRemove,
  onClose,
}: TransitionPropertiesPanelProps) {
  const meta = getTransitionMeta(transition.transitionFileId);
  const paramSchema = getTransitionParams(transition.transitionFileId);
  const allTransitions = useMemo(() => getRegisteredTransitions(), []);

  // fromClip/toClip used for display only in the selectors below

  const handleParamChange = useCallback((key: string, value: number | string | boolean) => {
    onUpdate(transition.id, {
      params: { ...transition.params, [key]: value },
    });
  }, [onUpdate, transition.id, transition.params]);

  return (
    <div className="p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-zinc-300">
          {meta?.name || 'Transition'}
        </h3>
        <button
          onClick={onClose}
          className="p-0.5 hover:bg-zinc-700 rounded text-zinc-400 hover:text-white"
        >
          <X size={14} />
        </button>
      </div>

      {/* Transition type selector */}
      <div>
        <label className="text-[10px] text-zinc-500 block mb-1">Transition Type</label>
        <select
          value={transition.transitionFileId}
          onChange={(e) => {
            const newId = e.target.value;
            // Reset params to new transition's defaults
            const newSchema = getTransitionParams(newId) || {};
            const newParams: Record<string, number | string | boolean> = {};
            for (const [key, def] of Object.entries(newSchema)) {
              newParams[key] = def.default;
            }
            onUpdate(transition.id, { transitionFileId: newId, params: newParams });
          }}
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300"
        >
          {allTransitions.map(t => (
            <option key={t.id} value={t.id}>{t.meta.name}</option>
          ))}
        </select>
      </div>

      {/* Duration */}
      <div>
        <label className="text-[10px] text-zinc-500 block mb-1">
          Duration: {transition.durationSec.toFixed(2)}s
        </label>
        <input
          type="range"
          min={0.1}
          max={5}
          step={0.05}
          value={transition.durationSec}
          onChange={(e) => onUpdate(transition.id, { durationSec: parseFloat(e.target.value) })}
          className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
        />
      </div>

      {/* Easing */}
      <div>
        <label className="text-[10px] text-zinc-500 block mb-1">Easing</label>
        <select
          value={transition.easing || 'ease-in-out'}
          onChange={(e) => onUpdate(transition.id, { easing: e.target.value })}
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300"
        >
          <option value="linear">Linear</option>
          <option value="ease-in">Ease In</option>
          <option value="ease-out">Ease Out</option>
          <option value="ease-in-out">Ease In-Out</option>
        </select>
      </div>

      {/* From/To clips */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-zinc-500 block mb-1">From</label>
          <select
            value={transition.fromClipId || ''}
            onChange={(e) => onUpdate(transition.id, { fromClipId: e.target.value || null })}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[10px] text-zinc-300"
          >
            <option value="">Black</option>
            {clips.filter(c => c.trackId.startsWith('V')).map(c => (
              <option key={c.id} value={c.id}>
                {c.assetId?.slice(0, 8) || c.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-zinc-500 block mb-1">To</label>
          <select
            value={transition.toClipId || ''}
            onChange={(e) => onUpdate(transition.id, { toClipId: e.target.value || null })}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[10px] text-zinc-300"
          >
            <option value="">Black</option>
            {clips.filter(c => c.trackId.startsWith('V')).map(c => (
              <option key={c.id} value={c.id}>
                {c.assetId?.slice(0, 8) || c.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Dynamic params from schema */}
      {paramSchema && Object.keys(paramSchema).length > 0 && (
        <div className="space-y-2 border-t border-zinc-700 pt-2">
          <div className="text-[10px] text-zinc-500 font-medium">Parameters</div>
          {Object.entries(paramSchema).map(([key, def]) => {
            const value = transition.params[key] ?? def.default;

            if (def.type === 'number') {
              return (
                <div key={key}>
                  <label className="text-[10px] text-zinc-400 block mb-0.5">
                    {def.label || key}: {typeof value === 'number' ? value.toFixed(2) : value}
                  </label>
                  <input
                    type="range"
                    min={def.min ?? 0}
                    max={def.max ?? 1}
                    step={def.step ?? 0.01}
                    value={typeof value === 'number' ? value : def.default as number}
                    onChange={(e) => handleParamChange(key, parseFloat(e.target.value))}
                    className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                  />
                </div>
              );
            }

            if (def.type === 'boolean') {
              return (
                <div key={key} className="flex items-center justify-between">
                  <label className="text-[10px] text-zinc-400">{def.label || key}</label>
                  <button
                    onClick={() => handleParamChange(key, !value)}
                    className={`w-8 h-4 rounded-full transition-colors ${
                      value ? 'bg-purple-500' : 'bg-zinc-700'
                    }`}
                  >
                    <div className={`w-3 h-3 bg-white rounded-full transition-transform ${
                      value ? 'translate-x-4' : 'translate-x-0.5'
                    }`} />
                  </button>
                </div>
              );
            }

            if (def.type === 'string' && def.options) {
              return (
                <div key={key}>
                  <label className="text-[10px] text-zinc-400 block mb-0.5">{def.label || key}</label>
                  <select
                    value={String(value)}
                    onChange={(e) => handleParamChange(key, e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[10px] text-zinc-300"
                  >
                    {def.options.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </div>
              );
            }

            if (def.type === 'color') {
              return (
                <div key={key}>
                  <label className="text-[10px] text-zinc-400 block mb-0.5">{def.label || key}</label>
                  <input
                    type="color"
                    value={String(value)}
                    onChange={(e) => handleParamChange(key, e.target.value)}
                    className="w-full h-6 bg-zinc-800 border border-zinc-700 rounded cursor-pointer"
                  />
                </div>
              );
            }

            // Default: text input
            return (
              <div key={key}>
                <label className="text-[10px] text-zinc-400 block mb-0.5">{def.label || key}</label>
                <input
                  type="text"
                  value={String(value)}
                  onChange={(e) => handleParamChange(key, e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[10px] text-zinc-300"
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Remove button */}
      <button
        onClick={() => onRemove(transition.id)}
        className="w-full px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded text-xs text-red-400 transition-colors"
      >
        Remove Transition
      </button>
    </div>
  );
}
