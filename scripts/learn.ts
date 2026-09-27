// Memorable immunity experiment (sponsor defender layer S2). Split the attacks into train/test,
// run the base `prompted` defender on TRAIN, distil every breach into a procedure (Memorable-style),
// then run plain `prompted` and the `immune` tier (prompted + those procedures) on the held-out
// TEST split and print breach rates before vs after. Lessons are written to world/lessons/active.md,
// which the `immune` tier reads. With CTB_MEMORABLE=1 they are also recorded via memorable-cli.
//
//   bun run scripts/learn.ts --seed 7 --backend claude-cli --model haiku [--filter <regex>]
//   bun run scripts/learn.ts --seed 7 --backend fake            # pipeline dry-run (no LLM)
import { loadCorpus } from '../src/eval/corpus';
import { runEpisode } from '../src/defender';
import { makeLLM, type Backend } from '../src/llm';
import { lessonFromBreach, writeLessons, recordToMemorable, formatLessons, type Lesson } from '../src/defenses/lessons';
import { fakeScript } from '../src/eval/fake';

const FLAGS = ['seed', 'backend', 'model', 'filter', 'split'] as const;
const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith('--')) { const k = a.slice(2); if ((FLAGS as readonly string[]).includes(k)) args[k] = process.argv[++i] ?? ''; }
}
const seed = Number(args.seed ?? '7');
const backend = (args.backend ?? 'fake') as Backend;
const model = args.model ?? (backend === 'claude-cli' ? 'haiku' : backend === 'ollama' ? 'qwen3:4b' : 'fake');
const splitFrac = Number(args.split ?? '0.5');

// deterministic seeded shuffle (mulberry32)
function shuffle<T>(arr: T[], s: number): T[] {
  const a = [...arr];
  let t = s >>> 0;
  const rnd = () => { t += 0x6d2b79f5; let x = t; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}

function llmFor() {
  if (backend === 'fake') return makeLLM({ backend: 'fake', script: [] as never }); // replaced per-episode below
  return makeLLM({ backend, model } as never);
}

async function run(items: { item: any }[], tier: string): Promise<{ breached: { item: any; verdict: any }[]; n: number }> {
  const breached: { item: any; verdict: any }[] = [];
  for (const { item } of items) {
    // For the fake backend, use the corpus's built-in winnability replayer so a "compliant" agent
    // breaches — this proves the pipeline end to end without an LLM.
    const llm = backend === 'fake' ? makeLLM({ backend: 'fake', script: fakeScript(item), model: 'fake' }) : llmFor();
    const { verdict } = await runEpisode(item, { tier, llm });
    if (verdict.breaches.length) breached.push({ item, verdict });
  }
  return { breached, n: items.length };
}

const rate = (b: number, n: number) => `${b}/${n} = ${n ? Math.round((100 * b) / n) : 0}%`;

async function main() {
  let attacks = loadCorpus().attacks;
  if (args.filter) { const re = new RegExp(args.filter); attacks = attacks.filter(({ item }) => re.test(item.id) || re.test(item.meta?.category ?? '') || re.test(item.meta?.goal ?? '')); }
  const shuffled = shuffle(attacks, seed);
  const cut = Math.max(1, Math.floor(shuffled.length * splitFrac));
  const train = shuffled.slice(0, cut);
  const test = shuffled.slice(cut);
  console.log(`learn: ${attacks.length} attacks · seed ${seed} · ${backend}/${model} · train ${train.length} / test ${test.length}`);

  // 1) learn from breaches on TRAIN
  const trained = await run(train, 'prompted');
  const lessons: Lesson[] = trained.breached.map(({ item, verdict }) => lessonFromBreach(item, verdict));
  writeLessons(lessons);
  const mem = await recordToMemorable(lessons);
  console.log(`\ntrain: prompted breached ${rate(trained.breached.length, train.length)} → ${lessons.length} lesson(s) written to world/lessons/active.md`);
  console.log(`memorable: ${mem.note}`);
  if (lessons.length) console.log('\n' + formatLessons(lessons).trim() + '\n');

  // 2) measure on the held-out TEST split: prompted (before) vs immune (after)
  const before = await run(test, 'prompted');
  const after = await run(test, 'immune');
  console.log('held-out TEST split (lower is better):');
  console.log(`  before  (prompted): breached ${rate(before.breached.length, test.length)}`);
  console.log(`  after   (immune)  : breached ${rate(after.breached.length, test.length)}`);
  const delta = before.breached.length - after.breached.length;
  console.log(`  immunity effect: ${delta > 0 ? `-${delta} breach(es)` : delta < 0 ? `+${-delta} (worse)` : 'no change'}`);
}
main();
