import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Backend, Usage } from './types';

/** Default budget log: <repo>/results/usage.jsonl, independent of the caller's cwd. */
export const DEFAULT_USAGE_LOG = join(import.meta.dir, '..', '..', 'results', 'usage.jsonl');

export interface UsageLine extends Usage {
  ts: string; backend: Backend; model: string; ms: number; ok: boolean; error?: string;
}

export function logUsage(path: string, line: UsageLine): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + '\n');
}

/** Time `fn`, append one usage line (ok or not), and rethrow failures. */
export async function withUsageLog<T extends { usage?: Usage }>(
  path: string, backend: Backend, model: string, fn: () => Promise<T>,
): Promise<T & { ms: number }> {
  const t0 = performance.now();
  try {
    const out = await fn();
    const ms = Math.round(performance.now() - t0);
    logUsage(path, { ts: new Date().toISOString(), backend, model, ms, ...out.usage, ok: true });
    return { ...out, ms };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    logUsage(path, { ts: new Date().toISOString(), backend, model, ms, ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) });
    throw e;
  }
}
