// Arena lane config: config/lanes.json is a JSON array of
//   { "id": "easy", "label": "EASY", "tier": "naked", "backend": "ollama", "model": "qwen3:4b",
//     "points": 100, "maxSteps": 4, "deadlineSec": 120 }
// Optional: `points` per breached attack (default 100), `maxSteps` tool calls per episode
// (default 8), `deadlineSec` wall-clock budget per episode (default 90; past it the episode is
// aborted and reported as an infra error, not scored). Edit the file to retune the lanes.
import { readFileSync } from 'node:fs';
import { getTier } from '../tiers';

export const BACKENDS = ['claude-cli', 'ollama', 'anthropic', 'openai', 'river', 'fake'] as const;
export type LaneBackend = (typeof BACKENDS)[number];

export interface LaneConfig {
  id: string; label: string; tier: string; backend: LaneBackend; model: string;
  points?: number; maxSteps?: number; deadlineSec?: number;
}

export const LANE_DEFAULTS = { points: 100, maxSteps: 8, deadlineSec: 90 } as const;
export const lanePoints = (lane: LaneConfig): number => lane.points ?? LANE_DEFAULTS.points;

/** Validate a parsed lanes file; throws a readable error naming the bad lane. */
export function parseLanes(raw: unknown, source = 'lanes'): LaneConfig[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${source}: expected a non-empty JSON array of lanes`);
  const seen = new Set<string>();
  return raw.map((l, i) => {
    const where = `${source}[${i}]`;
    const str = (k: string) => {
      const v = (l as Record<string, unknown>)?.[k];
      if (typeof v !== 'string' || !v.trim()) throw new Error(`${where}: "${k}" must be a non-empty string`);
      return v.trim();
    };
    const lane: LaneConfig = { id: str('id'), label: str('label'), tier: str('tier'), backend: str('backend') as LaneBackend, model: str('model') };
    if (seen.has(lane.id)) throw new Error(`${where}: duplicate lane id "${lane.id}"`);
    seen.add(lane.id);
    getTier(lane.tier); // throws on an unknown tier
    if (!BACKENDS.includes(lane.backend)) throw new Error(`${where}: backend must be one of ${BACKENDS.join(', ')}`);
    const num = (k: 'points' | 'maxSteps' | 'deadlineSec', ok: (n: number) => boolean, what: string) => {
      const v = (l as Record<string, unknown>)[k];
      if (v === undefined) return;
      if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) throw new Error(`${where}: "${k}" must be ${what}`);
      lane[k] = v;
    };
    num('points', (n) => n >= 0, 'a number >= 0');
    num('maxSteps', (n) => Number.isInteger(n) && n >= 1, 'an integer >= 1');
    num('deadlineSec', (n) => n > 0, 'a number > 0');
    return lane;
  });
}

export function loadLanes(file: string): LaneConfig[] {
  return parseLanes(JSON.parse(readFileSync(file, 'utf8')), file);
}

const DEFAULT_MODEL: Partial<Record<LaneBackend, string>> = { 'claude-cli': 'haiku', ollama: 'qwen3:4b', fake: 'fake' };

/** `--backend` / `--model` / `--max-steps` apply to every lane (tests, smoke runs, budget mode). */
export function overrideLanes(lanes: LaneConfig[], o: { backend?: string; model?: string; maxSteps?: number }): LaneConfig[] {
  if (o.backend !== undefined && !BACKENDS.includes(o.backend as LaneBackend)) {
    throw new Error(`--backend must be one of ${BACKENDS.join(', ')}`);
  }
  const model = o.model ?? (o.backend !== undefined ? DEFAULT_MODEL[o.backend as LaneBackend] : undefined);
  if (o.backend !== undefined && model === undefined) throw new Error(`--model is required with --backend ${o.backend}`);
  return lanes.map((l) => ({
    ...l,
    ...(o.backend !== undefined && { backend: o.backend as LaneBackend }),
    ...(model !== undefined && { model }),
    ...(o.maxSteps !== undefined && { maxSteps: o.maxSteps }),
  }));
}
