// Replay mode (demo insurance, PLAN.md): load saved eval runs (results/<run>/results.jsonl +
// traces/<id>.json, the layout src/eval/run.ts writes) and map each episode to a lane. Nothing
// here constructs or calls an LLM adapter.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTACKS_DIR, TASKS_DIR } from '../eval/corpus';
import { classify, type ResultRecord } from '../eval/summary';
import type { Inbound, Trace, Verdict } from '../types';
import type { LaneConfig } from './lanes';
import { LIMITS } from './attack';

/** `error`: the episode failed for infrastructure reasons and is replayed as such (not scored). */
export interface ReplayEpisode { item: Inbound; trace: Trace; verdict: Verdict; error?: string }

/**
 * The infra failure in a finished trace, if any: the eval's classify() says 'error' (the adapter
 * threw, not a step cap or malformed output), or the judge crashed (the defender prefixes
 * "judge failed", which classify() alone misses when a malformed stop is also recorded).
 */
export function infraError(trace: Pick<Trace, 'error' | 'steps'>): string | undefined {
  const e = trace.error;
  return e !== undefined && (classify(trace) === 'error' || /^judge failed/.test(e)) ? e : undefined;
}

/** Every corpus item by id, sample-*.json included (run-one/eval runs can use them). */
function corpusIndex(): Map<string, Inbound> {
  const out = new Map<string, Inbound>();
  for (const dir of [ATTACKS_DIR, TASKS_DIR]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      try {
        const it = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Inbound;
        if (it?.id) out.set(it.id, it);
      } catch { /* not an item */ }
    }
  }
  return out;
}

/** Stable pseudo-random order so categories and tasks interleave the same way every run. */
const mixKey = (id: string) => [...id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

/**
 * One episode per trace file in `<dir>/traces`. The verdict comes from results.jsonl (a trace
 * without a record replays with no breaches); the item from world/ by id. Corpus attacks have no
 * player, so their category stands in as the leaderboard handle.
 */
export function loadRun(dir: string): ReplayEpisode[] {
  const tracesDir = join(dir, 'traces');
  if (!existsSync(tracesDir)) throw new Error(`${dir}: no traces/ directory (expected an eval run: results/<run>)`);
  const records = new Map<string, ResultRecord>();
  const resultsPath = join(dir, 'results.jsonl');
  if (existsSync(resultsPath)) {
    for (const line of readFileSync(resultsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as ResultRecord;
      records.set(r.id, r);
    }
  }
  const corpus = corpusIndex();
  const episodes: ReplayEpisode[] = [];
  for (const f of readdirSync(tracesDir).filter((n) => n.endsWith('.json')).sort()) {
    const trace = JSON.parse(readFileSync(join(tracesDir, f), 'utf8')) as Trace;
    const rec = records.get(trace.inboundId);
    const item: Inbound = structuredClone(corpus.get(trace.inboundId)) ?? {
      id: trace.inboundId, channel: 'email', auth: 'none', from: { name: 'corpus item', address: 'unknown@corpus.invalid' },
      body: '(original item not found under world/)',
      meta: { kind: rec?.kind ?? 'attack', ...(rec?.category && { category: rec.category }) },
    };
    if (item.meta?.kind === 'attack' && !item.meta.player) item.meta.player = (item.meta.category ?? 'corpus').slice(0, LIMITS.player);
    const error = rec?.status === 'error' ? (rec.error ?? trace.error ?? 'eval harness error') : infraError(trace);
    episodes.push({ item, trace, verdict: rec?.verdict ?? { breaches: [] }, ...(error !== undefined && { error }) });
  }
  return episodes.sort((a, b) => mixKey(a.item.id) - mixKey(b.item.id) || a.item.id.localeCompare(b.item.id));
}

/**
 * Episodes go to the lane(s) whose tier matches the trace's tier (round-robin among them); a
 * tier no lane has goes round-robin over all lanes. Lanes that replay something show the tiers
 * and models actually replayed, marked "(replay)", so the projector never overstates a lane.
 */
export function assignLanes(lanes: LaneConfig[], episodes: ReplayEpisode[]): { lanes: LaneConfig[]; byLane: Map<string, ReplayEpisode[]> } {
  const byLane = new Map<string, ReplayEpisode[]>(lanes.map((l) => [l.id, []]));
  const turn = new Map<string, number>();
  for (const ep of episodes) {
    const matching = lanes.filter((l) => l.tier === ep.trace.tier);
    const pool = matching.length ? matching : lanes;
    const key = matching.length ? ep.trace.tier : '*';
    const n = turn.get(key) ?? 0;
    turn.set(key, n + 1);
    byLane.get(pool[n % pool.length]!.id)!.push(ep);
  }
  const shown = lanes.map((l) => {
    const eps = byLane.get(l.id)!;
    if (!eps.length) return { ...l, model: 'no replay data' };
    const uniq = (xs: string[]) => [...new Set(xs)].join('/');
    return { ...l, tier: uniq(eps.map((e) => e.trace.tier)), model: `${uniq(eps.map((e) => e.trace.model))} (replay)` };
  });
  return { lanes: shown, byLane };
}
