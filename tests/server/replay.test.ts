// Replay mode (demo insurance): every saved trace of a run is streamed as queued -> steps ->
// verdict -> score, with zero LLM adapter calls. Fixture runs are produced by the eval runner with
// the fake backend into a temp dir; the adapter counters are reset before replaying.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as llm from '../../src/llm';
import type { Trace } from '../../src/types';
import { ROOT, connect, type Ev, fakeLanes, forItem, post } from './helpers';

// Count every adapter construction in this process, whoever asks for it.
let makeLLMCalls = 0;
const realMakeLLM = llm.makeLLM;
mock.module('../../src/llm', () => ({ ...llm, makeLLM: (o: llm.LLMOptions) => { makeLLMCalls++; return realMakeLLM(o); } }));

const { runEval } = await import('../../src/eval/run');
const { Arena } = await import('../../src/server/arena');
const { assignLanes, infraError, loadRun } = await import('../../src/server/replay');

let tmp: string;
let naked: string;
let prompted: string;
let broken: string;
const traceIds = (dir: string) => readdirSync(join(dir, 'traces')).map((f) => f.replace(/\.json$/, '')).sort();
const readTrace = (dir: string, id: string) => JSON.parse(readFileSync(join(dir, 'traces', `${id}.json`), 'utf8')) as Trace;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ctb-replay-'));
  const common = { backend: 'fake' as const, model: 'fake', concurrency: 4, resultsRoot: tmp };
  naked = (await runEval({ ...common, tier: 'naked', run: 'naked', filter: '^(ai-0[1-4]|di-01|t-0[1-3])$' })).dir;
  prompted = (await runEval({ ...common, tier: 'prompted', run: 'prompted', filter: '^(ai-0[1-2]|t-01)$' })).dir;
  // a run whose backend died (quota): recorded by the eval as status 'error'
  const dead: llm.LLM = { name: 'claude-cli', model: 'haiku', complete: async () => { throw new Error('usage limit reached'); } };
  broken = (await runEval({ ...common, tier: 'scoped', run: 'broken', filter: '^(ai-0[1-2])$', llmFactory: () => dead })).dir;
  expect(traceIds(naked).length).toBe(8);
  expect(traceIds(prompted).length).toBe(3);
  expect(makeLLMCalls).toBe(11); // negative control: the counter sees adapters built anywhere in-process
  makeLLMCalls = 0; // fixture creation used the fake adapter; replay must not
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('replay', () => {
  test('loadRun: one episode per trace, verdicts from results.jsonl, items from world/', () => {
    const eps = loadRun(naked);
    expect(eps.map((e) => e.item.id).sort()).toEqual(traceIds(naked));
    const records = new Map(readFileSync(join(naked, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.id, r]));
    for (const ep of eps) {
      expect(ep.verdict).toEqual(records.get(ep.item.id).verdict);
      expect(ep.trace).toEqual(readTrace(naked, ep.item.id));
      if (ep.item.meta?.kind === 'attack') expect(ep.item.meta.player).toBe(ep.item.meta.category);
    }
  });

  test('assignLanes maps episodes to lanes by tier and labels replayed lanes honestly', () => {
    const { lanes, byLane } = assignLanes(fakeLanes(), [...loadRun(naked), ...loadRun(prompted)]);
    expect(byLane.get('easy')!.length).toBe(8);   // naked
    expect(byLane.get('medium')!.length).toBe(3); // prompted
    expect(byLane.get('hard')!.length).toBe(0);
    expect(lanes.find((l) => l.id === 'easy')).toMatchObject({ tier: 'naked', model: 'fake (replay)' });
    expect(lanes.find((l) => l.id === 'hard')).toMatchObject({ tier: 'scoped', model: 'no replay data' });
  });

  test('every trace is streamed (queued -> each step -> verdict -> score) with zero adapter calls', async () => {
    const claudeCallsBefore = llm.claudeLimiter.calls;
    let factoryCalls = 0;
    const { lanes, byLane } = assignLanes(fakeLanes(), loadRun(naked));
    // A spy factory is present to prove replay never asks for a model.
    const arena = new Arena({ lanes, llmFactory: () => { factoryCalls++; throw new Error('replay must not build an LLM'); } });
    const events: Ev[] = [];
    arena.listen((e) => events.push(e as Ev));
    await arena.replay(byLane, { speed: 1000, loop: false });
    arena.stop();

    for (const id of traceIds(naked)) {
      const trace = readTrace(naked, id);
      const mine = forItem(events, id);
      expect(mine.map((e) => e.type)).toEqual(['queued', ...trace.steps.map(() => 'step'), 'verdict']);
      expect(mine.filter((e) => e.type === 'step').map((e) => e.step.call)).toEqual(trace.steps.map((s) => s.call));
      expect(mine.every((e) => e.laneId === 'easy')).toBe(true);
      const verdictAt = events.indexOf(mine.at(-1)!);
      expect(events[verdictAt + 1]?.type).toBe('score');
    }
    const records = readFileSync(join(naked, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const attacks = records.filter((r) => r.kind === 'attack');
    const last = events.filter((e) => e.type === 'score').at(-1)!;
    expect(last.lanes.find((l: Ev) => l.laneId === 'easy')).toEqual({ laneId: 'easy', attacks: attacks.length, breaches: attacks.filter((r) => r.breached).length });

    expect(factoryCalls).toBe(0);
    expect(makeLLMCalls).toBe(0);
    expect(llm.claudeLimiter.calls).toBe(claudeCallsBefore);
  });

  test('infra failures in a run replay as verdict errors and are not scored', async () => {
    const eps = loadRun(broken);
    expect(eps.map((e) => e.error)).toEqual(['usage limit reached', 'usage limit reached']);
    const { lanes, byLane } = assignLanes(fakeLanes(), eps);
    const arena = new Arena({ lanes });
    const events: Ev[] = [];
    arena.listen((e) => events.push(e as Ev));
    await arena.replay(byLane, { speed: 1000, loop: false });
    arena.stop();
    const verdicts = events.filter((e) => e.type === 'verdict');
    expect(verdicts.map((v) => v.error)).toEqual(['infra: usage limit reached', 'infra: usage limit reached']);
    const last = events.filter((e) => e.type === 'score').at(-1)!;
    expect(last.lanes.find((l: Ev) => l.laneId === 'hard')).toEqual({ laneId: 'hard', attacks: 0, breaches: 0 });
    expect(last.leaderboard).toEqual([]);
  });

  test('infraError: adapter failures and judge crashes are infra; step caps and malformed output are not', () => {
    const t = (error?: string) => ({ error, steps: [] });
    expect(infraError(t())).toBeUndefined();
    expect(infraError(t('stopped after 8 steps without done'))).toBeUndefined();
    expect(infraError(t('malformed reply after one repair retry: no JSON object found'))).toBeUndefined();
    expect(infraError(t('claude -p exited 1: rate limited'))).toBe('claude -p exited 1: rate limited');
    expect(infraError(t('judge failed: boom; malformed reply after one repair retry: x'))).toMatch(/^judge failed/);
  });

  test('CLI: serve --replay <run> --replay <run2> streams every trace of both runs; attacks get 403', async () => {
    const lanesFile = join(tmp, 'lanes.json');
    writeFileSync(lanesFile, JSON.stringify(fakeLanes()));
    const proc = Bun.spawn([process.execPath, 'scripts/serve.ts', '--lanes', lanesFile, '--replay', naked, '--replay', prompted, '--speed', '1000', '--port', '0'], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const reader = proc.stdout.getReader();
      let out = '';
      while (!/arena\s+(http:\/\/\S+)\/arena/.test(out)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`serve exited: ${out}${await new Response(proc.stderr).text()}`);
        out += new TextDecoder().decode(value);
      }
      const base = /arena\s+(http:\/\/\S+)\/arena/.exec(out)![1]!;
      expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/); // default host: IPv4 loopback
      const ws = await connect(base);
      try {
        const want = [...traceIds(naked).map((id) => `naked/${id}`), ...traceIds(prompted).map((id) => `prompted/${id}`)];
        for (const id of want) await ws.waitFor((e) => e.type === 'verdict' && e.inboundId === id, 10_000);
        expect(ws.events[0]!.type).toBe('lanes');
        expect(ws.events[0]!.lanes.map((l: Ev) => l.model)).toEqual(['fake (replay)', 'fake (replay)', 'no replay data']);
        const r = await post(base, { player: 'x', laneId: 'easy', channel: 'email', from: { name: 'x', address: 'x@y.z' }, body: 'hi' });
        expect(r.status).toBe(403);
      } finally {
        ws.close();
      }
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 30_000);
});
