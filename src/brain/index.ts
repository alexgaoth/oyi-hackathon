// Brain backend selection: CTB_BRAIN=gbrain uses GBrain for search; unset (or "markdown") keeps
// the plain markdown brain.
import { GbrainBrain } from './gbrain';
import { markdownBrain } from './markdown';
import type { BrainBackend } from './types';

export { isVault, type BrainBackend, type SearchHit } from './types';

let gbrain: GbrainBrain | undefined;

export function brain(): BrainBackend {
  const want = process.env.CTB_BRAIN ?? 'markdown';
  if (want === 'markdown') return markdownBrain;
  if (want === 'gbrain') return (gbrain ??= new GbrainBrain());
  throw new Error(`CTB_BRAIN must be "markdown" or "gbrain", got "${want}"`);
}

// Start gbrain setup (init + import, ~10 s) in the background at import, not on the first search.
if (process.env.CTB_BRAIN === 'gbrain') brain();
