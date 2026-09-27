import { anthropic, type AnthropicOptions } from './anthropic';
import { claudeCli, type ClaudeCliOptions } from './claude-cli';
import { fake, type FakeLLM, type ScriptEntry } from './fake';
import { ollama, type OllamaOptions } from './ollama';
import { openai, type OpenAIOptions } from './openai';
import { river, type RiverOptions } from './river';
import type { LLM } from './types';

export type * from './types';
export type { FakeLLM, ScriptEntry } from './fake';
export { claudeLimiter } from './claude-cli';
export { parseJsonObject, stripThink } from './json';

export type FakeOptions = { backend: 'fake'; script: ScriptEntry[]; model?: string };
export type LLMOptions =
  | ({ backend: 'claude-cli' } & ClaudeCliOptions)
  | ({ backend: 'ollama' } & OllamaOptions)
  | ({ backend: 'anthropic' } & AnthropicOptions)
  | ({ backend: 'openai' } & OpenAIOptions)
  | ({ backend: 'river' } & RiverOptions)   // openai adapter with the River preset (src/llm/river.ts)
  | FakeOptions;

export function makeLLM(opts: FakeOptions): FakeLLM;
export function makeLLM(opts: LLMOptions): LLM;
export function makeLLM(opts: LLMOptions): LLM {
  switch (opts.backend) {
    case 'claude-cli': return claudeCli(opts);
    case 'ollama': return ollama(opts);
    case 'anthropic': return anthropic(opts);
    case 'openai': return openai(opts);
    case 'river': return river(opts);
    case 'fake': return fake(opts);
    default: throw new Error(`unknown LLM backend: ${(opts as { backend: string }).backend}`);
  }
}
