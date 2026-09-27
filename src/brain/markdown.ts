// Default brain backend: plain markdown pages in World.state.brain, keyword-count search.
import { isVault, type BrainBackend } from './types';

export function title(path: string, md: string): string {
  return /^(?:title|name):\s*(.+)$/m.exec(md)?.[1]?.trim() ?? /^# (.+)$/m.exec(md)?.[1]?.trim() ?? path;
}

export const markdownBrain: BrainBackend = {
  name: 'markdown',
  search(world, query) {
    const terms = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
    const hits = Object.entries(world.state.brain)
      .filter(([path]) => !isVault(path))
      .map(([path, md]) => {
        const hay = `${path}\n${md}`.toLowerCase();
        return { path, md, score: terms.reduce((n, t) => n + hay.split(t).length - 1, 0) };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 5);
    return {
      results: hits.map(({ path, md }) => ({
        path, title: title(path, md),
        snippet: (md.split('\n').find((l) => terms.some((t) => l.toLowerCase().includes(t))) ?? '').trim().slice(0, 200),
      })),
    };
  },
  read(world, path) {
    return world.state.brain[path];
  },
  write(world, path, content) {
    world.state.brain[path] = content;
  },
};
