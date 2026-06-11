export interface ActiveTransition {
  id: string;
  transitionFileId: string;
  startTime: number;
  durationSec: number;
  fromClipId?: string;
  toClipId?: string;
  fromSrc?: string;
  toSrc?: string;
  fromAssetType?: 'video' | 'image';
  toAssetType?: 'video' | 'image';
  fromClipStart?: number;
  fromInPoint?: number;
  fromClipDuration?: number;
  params: Record<string, number | string | boolean>;
}
