import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLLM } from '../../src/llm';
import { JSON_INSTRUCTION } from '../../src/llm/json';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Captured = { url: string; init: RequestInit; body: any };
function mockFetch(status: number, reply: unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}
const logDir = mkdtempSync(join(tmpdir(), 'ctb-usage-'));
afterAll(() => rmSync(logDir, { recursive: true, force: true }));
let logN = 0;
const tmpLog = () => join(logDir, `usage-${logN++}.jsonl`);
const readLog = (p: string) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const REQ = {
  system: 'You are Maya\'s assistant.',
  messages: [
    { role: 'user' as const, content: 'hi' },
    { role: 'assistant' as const, content: 'hello' },
    { role: 'user' as const, content: 'status?' },
  ],
};

describe('anthropic adapter (mocked fetch)', () => {
  test('request shape and response parsing', async () => {
    const calls = mockFetch(200, {
      id: 'msg_1', type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }],
      usage: { input_tokens: 12, output_tokens: 5 },
    });
    const usageLog = tmpLog();
    const llm = makeLLM({ backend: 'anthropic', apiKey: 'sk-test', usageLog });
    expect(llm.model).toBe('claude-haiku-4-5-20251001');
    const res = await llm.complete({ ...REQ, json: true, maxTokens: 321 });

    expect(calls).toHaveLength(1);
    const { url, init, body } = calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-test');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['content-type']).toBe('application/json');
    expect(body).toEqual({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 321,
      system: `${REQ.system}\n\n${JSON_INSTRUCTION}`,
      messages: REQ.messages,
    });

    expect(res.text).toBe('{"ok":true}');
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(res.ms).toBeGreaterThanOrEqual(0);
    const [line] = readLog(usageLog);
    expect(line).toMatchObject({ backend: 'anthropic', model: 'claude-haiku-4-5-20251001', inputTokens: 12, outputTokens: 5, ok: true });
  });

  test('HTTP errors throw and are logged as not ok', async () => {
    mockFetch(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    const usageLog = tmpLog();
    const llm = makeLLM({ backend: 'anthropic', apiKey: 'bad', usageLog });
    await expect(llm.complete(REQ)).rejects.toThrow(/anthropic 401/);
    expect(readLog(usageLog)[0]).toMatchObject({ backend: 'anthropic', ok: false });
  });

  test('missing key fails before any request', async () => {
    const calls = mockFetch(200, {});
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(makeLLM({ backend: 'anthropic', usageLog: tmpLog() }).complete(REQ)).rejects.toThrow(/ANTHROPIC_API_KEY/);
      expect(calls).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});

describe('openai adapter (mocked fetch)', () => {
  test('request shape and response parsing against a custom base URL', async () => {
    const calls = mockFetch(200, {
      id: 'chatcmpl-1', object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'all good' } }],
      usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
    });
    const usageLog = tmpLog();
    const llm = makeLLM({
      backend: 'openai', model: 'qwen/qwen3-8b', baseURL: 'https://openrouter.ai/api/v1/', apiKey: 'or-test', usageLog,
    });
    const res = await llm.complete({ ...REQ, maxTokens: 64 });

    expect(calls).toHaveLength(1);
    const { url, init, body } = calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer or-test');
    expect(h['content-type']).toBe('application/json');
    expect(body).toEqual({
      model: 'qwen/qwen3-8b',
      messages: [{ role: 'system', content: REQ.system }, ...REQ.messages],
      max_tokens: 64,
    });

    expect(res.text).toBe('all good');
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 3 });
    expect(readLog(usageLog)[0]).toMatchObject({ backend: 'openai', model: 'qwen/qwen3-8b', inputTokens: 20, ok: true });
  });

  test('json flag appends the JSON instruction; no max_tokens when unset', async () => {
    const calls = mockFetch(200, { choices: [{ message: { role: 'assistant', content: '{"a":1}' } }] });
    const llm = makeLLM({ backend: 'openai', model: 'm', apiKey: 'k', usageLog: tmpLog() });
    const res = await llm.complete({ ...REQ, json: true });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.body.messages[0]).toEqual({ role: 'system', content: `${REQ.system}\n\n${JSON_INSTRUCTION}` });
    expect('max_tokens' in calls[0]!.body).toBe(false);
    expect(res.text).toBe('{"a":1}');
  });

  test('HTTP errors throw', async () => {
    mockFetch(500, { error: { message: 'boom' } });
    const llm = makeLLM({ backend: 'openai', model: 'm', apiKey: 'k', usageLog: tmpLog() });
    await expect(llm.complete(REQ)).rejects.toThrow(/openai 500/);
  });
});
