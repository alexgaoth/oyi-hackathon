import { describe, expect, test } from 'bun:test';
import { makeLLM, parseJsonObject, stripThink } from '../../src/llm';

describe('fake backend', () => {
  test('replies from the script in order, records requests, throws when exhausted', async () => {
    const llm = makeLLM({ backend: 'fake', script: ['first', (req) => `echo:${req.messages.at(-1)!.content}`] });
    expect(llm.name).toBe('fake');
    const r1 = await llm.complete({ system: 's', messages: [{ role: 'user', content: 'a' }] });
    const r2 = await llm.complete({ system: 's', messages: [{ role: 'user', content: 'b' }], json: true });
    expect([r1.text, r2.text]).toEqual(['first', 'echo:b']);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]).toEqual({ system: 's', messages: [{ role: 'user', content: 'b' }], json: true });
    await expect(llm.complete({ system: 's', messages: [] })).rejects.toThrow(/exhausted/);
  });
});

describe('parseJsonObject', () => {
  test('finds the first balanced object amid prose and fences', () => {
    expect(parseJsonObject('Sure! ```json\n{"tool":"done","args":{"summary":"ok"}}\n```')).toEqual({ tool: 'done', args: { summary: 'ok' } });
  });
  test('braces inside strings do not confuse it', () => {
    expect(parseJsonObject('{"thought":"use } and { freely","tool":"x"} trailing')).toEqual({ thought: 'use } and { freely', tool: 'x' });
  });
  test('skips an unparseable candidate and returns undefined when nothing parses', () => {
    expect(parseJsonObject('{not json} then {"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('no json here')).toBeUndefined();
    expect(parseJsonObject('[1,2]')).toBeUndefined();
  });
});

test('stripThink removes closed and dangling think blocks', () => {
  expect(stripThink('<think>hmm</think>\npong')).toBe('pong');
  expect(stripThink('pong<think>never closed')).toBe('pong');
});
