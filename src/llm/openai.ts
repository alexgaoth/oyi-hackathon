// openai adapter: any OpenAI-compatible /chat/completions endpoint (OpenAI, OpenRouter, River, ...).
import { systemFor } from './json';
import type { LLM } from './types';
import { DEFAULT_USAGE_LOG, withUsageLog } from './usage';

export interface OpenAIOptions {
  model: string;      // provider-specific model id (no sensible cross-provider default)
  baseURL?: string;   // e.g. https://openrouter.ai/api/v1
  apiKey?: string;    // defaults to OPENAI_API_KEY
  usageLog?: string;
}

export function openai(opts: OpenAIOptions): LLM {
  const model = opts.model;
  const baseURL = (opts.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const usageLog = opts.usageLog ?? DEFAULT_USAGE_LOG;

  return {
    name: 'openai',
    model,
    complete: (req) => withUsageLog(usageLog, 'openai', model, async () => {
      const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('openai backend needs an apiKey (or OPENAI_API_KEY)');
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: systemFor(req.system, req.json) }, ...req.messages],
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        }),
      });
      if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const out: any = await res.json();
      return {
        text: out.choices?.[0]?.message?.content ?? '',
        usage: { inputTokens: out.usage?.prompt_tokens, outputTokens: out.usage?.completion_tokens },
      };
    }),
  };
}
