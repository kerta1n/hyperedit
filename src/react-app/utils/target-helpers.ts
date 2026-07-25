import type { Asset, TimelineClip } from '@/react-app/hooks/useProject';

export interface TimelineVideoTarget {
  asset: Asset;
  clip: TimelineClip;
}

// Derives the video asset an operation should act on from the TIMELINE, not
// from asset-library order: a selected video clip wins, otherwise the earliest
// video clip across all V tracks. Library-order scans are nondeterministic —
// assets restore in disk order after a server restart — so the timeline is the
// only stable statement of intent. Returns null when no video is on the
// timeline; callers decide whether that is an error or "no context".
export function deriveTimelineVideoTarget(
  clips: TimelineClip[],
  assets: Asset[],
  options: { selectedClipId?: string | null; preferNonAi?: boolean } = {},
): TimelineVideoTarget | null {
  const assetById = new Map(assets.map(a => [a.id, a]));
  const videoAssetOf = (clip: TimelineClip): Asset | null => {
    if (!clip.trackId.startsWith('V')) return null;
    const asset = assetById.get(clip.assetId);
    return asset?.type === 'video' ? asset : null;
  };

  if (options.selectedClipId) {
    const selected = clips.find(c => c.id === options.selectedClipId);
    const asset = selected ? videoAssetOf(selected) : null;
    if (selected && asset) return { asset, clip: selected };
  }

  const candidates = clips
    .filter(c => videoAssetOf(c) !== null)
    .sort((a, b) => a.start - b.start);
  if (candidates.length === 0) return null;

  if (options.preferNonAi) {
    const nonAi = candidates.find(c => !videoAssetOf(c)!.aiGenerated);
    if (nonAi) return { asset: videoAssetOf(nonAi)!, clip: nonAi };
  }
  return { asset: videoAssetOf(candidates[0])!, clip: candidates[0] };
}
