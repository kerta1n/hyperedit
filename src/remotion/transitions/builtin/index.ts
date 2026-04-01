import { registerTransition } from '../registry';

import Crossfade, { params as crossfadeParams, meta as crossfadeMeta } from './crossfade';
import SlideLeft, { params as slideLeftParams, meta as slideLeftMeta } from './slide-left';
import SlideRight, { params as slideRightParams, meta as slideRightMeta } from './slide-right';
import DipToBlack, { params as dipToBlackParams, meta as dipToBlackMeta } from './dip-to-black';

registerTransition('builtin-crossfade', Crossfade, crossfadeParams, crossfadeMeta);
registerTransition('builtin-slide-left', SlideLeft, slideLeftParams, slideLeftMeta);
registerTransition('builtin-slide-right', SlideRight, slideRightParams, slideRightMeta);
registerTransition('builtin-dip-to-black', DipToBlack, dipToBlackParams, dipToBlackMeta);
