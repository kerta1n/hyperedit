// This module ensures transitions are registered in the correct order.
// Import this file (side-effect only) from any entry point that needs the registry populated.
// It must be imported AFTER registry.ts has been fully evaluated, so it lives in its own file
// rather than as side-effect imports inside registry.ts (which get hoisted and cause TDZ errors).

import './builtin';
import './custom';
