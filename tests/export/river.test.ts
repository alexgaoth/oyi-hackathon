import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLLM } from '../../src/llm';
import { JSON_INSTRUCTION } from '../../src/llm/json';
import { RIVER_DEFAULT_BASE_URL } from '../../src/llm/river';

const realFetch = globalThis.fetch;
const ENV = ['RIVER_API_KEY', 'RIVER_BASE_URL', 'RIVER_MODEL', 'OPENAI_API_KEY'] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeEach(() => { for (const k of ENV) delete process.env[k]; });
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
});

type Captured = { url: string; init: RequestInit; body: any };
function mockFetch(status: number, reply: unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}
const OK = {
  id: 'chatcmpl-river', object: 'chat.completion',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"tool":"done","args":{"summary":"ok"}}' } }],
  usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
};
const logDir = mkdtempSync(join(tmpdir(), 'ctb-river-'));
afterAll(() => rmSync(logDir, { recursive: true, force: true }));
let n = 0;
const tmpLog = () => join(logDir, `usage-${n++}.jsonl`);
const REQ = { system: "You are Maya's assistant.", messages: [{ role: 'user' as const, content: 'hi' }] };
const MODEL = 'Qwen/Qwen3.6-35B-A3B-FP8';

describe('river preset (openai adapter, mocked fetch)', () => {
  test('default base URL, Bearer RIVER_API_KEY, model passed through, usage logged', async () => {
    process.env.RIVER_API_KEY = 'rv_test';
    const calls = mockFetch(200, OK);
    const usageLog = tmpLog();
    const llm = makeLLM({ backend: 'river', model: MODEL, usageLog });
    expect(llm.model).toBe(MODEL);
    const res = await llm.complete({ ...REQ, json: true, maxTokens: 128 });

    expect(calls).toHaveLength(1);
    const { url, init, body } = calls[0]!;
    expect(url).toBe(`${RIVER_DEFAULT_BASE_URL}/chat/completions`);
    expect(url).toBe('https://api.river.ai/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer rv_test');
    expect(body).toEqual({
      model: MODEL,
      messages: [{ role: 'system', content: `${REQ.system}\n\n${JSON_INSTRUCTION}` }, ...REQ.messages],
      max_tokens: 128,
    });
    expect(res.text).toBe('{"tool":"done","args":{"summary":"ok"}}');
    expect(res.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    const line = JSON.parse(readFileSync(usageLog, 'utf8').trim());
    expect(line).toMatchObject({ backend: 'openai', model: MODEL, inputTokens: 42, outputTokens: 7, ok: true });
  });

  test('RIVER_BASE_URL (a deployment.base_url) and RIVER_MODEL (a deployment.model) come from the env', async () => {
    process.env.RIVER_API_KEY = 'rv_env';
    process.env.RIVER_BASE_URL = 'https://dep-123.deployments.river.example/v1/';
    process.env.RIVER_MODEL = 'dep-123';
    const calls = mockFetch(200, OK);
    const llm = makeLLM({ backend: 'river', usageLog: tmpLog() });
    expect(llm.model).toBe('dep-123');
    await llm.complete(REQ);
    expect(calls[0]!.url).toBe('https://dep-123.deployments.river.example/v1/chat/completions');
    expect(calls[0]!.body.model).toBe('dep-123');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer rv_env');
  });

  test('explicit options win over the env', async () => {
    process.env.RIVER_API_KEY = 'rv_env';
    process.env.RIVER_BASE_URL = 'https://env.example/v1';
    process.env.RIVER_MODEL = 'env-model';
    const calls = mockFetch(200, OK);
    await makeLLM({ backend: 'river', model: 'opt-model', baseURL: 'https://opt.example/v1', apiKey: 'rv_opt', usageLog: tmpLog() }).complete(REQ);
    expect(calls[0]!.url).toBe('https://opt.example/v1/chat/completions');
    expect(calls[0]!.body.model).toBe('opt-model');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer rv_opt');
  });

  test('missing RIVER_API_KEY fails before any request and never falls back to OPENAI_API_KEY', async () => {
    process.env.OPENAI_API_KEY = 'sk-openai-must-not-leak';
    const calls = mockFetch(200, OK);
    await expect(makeLLM({ backend: 'river', model: MODEL, usageLog: tmpLog() }).complete(REQ)).rejects.toThrow(/RIVER_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  test('missing model fails at construction', () => {
    expect(() => makeLLM({ backend: 'river' })).toThrow(/RIVER_MODEL/);
  });

  test('HTTP errors throw', async () => {
    process.env.RIVER_API_KEY = 'rv_test';
    mockFetch(401, { error: { message: 'invalid api key' } });
    await expect(makeLLM({ backend: 'river', model: MODEL, usageLog: tmpLog() }).complete(REQ)).rejects.toThrow(/401/);
  });

  test('the base URL constant cites the River docs pages it came from', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/llm/river.ts'), 'utf8').split('\n');
    const at = src.findIndex((l) => l.includes(`RIVER_DEFAULT_BASE_URL = '${RIVER_DEFAULT_BASE_URL}'`));
    expect(at).toBeGreaterThan(0);
    const comment = src.slice(Math.max(0, at - 20), at).join('\n');
    expect(comment).toContain('https://docs.river.ai/guides/deployments/');
    expect(comment).toContain('https://docs.river.ai/python-api/');
    expect(comment).toContain('NEEDS CONFIRMATION');
  });
});
