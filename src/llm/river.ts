// River AI preset for the generic `openai` adapter: River serves trained (and base) models
// behind an OpenAI-compatible /chat/completions endpoint, authenticated with a River API key.
// Event-day steps: docs/river.md.
import { openai } from './openai';
import type { LLM } from './types';

/**
 * Default OpenAI-compatible base URL. NEEDS CONFIRMATION AT THE EVENT: River's docs never print a
 * fixed base URL. What they do say (read 2026-09-27):
 *  - https://docs.river.ai/guides/deployments/ — a deployment "exposes an OpenAI-compatible
 *    endpoint"; use `OpenAI(api_key=RIVER_API_KEY, base_url=deployment.base_url)` and
 *    `model=deployment.model`; "It already includes the OpenAI API prefix; pass it unchanged as
 *    base_url."
 *  - https://docs.river.ai/python-api/ — `Client(endpoint='api.river.ai')` ("API endpoint
 *    hostname"), and on `Deployment`: "model is the deployment identity (equal to id), also
 *    accepted by global /v1."
 * Hence host api.river.ai + the "global /v1" route. The route exists and wants Bearer auth: an
 * unauthenticated GET https://api.river.ai/v1/models returns 401 with an OpenAI-shaped error,
 * "Missing or invalid Authorization header. Expected: Bearer <api-key>" (checked 2026-09-27; the
 * item-11 critic saw the same on POST /v1/chat/completions). Whether it routes to trained
 * deployments is unconfirmed. The documented, dependable value is the per-deployment URL: set
 * RIVER_BASE_URL to `deployment.base_url`.
 */
export const RIVER_DEFAULT_BASE_URL = 'https://api.river.ai/v1';

export interface RiverOptions {
  model?: string;     // `deployment.model` or a base model id (e.g. Qwen/Qwen3.6-35B-A3B-FP8); else RIVER_MODEL
  baseURL?: string;   // else RIVER_BASE_URL, else RIVER_DEFAULT_BASE_URL
  apiKey?: string;    // else RIVER_API_KEY (sent as `Authorization: Bearer <key>`)
  usageLog?: string;
}

export function river(opts: RiverOptions = {}): LLM {
  const model = opts.model ?? process.env.RIVER_MODEL;
  if (!model) throw new Error('river backend needs a model (--model <deployment.model>, or RIVER_MODEL)');
  const apiKey = opts.apiKey ?? process.env.RIVER_API_KEY;
  const inner = openai({
    model,
    baseURL: opts.baseURL ?? process.env.RIVER_BASE_URL ?? RIVER_DEFAULT_BASE_URL,
    apiKey: apiKey ?? '',   // never undefined: the openai adapter would fall back to OPENAI_API_KEY
    usageLog: opts.usageLog,
  });
  return {
    ...inner,
    complete: (req) => {
      if (!apiKey) return Promise.reject(new Error('river backend needs RIVER_API_KEY (or the apiKey option)'));
      return inner.complete(req);
    },
  };
}
