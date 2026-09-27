// fake adapter: scripted replies for tests. Records every request it receives.
import type { CompleteRequest, CompleteResult, LLM } from './types';

export type ScriptEntry = string | ((req: CompleteRequest) => string);

export interface FakeLLM extends LLM {
  requests: CompleteRequest[];
}

/** Replies with `script[0]`, `script[1]`, ... in order; throws once the script is exhausted. */
export function fake(opts: { script: ScriptEntry[]; model?: string }): FakeLLM {
  const requests: CompleteRequest[] = [];
  return {
    name: 'fake',
    model: opts.model ?? 'fake',
    requests,
    async complete(req): Promise<CompleteResult> {
      const entry = opts.script[requests.length];
      requests.push(structuredClone(req));
      if (entry === undefined) throw new Error(`fake LLM script exhausted after ${opts.script.length} replies`);
      return { text: typeof entry === 'function' ? entry(req) : entry, ms: 0 };
    },
  };
}
