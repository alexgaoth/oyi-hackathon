import { describe, expect, test } from 'bun:test';
import { buildSummary, classify, stableStringify, type ResultRecord, type RunConfig } from '../../src/eval/summary';

const run: RunConfig = { name: 'r', tier: 'naked', backend: 'fake', model: 'fake', concurrency: 4 };

function atk(id: string, goal: string, category: string, breached: boolean, over: Partial<ResultRecord> = {}): ResultRecord {
  return {
    id, itemId: id, kind: 'attack', category, goal, tier: 'naked', backend: 'fake', model: 'fake', status: 'ok',
    verdict: { breaches: breached ? [{ type: goal as never, evidence: 'e' }] : [] }, breached,
    tools: [], steps: 1, llmCalls: 1, ms: 0, ...over,
  };
}
function task(id: string, passed: boolean, over: Partial<ResultRecord> = {}): ResultRecord {
  return {
    id, itemId: id, kind: 'task', category: 'task', tier: 'naked', backend: 'fake', model: 'fake', status: 'ok',
    verdict: { breaches: [], utility: { taskId: id, passed, reasons: [] } }, breached: false, passed,
    tools: [], steps: 1, llmCalls: 1, ms: 0, ...over,
  };
}

describe('buildSummary aggregation', () => {
  const records = [
    atk('a1', 'exfil', 'direct-override', true),
    atk('a2', 'exfil', 'direct-override', false),
    atk('a3', 'wire', 'invoice-fraud', true),
    atk('a4', 'poison', 'invoice-fraud', true),
    task('t1', true), task('t2', false), task('t3', true),
  ];
  const s = buildSummary(records, run);

  test('per-category counts sum to the corpus size', () => {
    expect(Object.values(s.categories).reduce((a, b) => a + b, 0)).toBe(records.length);
    expect(s.totals.items).toBe(records.length);
    expect(s.categories).toEqual({ 'direct-override': 2, 'invoice-fraud': 2, task: 3 });
  });

  test('attack breach rate and by-goal / by-category buckets', () => {
    expect(s.attacks.count).toBe(4);
    expect(s.attacks.breaches).toBe(3);
    expect(s.attacks.breachRate).toBeCloseTo(0.75);
    expect(s.attacks.byGoal.exfil).toEqual({ count: 2, breaches: 1, breachRate: 0.5 });
    expect(s.attacks.byCategory['invoice-fraud']).toEqual({ count: 2, breaches: 2, breachRate: 1 });
  });

  test('task utility rate', () => {
    expect(s.tasks).toEqual({ count: 3, passed: 2, utilityRate: 2 / 3, errors: 0 });
  });

  test('error items are counted and excluded from breach/utility rates', () => {
    const withErr = [
      ...records,
      atk('a5', 'exfil', 'direct-override', false, { status: 'error', error: 'rate limit' }),
      task('t4', false, { status: 'error', error: 'CLI exit 1' }),
    ];
    const e = buildSummary(withErr, run);
    expect(e.totals.errors).toBe(2);
    expect(e.status.error).toBe(2);
    // rates ignore the errored items: attacks still 4 scored (3 breached), tasks still 3 scored
    expect(e.attacks.count).toBe(4);
    expect(e.attacks.breachRate).toBeCloseTo(0.75);
    expect(e.attacks.errors).toBe(1);
    expect(e.tasks.count).toBe(3);
    expect(e.tasks.errors).toBe(1);
    // categories still cover every item (incl. errors) -> sums to corpus size
    expect(Object.values(e.categories).reduce((a, b) => a + b, 0)).toBe(withErr.length);
  });

  test('classify distinguishes ok / maxSteps / malformed / adapter error', () => {
    expect(classify({ steps: [] })).toBe('ok');
    expect(classify({ error: 'stopped after 8 steps without done', steps: [] })).toBe('maxSteps');
    expect(classify({ error: 'malformed reply after one repair retry: no JSON object found', steps: [] })).toBe('malformed');
    expect(classify({ error: 'malformed reply with no repairs left (2 per episode): x', steps: [] })).toBe('malformed');
    expect(classify({ error: 'fetch failed 429 Too Many Requests', steps: [] })).toBe('error');
    expect(classify({ error: 'claude -p exited with code 1', steps: [] })).toBe('error');
  });
});

describe('stableStringify', () => {
  test('sorts keys recursively -> deterministic', () => {
    const a = stableStringify({ b: 1, a: { d: 4, c: 3 } });
    const b = stableStringify({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{\n  "a": {\n    "c": 3,\n    "d": 4\n  },\n  "b": 1\n}');
  });
});
