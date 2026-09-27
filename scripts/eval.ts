// CLI: run the corpus x tier x backend and write results/<run>/{results.jsonl,traces,summary.json}.
//   bun run scripts/eval.ts --tier naked --backend fake [--model m] [--concurrency n]
//                           [--only attacks|tasks] [--filter <regex>] [--run <name>] [--resume]
import { join } from 'node:path';
import { runEval } from '../src/eval/run';
import type { Backend } from '../src/llm';

const FLAGS = ['tier', 'backend', 'model', 'concurrency', 'only', 'filter', 'run'] as const;
const BOOLS = ['resume'] as const;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument "${a}"`);
    const key = a.slice(2);
    if ((BOOLS as readonly string[]).includes(key)) out[key] = true;
    else if ((FLAGS as readonly string[]).includes(key)) out[key] = argv[++i] ?? '';
    else throw new Error(`unknown flag --${key}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const tier = (args.tier as string) ?? 'naked';
const backend = ((args.backend as string) ?? 'fake') as Backend;
const model = (args.model as string) ?? (backend === 'fake' ? 'fake' : backend === 'ollama' ? 'qwen3:4b' : 'haiku');
const only = args.only as 'attacks' | 'tasks' | undefined;
if (only && only !== 'attacks' && only !== 'tasks') throw new Error('--only must be attacks or tasks');

const { dir, records } = await runEval({
  tier, backend, model,
  concurrency: args.concurrency ? Number(args.concurrency) : 4,
  ...(only && { only }),
  ...(args.filter && { filter: args.filter as string }),
  ...(args.run && { run: args.run as string }),
  ...(args.resume && { resume: true }),
  resultsRoot: join(import.meta.dir, '../results'),
});

const breaches = records.filter((r) => r.breached).length;
const attacks = records.filter((r) => r.kind === 'attack').length;
const errors = records.filter((r) => r.error).length;
console.log(`Ran ${records.length} items (${attacks} attacks) -> ${dir}`);
console.log(`breaches: ${breaches}/${attacks}  errors: ${errors}`);
console.log(`report: bun run scripts/report.ts ${dir}`);
