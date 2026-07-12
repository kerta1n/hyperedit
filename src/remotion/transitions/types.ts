// --- Transition Param Schema ---

export interface TransitionParamDef {
  type: 'number' | 'string' | 'boolean' | 'color';
  default: number | string | boolean;
  label: string;
  min?: number;       // for number
  max?: number;       // for number
  step?: number;      // for number
  options?: string[]; // for string (renders as dropdown)
}

export type TransitionParamSchema = Record<string, TransitionParamDef>;

// --- Transition Metadata ---

export interface TransitionMeta {
  name: string;
  description?: string;
  /** Orientation compatibility. Declare only when the effect is inherently
   *  orientation-specific (e.g. a corner box tuned for landscape); omit for
   *  canvas-independent transitions. Defaults to 'any'. */
  canvas?: 'any' | 'landscape' | 'portrait';
}

// --- Props passed to every custom transition .tsx component ---

export interface CustomTransitionProps {
  /** Source URL of the outgoing (FROM) clip. undefined = black. */
  fromSrc?: string;
  /** Source URL of the incoming (TO) clip. undefined = black. */
  toSrc?: string;
  /** Asset types so the component knows whether to use <OffthreadVideo> or <Img> */
  fromAssetType?: 'video' | 'image';
  toAssetType?: 'video' | 'image';
  /** Frame offset into the FROM clip's source media where the transition starts */
  fromStartFrom?: number;
  /** Frame offset into the TO clip's source media where the transition starts */
  toStartFrom?: number;
  /** User-configured param values from the properties panel */
  params: Record<string, number | string | boolean>;
}
