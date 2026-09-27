// Result records (one per results.jsonl line) and the summary aggregation over them.
import type { Trace, Verdict } from '../types';
import { countBy } from './corpus';

export interface RunConfig { name: string; tier: string; backend: string; model: string; concurrency: number; only?: string; filter?: string }

/**
 * Episode outcome, distinct from the verdict:
 *  - ok        the agent ran to `done`
 *  - maxSteps  the agent hit the step cap without finishing (a defense outcome, still scored)
 *  - malformed the model's replies could not be parsed (a defense/model outcome, still scored)
 *  - error     the LLM/adapter failed (rate limit, call cap, CLI exit, 5xx) — NOT scored, re-run on --resume
 */
export type Status = 'ok' | 'maxSteps' | 'malformed' | 'error';

/**
 * Classify an episode from its trace. A clean stop (step cap / unparseable model output) is a
 * defense outcome; anything else (adapter threw) is an infra error. The matchers are loose so
 * minor defender wording changes don't misclassify; the real-behavior tests in tests/eval/run
 * (garbage -> malformed, looping -> maxSteps) pin them to the defender's actual output.
 */
export function classify(trace: Pick<Trace, 'error' | 'steps'>): Status {
  if (!trace.error) return 'ok';
  // Anchored at the start: the defender composes its own clean-stop messages at the front, and
  // prefixes a judge crash as "judge failed: <msg>; <previous error>". An anchored match keeps a
  // judge failure that lands after a clean stop classified as an infra error, not as a defense.
  if (/^malformed reply\b/i.test(trace.error)) return 'malformed';
  if (/^stopped after \d+ steps without done/i.test(trace.error)) return 'maxSteps';
  return 'error';
}

export const isScored = (r: { status: Status }) => r.status !== 'error';

export interface ResultRecord {
  id: string; itemId: string; kind: 'attack' | 'task'; category: string;
  goal?: string; tier: string; backend: string; model: string;
  status: Status;
  verdict: Verdict; breached: boolean; passed?: boolean;
  tools: string[]; steps: number; llmCalls: number; ms: number;
  traceError?: string;   // episode note carried from the trace (max steps / malformed / adapter msg)
  error?: string;        // adapter/harness failure message; item is status 'error' and excluded from rates
}

export interface RateBucket { count: number; breaches: number; breachRate: number }
const bucket = (count: number, breaches: number): RateBucket => ({ count, breaches, breachRate: count ? breaches / count : 0 });

function rateBy(records: ResultRecord[], key: (r: ResultRecord) => string): Record<string, RateBucket> {
  const groups: Record<string, ResultRecord[]> = {};
  for (const r of records) (groups[key(r)] ??= []).push(r);
  const out: Record<string, RateBucket> = {};
  for (const k of Object.keys(groups).sort()) {
    const g = groups[k]!;
    out[k] = bucket(g.length, g.filter((r) => r.breached).length);
  }
  return out;
}

const statusCounts = (records: ResultRecord[]) => ({
  ok: records.filter((r) => r.status === 'ok').length,
  maxSteps: records.filter((r) => r.status === 'maxSteps').length,
  malformed: records.filter((r) => r.status === 'malformed').length,
  error: records.filter((r) => r.status === 'error').length,
});

export interface Summary {
  run: RunConfig;
  totals: { items: number; attacks: number; tasks: number; breaches: number; tasksPassed: number; errors: number; maxSteps: number; malformed: number };
  status: { ok: number; maxSteps: number; malformed: number; error: number };
  // Rates cover SCORED items only (errors excluded); `errors` counts the excluded ones.
  attacks: RateBucket & { errors: number; byGoal: Record<string, RateBucket>; byCategory: Record<string, RateBucket> };
  tasks: { count: number; passed: number; utilityRate: number; errors: number };
  categories: Record<string, number>;  // EVERY item, keyed by category (tasks -> "task"); sums to items
  errors: number;
}

export function buildSummary(records: ResultRecord[], run: RunConfig): Summary {
  const attacks = records.filter((r) => r.kind === 'attack');
  const tasks = records.filter((r) => r.kind === 'task');
  const scoredAttacks = attacks.filter(isScored);
  const scoredTasks = tasks.filter(isScored);
  const breaches = scoredAttacks.filter((r) => r.breached).length;
  const passed = scoredTasks.filter((r) => r.passed).length;
  const st = statusCounts(records);
  // Keys sorted so the object serializes deterministically.
  const categories = Object.fromEntries(Object.entries(countBy(records, (r) => r.category)).sort(([a], [b]) => a.localeCompare(b)));
  return {
    run,
    totals: {
      items: records.length, attacks: attacks.length, tasks: tasks.length, breaches, tasksPassed: passed,
      errors: st.error, maxSteps: st.maxSteps, malformed: st.malformed,
    },
    status: st,
    attacks: {
      ...bucket(scoredAttacks.length, breaches),
      errors: attacks.length - scoredAttacks.length,
      byGoal: rateBy(scoredAttacks, (r) => r.goal ?? '?'),
      byCategory: rateBy(scoredAttacks, (r) => r.category),
    },
    tasks: { count: scoredTasks.length, passed, utilityRate: scoredTasks.length ? passed / scoredTasks.length : 0, errors: tasks.length - scoredTasks.length },
    categories,
    errors: st.error,
  };
}

/** Stable JSON: object keys sorted recursively (numbers/strings unchanged). */
export function stableStringify(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])]));
    return x;
  };
  return JSON.stringify(norm(v), null, 2);
}
