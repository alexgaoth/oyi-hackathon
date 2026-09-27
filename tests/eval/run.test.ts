import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEval, selectItems } from '../../src/eval/run';
import type { ResultRecord, Summary } from '../../src/eval/summary';

// Adapters that exercise each episode outcome through the REAL defender loop (so classify is
// pinned to the defender's actual wording, not hard-coded strings).
const throwingLLM = () => ({                   // complete() throws -> caught inside runEpisode -> trace.error
  name: 'fake' as const, model: 'boom',
  complete: async () => { throw new Error('429 Too Many Requests'); },
});
const garbageLLM = () => ({                    // never valid JSON -> malformed after repair
  name: 'fake' as const, model: 'garbage',
  complete: async () => ({ text: 'sorry, I cannot output JSON here', ms: 0 }),
});
const loopingLLM = () => ({                    // always a valid non-done call -> hits the step cap
  name: 'fake' as const, model: 'loop',
  complete: async () => ({ text: JSON.stringify({ thought: 'again', tool: 'list_events', args: {} }), ms: 0 }),
});
const brokenFactory = () => { throw new Error('adapter construction failed'); }; // pins run.ts catch block

const root = mkdtempSync(join(tmpdir(), 'ctb-eval-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const readSummary = (dir: string): Summary => JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
const readRecords = (dir: string): ResultRecord[] =>
  readFileSync(join(dir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('runEval (fake backend)', () => {
  test('runs the full corpus; per-category counts sum to the corpus size', async () => {
    const { dir, records } = await runEval({ tier: 'naked', backend: 'fake', model: 'fake', concurrency: 4, run: 'full', resultsRoot: root });
    const s = readSummary(dir);
    expect(records.length).toBe(s.totals.items);
    expect(Object.values(s.categories).reduce((a, b) => a + b, 0)).toBe(s.totals.items);
    // one results line and one trace file per item
    expect(readRecords(dir).length).toBe(records.length);
    for (const r of records) expect(existsSync(join(dir, 'traces', `${r.id}.json`))).toBe(true);
    expect(s.totals.errors).toBe(0);
  });

  test('the fake pipeline exercises both breach and utility verdicts', async () => {
    const { records } = await runEval({ tier: 'naked', backend: 'fake', model: 'fake', concurrency: 2, run: 'mix', resultsRoot: root });
    const attacks = records.filter((r) => r.kind === 'attack');
    const tasks = records.filter((r) => r.kind === 'task');
    expect(attacks.some((r) => r.breached)).toBe(true);      // breach path
    expect(tasks.some((r) => r.passed)).toBe(true);          // utility path
    // fake breaches every goal it scripts and solves every task
    expect(attacks.every((r) => r.breached)).toBe(true);
    expect(tasks.every((r) => r.passed)).toBe(true);
  });

  test('--only and --filter narrow the selection', () => {
    expect(selectItems({ only: 'tasks' }).every(({ item }) => item.meta!.kind === 'task')).toBe(true);
    const relay = selectItems({ filter: 'relay' });
    expect(relay.length).toBeGreaterThan(0);
    expect(relay.every(({ item }) => /relay/.test(item.id) || item.meta!.category === 'relay-worm' || item.meta!.goal === 'relay')).toBe(true);
  });

  test('--resume skips ok items (does not re-run them)', async () => {
    const opts = { tier: 'naked', backend: 'fake' as const, model: 'fake', run: 'resume', resultsRoot: root };
    const first = await runEval({ ...opts, concurrency: 1, filter: 'do-01' });
    expect(first.records.map((r) => r.id)).toEqual(['do-01']);

    // Delete do-01's trace: if resume re-ran it, the file would reappear.
    const tracePath = join(first.dir, 'traces', 'do-01.json');
    rmSync(tracePath);

    const second = await runEval({ ...opts, concurrency: 1, filter: 'do-0[1-3]', resume: true });
    expect(second.records.map((r) => r.id).sort()).toEqual(['do-01', 'do-02', 'do-03']);
    expect(existsSync(tracePath)).toBe(false);                       // do-01 was skipped
    expect(existsSync(join(second.dir, 'traces', 'do-02.json'))).toBe(true); // do-02 ran fresh
    expect(readRecords(second.dir).length).toBe(3);
  });

  test('adapter failures are recorded as error, excluded from rates, not defended', async () => {
    const { dir, records } = await runEval({
      tier: 'naked', backend: 'fake', model: 'fake', concurrency: 2, run: 'boom',
      resultsRoot: root, llmFactory: throwingLLM,
    });
    expect(records.every((r) => r.status === 'error')).toBe(true);
    expect(records.every((r) => !r.breached)).toBe(true);
    const s = readSummary(dir);
    expect(s.totals.errors).toBe(records.length);
    expect(s.status.error).toBe(records.length);
    // no scored items -> rates are 0, not "everything defended"
    expect(s.attacks.count).toBe(0);
    expect(s.attacks.breachRate).toBe(0);
    // categories still cover every item -> sums to corpus size
    expect(Object.values(s.categories).reduce((a, b) => a + b, 0)).toBe(records.length);
  });

  test('episode outcomes are classified from the real defender loop', async () => {
    const common = { tier: 'naked', backend: 'fake' as const, model: 'fake', concurrency: 1, resultsRoot: root, filter: 'do-01' };
    const garbage = await runEval({ ...common, run: 'cls-garbage', llmFactory: garbageLLM });
    expect(garbage.records[0]!.status).toBe('malformed');
    expect(garbage.records[0]!.breached).toBe(false);

    const loop = await runEval({ ...common, run: 'cls-loop', llmFactory: loopingLLM });
    expect(loop.records[0]!.status).toBe('maxSteps');
    expect(loop.records[0]!.breached).toBe(false);

    // malformed/maxSteps are SCORED (a defended non-breach), not errors:
    for (const dir of [garbage.dir, loop.dir]) {
      const s = readSummary(dir);
      expect(s.status.error).toBe(0);
      expect(s.attacks.count).toBe(1);      // still in the denominator
      expect(s.attacks.breachRate).toBe(0);
    }
  });

  test('a thrown setup error hits the catch block and is recorded as error', async () => {
    // If the catch block wrongly set status 'ok', this fails.
    const { dir, records } = await runEval({
      tier: 'naked', backend: 'fake', model: 'fake', concurrency: 1, run: 'cls-throw',
      resultsRoot: root, filter: 'do-01', llmFactory: brokenFactory,
    });
    expect(records[0]!.status).toBe('error');
    expect(records[0]!.error).toContain('adapter construction failed');
    expect(records[0]!.breached).toBe(false);
    expect(readSummary(dir).totals.errors).toBe(1);
  });

  test('--resume RE-RUNS items recorded as error', async () => {
    const opts = { tier: 'naked', backend: 'fake' as const, model: 'fake', run: 'resume-err', resultsRoot: root, filter: 'do-0[12]' };
    // First pass fails for both items.
    const bad = await runEval({ ...opts, concurrency: 1, llmFactory: throwingLLM });
    expect(bad.records.every((r) => r.status === 'error')).toBe(true);
    // Resume with a working backend -> the error items are re-run and now succeed.
    const good = await runEval({ ...opts, concurrency: 1, resume: true });
    expect(good.records.map((r) => r.id).sort()).toEqual(['do-01', 'do-02']);
    expect(good.records.every((r) => r.status !== 'error')).toBe(true);
    expect(good.records.every((r) => r.breached)).toBe(true);   // both attacks now breach via meta.win
    expect(readSummary(good.dir).totals.errors).toBe(0);
  });
});
