// The eval runner: filter the corpus, run runEpisode per item on a fresh world (bounded
// concurrency, resumable), write results.jsonl + traces + summary.json. Backend-agnostic; the
// fake backend uses the scripted policy in ./fake so any item completes deterministically.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runEpisode } from '../defender';
import { makeLLM, type LLM, type Backend } from '../llm';
import type { Inbound } from '../types';
import { World } from '../world/world';
import { loadCorpus, type CorpusItem } from './corpus';
import { fakeScript } from './fake';
import { buildSummary, classify, stableStringify, type RunConfig, type ResultRecord } from './summary';

export interface RunOptions {
  tier: string; backend: Backend; model: string; concurrency: number;
  only?: 'attacks' | 'tasks'; filter?: string; run?: string; resume?: boolean;
  resultsRoot: string;
  /** Test seam: override the per-item LLM (e.g. an adapter that throws). */
  llmFactory?: (item: Inbound) => LLM;
}

export function selectItems(opts: Pick<RunOptions, 'only' | 'filter'>): CorpusItem[] {
  const { attacks, tasks } = loadCorpus();
  let items = opts.only === 'attacks' ? attacks : opts.only === 'tasks' ? tasks : [...attacks, ...tasks];
  if (opts.filter) {
    const re = new RegExp(opts.filter);
    items = items.filter(({ item }) => re.test(item.id) || re.test(item.meta?.category ?? '') || re.test(item.meta?.goal ?? ''));
  }
  return items.sort((a, b) => a.item.id.localeCompare(b.item.id));
}

/** The LLM for one item: a fresh scripted fake for --backend fake, else one shared adapter. */
function llmFor(item: Inbound, opts: RunOptions, shared?: LLM): LLM {
  if (opts.backend === 'fake') return makeLLM({ backend: 'fake', script: fakeScript(item), model: opts.model });
  if (!shared) throw new Error(`backend ${opts.backend} requires a shared LLM`);
  return shared;
}

async function runPool<T>(items: T[], n: number, worker: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const next = async (): Promise<void> => {
    while (i < items.length) await worker(items[i++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length || 1)) }, next));
}

function toRecord(item: Inbound, opts: RunOptions, r: Awaited<ReturnType<typeof runEpisode>>): ResultRecord {
  const m = item.meta!;
  const status = classify(r.trace);
  return {
    id: item.id, itemId: (m.kind === 'attack' ? m.attackId : m.taskId) ?? item.id, kind: m.kind,
    category: m.kind === 'attack' ? (m.category ?? '?') : 'task',
    ...(m.goal !== undefined && { goal: m.goal }),
    tier: opts.tier, backend: opts.backend, model: opts.model,
    status,
    verdict: r.verdict, breached: r.verdict.breaches.length > 0,
    ...(m.kind === 'task' && { passed: r.verdict.utility?.passed ?? false }),
    tools: r.trace.steps.map((s) => s.call?.tool ?? '(none)'), steps: r.trace.steps.length,
    llmCalls: r.trace.llmCalls, ms: r.trace.ms,
    ...(r.trace.error !== undefined && { traceError: r.trace.error }),
    ...(status === 'error' && r.trace.error !== undefined && { error: r.trace.error }),
  };
}

export async function runEval(opts: RunOptions): Promise<{ dir: string; records: ResultRecord[] }> {
  const items = selectItems(opts);
  const name = opts.run ?? `${opts.tier}-${opts.backend}-${opts.model}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dir = join(opts.resultsRoot, name);
  const tracesDir = join(dir, 'traces');
  mkdirSync(tracesDir, { recursive: true });
  const resultsPath = join(dir, 'results.jsonl');

  // --resume keeps only successfully-classified items; items recorded as `error` are re-run.
  const done = new Set<string>();
  const records: ResultRecord[] = [];
  if (opts.resume && existsSync(resultsPath)) {
    for (const line of readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean)) {
      const rec = JSON.parse(line) as ResultRecord;
      if (rec.status === 'error') continue;   // drop; it will be re-run below
      done.add(rec.id);
      records.push(rec);
    }
    writeFileSync(resultsPath, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  } else {
    writeFileSync(resultsPath, '');          // fresh run: truncate any prior file
  }

  const shared = opts.backend === 'fake' || opts.llmFactory ? undefined
    : makeLLM({ backend: opts.backend, model: opts.model } as Parameters<typeof makeLLM>[0]);
  const todo = items.filter(({ item }) => !done.has(item.id));

  await runPool(todo, opts.concurrency, async ({ item }) => {
    const m = item.meta!;
    const base = {
      id: item.id, itemId: (m.kind === 'attack' ? m.attackId : m.taskId) ?? item.id, kind: m.kind,
      category: m.kind === 'attack' ? (m.category ?? '?') : 'task', ...(m.goal !== undefined && { goal: m.goal }),
      tier: opts.tier, backend: opts.backend, model: opts.model,
    };
    let rec: ResultRecord;
    try {
      const llm = opts.llmFactory ? opts.llmFactory(item) : llmFor(item, opts, shared);
      const r = await runEpisode(item, { tier: opts.tier, llm, world: World.fresh() });
      writeFileSync(join(tracesDir, `${item.id}.json`), JSON.stringify(r.trace, null, 2));
      rec = toRecord(item, opts, r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rec = {
        ...base, status: 'error',
        verdict: { breaches: [] }, breached: false, ...(m.kind === 'task' && { passed: false }),
        tools: [], steps: 0, llmCalls: 0, ms: 0, traceError: msg, error: msg,
      };
    }
    appendFileSync(resultsPath, JSON.stringify(rec) + '\n');
    records.push(rec);
  });

  // Rewrite results.jsonl sorted by id (deterministic file), then the summary.
  records.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(resultsPath, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  const config: RunConfig = {
    name, tier: opts.tier, backend: opts.backend, model: opts.model, concurrency: opts.concurrency,
    ...(opts.only !== undefined && { only: opts.only }), ...(opts.filter !== undefined && { filter: opts.filter }),
  };
  writeFileSync(join(dir, 'summary.json'), stableStringify(buildSummary(records, config)) + '\n');
  return { dir, records };
}
