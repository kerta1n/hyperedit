export interface CustomTransitionProps {
  /** Optional: source URL of the outgoing (FROM) clip, if the transition wants to composite it */
  fromSrc?: string;
  /** Optional: source URL of the incoming (TO) clip, if the transition wants to composite it */
  toSrc?: string;
  /** Optional: asset types so the component knows whether to use <OffthreadVideo> or <Img> */
  fromAssetType?: 'video' | 'image';
  toAssetType?: 'video' | 'image';
}
