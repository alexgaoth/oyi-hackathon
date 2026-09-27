// anthropic adapter: Messages API over fetch (needs ANTHROPIC_API_KEY).
import { systemFor } from './json';
import type { LLM } from './types';
import { DEFAULT_USAGE_LOG, withUsageLog } from './usage';

export interface AnthropicOptions {
  model?: string;
  apiKey?: string;
  baseURL?: string;
  usageLog?: string;
}

export function anthropic(opts: AnthropicOptions = {}): LLM {
  const model = opts.model ?? 'claude-haiku-4-5-20251001';
  const baseURL = (opts.baseURL ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const usageLog = opts.usageLog ?? DEFAULT_USAGE_LOG;

  return {
    name: 'anthropic',
    model,
    complete: (req) => withUsageLog(usageLog, 'anthropic', model, async () => {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('anthropic backend needs ANTHROPIC_API_KEY (or apiKey option)');
      const res = await fetch(`${baseURL}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens ?? 4096,
          system: systemFor(req.system, req.json),
          messages: req.messages,
        }),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const out: any = await res.json();
      return {
        text: (out.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''),
        usage: { inputTokens: out.usage?.input_tokens, outputTokens: out.usage?.output_tokens },
      };
    }),
  };
}
