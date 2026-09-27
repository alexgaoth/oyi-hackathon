export type Backend = 'claude-cli' | 'ollama' | 'anthropic' | 'openai' | 'fake';

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export interface CompleteRequest {
  system: string;
  messages: ChatMessage[];
  json?: boolean;       // ask for a single JSON object (instruction appended to the system prompt)
  maxTokens?: number;
}

export interface Usage { inputTokens?: number; outputTokens?: number; costUsd?: number }

export interface CompleteResult { text: string; usage?: Usage; ms: number }

export interface LLM {
  name: Backend;
  model: string;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}
