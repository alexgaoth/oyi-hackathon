import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeLLM } from '../../src/llm';

const MODEL = 'qwen3:4b';

/** `absent` (skip) only when `ollama list` works and MODEL is not in it; any other problem is an `error` (fail). */
function modelStatus(): { state: 'present' | 'absent' | 'error'; why?: string } {
  try {
    const p = Bun.spawnSync(['ollama', 'list']);
    if (p.exitCode !== 0) return { state: 'error', why: `\`ollama list\` exited ${p.exitCode}: ${p.stderr.toString().trim()}` };
    const names = p.stdout.toString().split('\n').slice(1).map((l) => l.split(/\s+/)[0]);
    return names.includes(MODEL) ? { state: 'present' } : { state: 'absent', why: `${MODEL} is not in \`ollama list\` (have: ${names.filter(Boolean).join(', ') || 'none'})` };
  } catch (e) {
    return { state: 'error', why: `ollama CLI not runnable: ${(e as Error).message}` };
  }
}

const status = modelStatus();
if (status.state === 'absent') console.log(`SKIP ollama live test: ${status.why}`);

test.skipIf(status.state === 'absent')(`ollama LIVE: ${MODEL} returns non-empty text without <think> blocks`, async () => {
  if (status.state === 'error') throw new Error(status.why);
  const dir = mkdtempSync(join(tmpdir(), 'ctb-usage-'));
  try {
    const llm = makeLLM({ backend: 'ollama', model: MODEL, usageLog: join(dir, 'u.jsonl') });
    const res = await llm.complete({
      system: 'You are a terse assistant.',
      messages: [{ role: 'user', content: 'Reply with exactly the word: pong' }],
    });
    console.log(`[ollama] reply: ${JSON.stringify(res.text)} usage=${JSON.stringify(res.usage)} ms=${res.ms}`);
    expect(res.text.trim().length).toBeGreaterThan(0);
    expect(res.text).not.toContain('<think>');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
