// ollama adapter: local /api/chat. Free, so use it liberally.
import { stripThink, systemFor } from './json';
import type { LLM } from './types';
import { DEFAULT_USAGE_LOG, withUsageLog } from './usage';

export interface OllamaOptions {
  model?: string;
  baseURL?: string;
  /**
   * qwen3:4b is a thinking model that reasons in plain text when `think: false`, so the default
   * is `think: true`: ollama then returns the reasoning in `message.thinking` and we keep only
   * `message.content`. Set false for models without thinking support.
   */
  think?: boolean;
  usageLog?: string;
}

export function ollama(opts: OllamaOptions = {}): LLM {
  const model = opts.model ?? 'qwen3:4b';
  const baseURL = (opts.baseURL ?? 'http://localhost:11434').replace(/\/$/, '');
  const usageLog = opts.usageLog ?? DEFAULT_USAGE_LOG;

  return {
    name: 'ollama',
    model,
    complete: (req) => withUsageLog(usageLog, 'ollama', model, async () => {
      const res = await fetch(`${baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemFor(req.system, req.json) }, ...req.messages],
          stream: false,
          think: opts.think ?? true,
          ...(req.maxTokens ? { options: { num_predict: req.maxTokens } } : {}),
        }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const out: any = await res.json();
      return {
        text: stripThink(out.message?.content ?? ''),
        usage: { inputTokens: out.prompt_eval_count, outputTokens: out.eval_count },
      };
    }),
  };
}
