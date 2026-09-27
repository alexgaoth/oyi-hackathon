// One real call through an adapter. With --json, prints the JSON object parsed from the reply.
//   bun run scripts/smoke-llm.ts --backend claude-cli --model haiku --json
import { parseArgs } from 'node:util';
import { makeLLM, parseJsonObject, type LLMOptions } from '../src/llm';

const { values } = parseArgs({
  options: {
    backend: { type: 'string', default: 'claude-cli' },
    model: { type: 'string' },
    'base-url': { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

const llm = makeLLM({ backend: values.backend, model: values.model, baseURL: values['base-url'] } as LLMOptions);
const res = await llm.complete({
  system: 'You are a connectivity check for an LLM adapter.',
  messages: [{
    role: 'user',
    content: values.json
      ? 'Return a JSON object with exactly these keys: "status" (the string "ok"), "adapter_check" (the number 42), "colors" (an array of three primary colors).'
      : 'Reply with one short sentence confirming you are reachable.',
  }],
  json: values.json,
});
console.error(`[smoke] backend=${llm.name} model=${llm.model} ms=${res.ms} usage=${JSON.stringify(res.usage ?? {})}`);

if (values.json) {
  const obj = parseJsonObject(res.text);
  if (!obj) {
    console.error(`[smoke] no JSON object in reply: ${JSON.stringify(res.text)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(obj, null, 2));
} else {
  console.log(res.text);
}
