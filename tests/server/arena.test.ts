// Live arena over HTTP + WS with the `fake` backend: portal attack -> queued -> steps -> verdict
// -> score, history for late joiners, validation, rate limits, episode failures, static files.
import { afterEach, describe, expect, test } from 'bun:test';
import type { CompleteRequest, LLM } from '../../src/llm';
import { defaultLLMFactory, type LLMFactory } from '../../src/server/llm';
import { attackBody, connect, type Ev, fakeLanes, forItem, post, serve } from './helpers';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function liveServer(extra: Partial<Parameters<typeof serve>[0]> = {}) {
  const s = serve({ lanes: fakeLanes(), llmFactory: defaultLLMFactory, ...extra });
  cleanup.push(() => s.stop());
  return s;
}

/** An LLM whose replies wait for `release()`; every reply is `done`. */
function gatedFactory() {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const factory: LLMFactory = (lane) => ({
    name: 'fake', model: lane.model,
    async complete(_req: CompleteRequest) {
      await gate;
      return { text: JSON.stringify({ thought: 'ok', tool: 'done', args: { summary: 'nothing to do' } }), ms: 0 };
    },
  } satisfies LLM);
  return { factory, release: () => open() };
}

describe('live arena, fake backend', () => {
  test('POST /api/attack streams queued -> >=1 step -> verdict, then an updated score', async () => {
    const s = liveServer();
    const ws = await connect(s.url);
    cleanup.push(() => ws.close());
    await ws.waitFor((e) => e.type === 'score');
    expect(ws.events.map((e) => e.type)).toEqual(['lanes', 'score']);
    expect(ws.events[0]!.lanes.map((l: Ev) => l.id)).toEqual(['easy', 'medium', 'hard']);
    expect(ws.events[1]!.leaderboard).toEqual([]);

    const { status, data } = await post(s.url, attackBody());
    expect(status).toBe(200);
    const id = data.inboundId as string;
    expect(id).toMatch(/^atk-/);

    const verdict = await ws.waitFor((e) => e.type === 'verdict' && e.inboundId === id);
    const score = await ws.waitFor((e) => e.type === 'score' && ws.events.indexOf(e) > ws.events.indexOf(verdict));

    const mine = forItem(ws.events, id);
    const types = mine.map((e) => e.type);
    expect(types[0]).toBe('queued');
    expect(types.at(-1)).toBe('verdict');
    expect(types.filter((t) => t === 'step').length).toBeGreaterThanOrEqual(1);
    expect(types.slice(1, -1).every((t) => t === 'step')).toBe(true);

    const queued = mine[0]!;
    expect(queued.laneId).toBe('medium');
    expect(queued.item).toMatchObject({ channel: 'email', auth: 'pass', from: { address: 'mallory@evil.example' }, meta: { kind: 'attack', player: 'zerocool', attackId: id } });
    for (const e of mine.filter((x) => x.type === 'step')) {
      expect(e.laneId).toBe('medium');
      expect(e.step).not.toHaveProperty('result'); // tool results (vault reads!) never go on the wire
      expect(e.step).not.toHaveProperty('raw');
    }
    // the fake portal defender leaks the flag in a reply to the sender: a real judge verdict
    expect(verdict.player).toBe('zerocool');
    expect(verdict.verdict.breaches.map((b: Ev) => b.type)).toEqual(['exfil']);
    expect(score.leaderboard).toEqual([{ player: 'zerocool', breaches: 1, points: 250 }]);
    expect(score.lanes).toEqual([
      { laneId: 'easy', attacks: 0, breaches: 0 },
      { laneId: 'medium', attacks: 1, breaches: 1 },
      { laneId: 'hard', attacks: 0, breaches: 0 },
    ]);
  });

  test('a late joiner gets lanes, the current score, then the history in order', async () => {
    const s = liveServer();
    const first = await connect(s.url);
    cleanup.push(() => first.close());
    const { data } = await post(s.url, attackBody({ laneId: 'hard', channel: 'calendar' }));
    await first.waitFor((e) => e.type === 'score' && e.lanes.some((l: Ev) => l.attacks === 1));

    const late = await connect(s.url);
    cleanup.push(() => late.close());
    await late.waitFor((e) => e.type === 'verdict');
    const types = late.events.map((e) => e.type);
    expect(types.slice(0, 2)).toEqual(['lanes', 'score']);
    expect(late.events[1]!.leaderboard[0]).toMatchObject({ player: 'zerocool' });
    expect(types.slice(2)).toEqual(forItem(first.events, data.inboundId).map((e) => e.type));
    expect(types.includes('score', 2)).toBe(false); // score is sent once, up front
  });

  test('invalid submissions are rejected with 400 and a message', async () => {
    const s = liveServer();
    const cases: [string, unknown][] = [
      ['invalid JSON', '{nope'],
      ['not an object', [1, 2]],
      ['missing handle', attackBody({ player: '' })],
      ['handle too long', attackBody({ player: 'x'.repeat(25) })],
      ['handle with spaces', attackBody({ player: 'zero cool' })],
      ['unknown lane', attackBody({ laneId: 'nightmare' })],
      ['bad channel', attackBody({ channel: 'sms' })],
      ['bad address', attackBody({ from: { name: 'x', address: 'not-an-email' } })],
      ['address list smuggling', attackBody({ from: { name: 'x', address: 'a@b.co,c@d.co' } })],
      ['trailing-dot address', attackBody({ from: { name: 'x', address: 'maya@mayachen.dev.' } })],
      ['zero-width in address', attackBody({ from: { name: 'x', address: 'maya@mayachen.dev\u200b' } })],
      ['homoglyph handle', attackBody({ player: 'zer\u043ecool' })],
      ['subject too long', attackBody({ subject: 's'.repeat(201) })],
      ['body too long', attackBody({ body: 'b'.repeat(4001) })],
      ['empty body', attackBody({ body: '   ' })],
      ['non-string body', attackBody({ body: { $gt: '' } })],
    ];
    for (const [why, body] of cases) {
      const r = await post(s.url, body);
      expect([why, r.status]).toEqual([why, 400]);
      expect(typeof r.data?.error).toBe('string');
    }
    expect((await post(s.url, attackBody({ subject: 's'.repeat(200), body: 'b'.repeat(4000), player: 'y'.repeat(24) }))).status).toBe(200);
    expect((await post(s.url, 'x'.repeat(70 * 1024))).status).toBe(413);
    expect((await fetch(`${s.url}/api/attack`)).status).toBe(405);
  });

  test('rate limits: <=3 attacks in flight per player, bounded lane queue -> 429', async () => {
    const { factory, release } = gatedFactory();
    const s = liveServer({ llmFactory: factory, maxLaneQueue: 4 });
    const ws = await connect(s.url);
    cleanup.push(() => ws.close());

    const ok = [];
    for (let i = 0; i < 3; i++) ok.push(await post(s.url, attackBody({ player: 'spammer' })));
    expect(ok.map((r) => r.status)).toEqual([200, 200, 200]);
    const fourth = await post(s.url, attackBody({ player: '@SPAMMER', laneId: 'easy' })); // same player, any lane, any case
    expect(fourth.status).toBe(429);
    expect(fourth.data.error).toMatch(/in flight/);

    // medium: 1 running + 2 waiting; two more players fill the waiting queue to 4
    expect((await post(s.url, attackBody({ player: 'p1' }))).status).toBe(200);
    expect((await post(s.url, attackBody({ player: 'p2' }))).status).toBe(200);
    const full = await post(s.url, attackBody({ player: 'p3' }));
    expect(full.status).toBe(429);
    expect(full.data.error).toMatch(/MEDIUM lane/);
    expect((await post(s.url, attackBody({ player: 'p3', laneId: 'hard' }))).status).toBe(200);

    release();
    await ws.waitFor((e) => e.type === 'score' && e.lanes.find((l: Ev) => l.laneId === 'medium').attacks === 5);
    expect((await post(s.url, attackBody({ player: 'spammer' }))).status).toBe(200); // slots freed after verdicts
  });

  test('without an LLM factory (replay mode) attacks are refused with 403', async () => {
    const s = serve({ lanes: fakeLanes() });
    cleanup.push(() => s.stop());
    const r = await post(s.url, attackBody());
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/replay/);
  });

  test('binds 127.0.0.1 by default (IPv4 loopback reachable)', async () => {
    const s = liveServer();
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`http://127.0.0.1:${s.server.port}/arena`)).status).toBe(200);
  });
});

describe('infra failures are reported, never scored', () => {
  const reply = (tool: string, args: Record<string, unknown> = {}) => JSON.stringify({ thought: tool, tool, args });
  const stats = (score: Ev, laneId = 'medium') => score.lanes.find((l: Ev) => l.laneId === laneId);

  test('factory throw, adapter throw (quota/timeout) -> verdict error "infra: ...", not counted; the lane keeps going', async () => {
    let n = 0;
    const flaky: LLMFactory = (lane, item) => {
      n++;
      if (n === 1) throw new Error('adapter exploded');
      if (n === 2) return { name: 'fake', model: 'x', complete: async () => { throw new Error('claude-cli call cap reached'); } };
      return defaultLLMFactory(lane, item);
    };
    const s = liveServer({ llmFactory: flaky });
    const ws = await connect(s.url);
    cleanup.push(() => ws.close());
    const ids: string[] = [];
    for (const player of ['a1', 'a2', 'a3']) ids.push((await post(s.url, attackBody({ player }))).data.inboundId);

    const v1 = await ws.waitFor((e) => e.type === 'verdict' && e.inboundId === ids[0]);
    const v2 = await ws.waitFor((e) => e.type === 'verdict' && e.inboundId === ids[1]);
    const v3 = await ws.waitFor((e) => e.type === 'verdict' && e.inboundId === ids[2]);
    expect(v1).toMatchObject({ verdict: { breaches: [] }, error: 'infra: adapter exploded', player: 'a1' });
    expect(v2).toMatchObject({ verdict: { breaches: [] }, error: 'infra: claude-cli call cap reached', player: 'a2' });
    expect(v3.error).toBeUndefined();
    expect(v3.verdict.breaches.length).toBe(1);
    // failures are visible as an error step, and never reach the scoreboard
    expect(forItem(ws.events, ids[0]!).filter((e) => e.type === 'step').map((e) => e.step.error)).toEqual(['infra: adapter exploded']);
    const scoreAfter = (v: Ev) => ws.waitFor((e) => e.type === 'score' && ws.events.indexOf(e) > ws.events.indexOf(v));
    const after2 = await scoreAfter(v2);
    expect(stats(after2)).toEqual({ laneId: 'medium', attacks: 0, breaches: 0 });
    expect(after2.leaderboard).toEqual([]);
    const after3 = await scoreAfter(v3);
    expect(stats(after3)).toEqual({ laneId: 'medium', attacks: 1, breaches: 1 });
    expect(after3.leaderboard.map((r: Ev) => r.player)).toEqual(['a3']);
  });

  test('a hanging backend is cut off at the lane deadline (infra error), then the next item runs', async () => {
    const lanes = fakeLanes().map((l) => ({ ...l, deadlineSec: 0.3 }));
    let n = 0;
    const factory: LLMFactory = (lane, item) => {
      if (++n > 1) return defaultLLMFactory(lane, item);
      let calls = 0;
      return { name: 'fake', model: 'x', complete: async () => (++calls === 1 ? { text: reply('search_brain', { query: 'x' }), ms: 0 } : new Promise(() => {})) };
    };
    const s = liveServer({ lanes, llmFactory: factory });
    const ws = await connect(s.url);
    cleanup.push(() => ws.close());
    const t0 = Date.now();
    const hung = (await post(s.url, attackBody({ player: 'h1' }))).data.inboundId;
    const next = (await post(s.url, attackBody({ player: 'h2' }))).data.inboundId;
    const v = await ws.waitFor((e) => e.type === 'verdict' && e.inboundId === hung, 3000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(v).toMatchObject({ error: 'infra: deadline of 0.3s exceeded', verdict: { breaches: [] } });
    expect(forItem(ws.events, hung).filter((e) => e.type === 'step').map((e) => e.step.call?.tool ?? e.step.error))
      .toEqual(['search_brain', 'infra: deadline of 0.3s exceeded']);
    const v2 = await ws.waitFor((e) => e.type === 'verdict' && e.inboundId === next, 3000);
    expect(v2.error).toBeUndefined();
    const last = await ws.waitFor((e) => e.type === 'score' && ws.events.indexOf(e) > ws.events.indexOf(v2));
    expect(stats(last)).toEqual({ laneId: 'medium', attacks: 1, breaches: 1 }); // only the second one counts
  });

  test('defender stops (per-lane maxSteps) are scored outcomes with a note, not infra errors', async () => {
    const lanes = fakeLanes().map((l) => ({ ...l, maxSteps: 2 }));
    const loops: LLMFactory = () => ({ name: 'fake', model: 'x', complete: async () => ({ text: reply('list_events'), ms: 0 }) });
    const s = liveServer({ lanes, llmFactory: loops });
    const ws = await connect(s.url);
    cleanup.push(() => ws.close());
    const id = (await post(s.url, attackBody())).data.inboundId;
    const v = await ws.waitFor((e) => e.type === 'verdict' && e.inboundId === id);
    expect(v.error).toBeUndefined();
    expect(v.note).toBe('stopped after 2 steps without done');
    expect(forItem(ws.events, id).filter((e) => e.type === 'step').length).toBe(3); // 2 calls + the visible stop
    const score = await ws.waitFor((e) => e.type === 'score' && ws.events.indexOf(e) > ws.events.indexOf(v));
    expect(stats(score)).toEqual({ laneId: 'medium', attacks: 1, breaches: 0 });
  });
});

describe('static files', () => {
  test('pages, assets, traversal and malformed escapes', async () => {
    const s = liveServer();
    const get = async (p: string) => fetch(s.url + p);
    for (const p of ['/', '/arena']) expect(await (await get(p)).text()).toContain('arena.js');
    expect(await (await get('/attack')).text()).toContain('attack.js');
    expect((await get('/arena.js')).status).toBe(200);
    expect((await get('/assets/icon.svg')).status).toBe(200);
    for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/PLAN.md', '/..%5c..%5cPLAN.md', '/assets', '/nope.js']) {
      expect([p, (await get(p)).status]).toEqual([p, 404]);
    }
    for (const p of ['/%E0%A4%A', '/%', '/a%00.js']) expect([p, (await get(p)).status]).toEqual([p, 400]);
    expect((await fetch(`${s.url}/arena`, { method: 'POST' })).status).toBe(405);
    expect((await get('/api/nope')).status).toBe(404);
  });
});
