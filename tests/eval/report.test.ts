import { describe, expect, test } from 'bun:test';
import { renderReport } from '../../src/eval/report';
import { buildSummary, type ResultRecord, type RunConfig } from '../../src/eval/summary';

const cfg = (name: string): RunConfig => ({ name, tier: 'naked', backend: 'fake', model: 'fake', concurrency: 4 });
const atk = (id: string, goal: string, breached: boolean): ResultRecord => ({
  id, itemId: id, kind: 'attack', category: 'direct-override', goal, tier: 'naked', backend: 'fake', model: 'fake', status: 'ok',
  verdict: { breaches: breached ? [{ type: goal as never, evidence: 'e' }] : [] }, breached, tools: [], steps: 1, llmCalls: 1, ms: 0,
});
const task = (id: string, passed: boolean): ResultRecord => ({
  id, itemId: id, kind: 'task', category: 'task', tier: 'naked', backend: 'fake', model: 'fake', status: 'ok',
  verdict: { breaches: [], utility: { taskId: id, passed, reasons: [] } }, breached: false, passed, tools: [], steps: 1, llmCalls: 1, ms: 0,
});

const s1 = buildSummary([atk('a1', 'exfil', true), atk('a2', 'wire', false), task('t1', true)], cfg('run-a'));
const s2 = buildSummary([atk('a1', 'exfil', false), atk('a2', 'wire', false), task('t1', false)], cfg('run-b'));

describe('report determinism', () => {
  test('single-run report is byte-identical across calls', () => {
    expect(renderReport([s1])).toBe(renderReport([s1]));
  });
  test('single-run report has the headline sections and fixed % formatting', () => {
    const out = renderReport([s1]);
    expect(out).toContain('=== Eval report ===');
    expect(out).toContain('Breach rate by goal');
    expect(out).toMatch(/breach rate +50\.0%/); // 1 of 2 attacks breached
    expect(out).toMatch(/utility rate +100\.0%/);
    expect(out).toContain('errors');
    expect(out.endsWith('\n')).toBe(true);
  });
  test('comparison report is byte-identical and column order is sorted by run name', () => {
    expect(renderReport([s1, s2])).toBe(renderReport([s2, s1]));
    const out = renderReport([s2, s1]);
    expect(out).toContain('=== Eval comparison ===');
    expect(out.indexOf('run-a')).toBeLessThan(out.indexOf('run-b'));
    expect(out).toContain('overall breach rate');
  });
});
