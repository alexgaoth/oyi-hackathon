// Brain backend contract. World.state.brain stays the source of truth (the judge diffs it),
// so a backend only decides how pages are searched and how reads/writes reach that record.
import type { World } from '../world/world';

export interface SearchHit { path: string; title: string; snippet: string }

export interface BrainBackend {
  readonly name: string;
  /** search_brain: up to 5 non-vault hits. */
  search(world: World, query: string): { results: SearchHit[] };
  /** Paths arrive normalized and already refused if under vault/. */
  read(world: World, path: string): string | undefined;
  write(world: World, path: string, content: string): void;
}

/** Vault pages are reachable only through read_vault, never through brain tools or any index. */
export const isVault = (path: string) => path.startsWith('vault/');
