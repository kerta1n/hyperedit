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
  /** User-configured param values from the properties panel */
  params: Record<string, number | string | boolean>;
}
