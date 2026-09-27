// Run the defender on one inbound item and judge it.
//   bun run scripts/run-one.ts --tier prompted --backend claude-cli --model haiku --item world/tasks/sample-reschedule-priya.json
// Prints a step log and the verdict; writes {item, trace, verdict} to results/run-one/<timestamp>-<id>.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runEpisode } from '../src/defender';
import { makeLLM, type LLMOptions } from '../src/llm';
import type { Inbound, Step } from '../src/types';

const { values } = parseArgs({
  options: {
    tier: { type: 'string', default: 'prompted' },
    backend: { type: 'string', default: 'claude-cli' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
    item: { type: 'string' },
    'max-steps': { type: 'string' },
  },
});
if (!values.item) {
  console.error('usage: bun run scripts/run-one.ts --item <inbound.json> [--tier prompted] [--backend claude-cli] [--model haiku] [--max-steps 8]');
  process.exit(2);
}

const item: Inbound = JSON.parse(readFileSync(values.item, 'utf8'));
const llm = makeLLM({ backend: values.backend, model: values.model, baseURL: values['base-url'] } as LLMOptions);
const clip = (s: string, n = 240) => (s.length > n ? `${s.slice(0, n)}…` : s);

function printStep(s: Step): void {
  if (s.call) console.log(`[${s.i}] ${s.call.tool} ${clip(JSON.stringify(s.call.args), 400)}`);
  else console.log(`[${s.i}] (no call)`);
  if (s.thought) console.log(`    thought: ${clip(s.thought)}`);
  if (s.blocked) console.log(`    BLOCKED: ${s.blocked}`);
  if (s.error) console.log(`    error: ${s.error}\n    raw: ${clip(JSON.stringify(s.raw ?? ''))}`);
  if (s.call) console.log(`    -> ${clip(JSON.stringify(s.result))}`);
}

console.log(`item ${item.id} (${item.meta?.kind ?? '?'}) | tier ${values.tier} | ${llm.name}/${llm.model}`);
const { trace, verdict } = await runEpisode(item, {
  tier: values.tier!, llm, onStep: printStep,
  ...(values['max-steps'] && { maxSteps: Number(values['max-steps']) }),
});

console.log(`\n${trace.steps.length} steps, ${trace.llmCalls} LLM calls, ${(trace.ms / 1000).toFixed(1)}s${trace.error ? ` | trace error: ${trace.error}` : ''}`);
console.log(`breaches: ${verdict.breaches.length ? verdict.breaches.map((b) => `${b.type} (${b.evidence})`).join('; ') : 'none'}`);
if (verdict.utility) {
  console.log(`utility ${verdict.utility.taskId}: passed: ${verdict.utility.passed}`);
  for (const r of verdict.utility.reasons) console.log(`  ${r}`);
}

const dir = join(import.meta.dir, '../results/run-one');
mkdirSync(dir, { recursive: true });
const out = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${item.id}.json`);
writeFileSync(out, `${JSON.stringify({ item, trace, verdict }, null, 2)}\n`);
console.log(`trace: ${out}`);
