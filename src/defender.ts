// The defender: Maya's agent processing one inbound item with the JSON text tool protocol
// (PLAN.md "Tech"), over any LLM adapter. Each model reply is one Step; the loop stops at `done`,
// after maxSteps tool calls, after a malformed reply that one repair retry didn't fix, or at a
// malformed reply once the episode's MAX_REPAIRS are used up.
import { judge } from './judge';
import { parseJsonObject, stripThink, type ChatMessage, type LLM } from './llm';
import { renderInbound, repairPrompt, toolResultMessage } from './prompts';
import { getTier } from './tiers';
import { execute } from './tools';
import type { Inbound, Step, ToolCall, Trace, Verdict } from './types';
import { World } from './world/world';

export const DEFAULT_MAX_STEPS = 8;
/** Repair retries per episode, so LLM calls stay <= maxSteps + MAX_REPAIRS + 1. */
export const MAX_REPAIRS = 2;

export interface EpisodeOptions {
  tier: string; llm: LLM; maxSteps?: number; world?: World; onStep?: (s: Step) => void;
  /** Test seam: the judge to score the episode with (default: the real `judge`). */
  judgeFn?: typeof judge;
}
export interface EpisodeResult { trace: Trace; verdict: Verdict; world: World }

export type ParsedReply = { thought?: string; call: ToolCall } | { why: string };

/**
 * Read one protocol message: the first JSON object in the reply, `{"thought", "tool", "args"}`.
 * Lenient: `<think>` blocks are ignored and, if "args" is missing, the other keys are the args.
 */
export function parseReply(text: string): ParsedReply {
  const obj = parseJsonObject(stripThink(text));
  if (!obj) return { why: 'no JSON object found' };
  const { thought, tool, args, ...rest } = obj;
  if (typeof tool !== 'string' || !tool.trim()) return { why: 'missing "tool" name' };
  const a = args ?? rest;
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return { why: '"args" must be a JSON object' };
  return {
    ...(typeof thought === 'string' && { thought }),
    call: { tool: tool.trim(), args: a as Record<string, unknown> },
  };
}

export async function runEpisode(inbound: Inbound, opts: EpisodeOptions): Promise<EpisodeResult> {
  const t0 = Date.now();
  const tier = getTier(opts.tier);
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const world = opts.world ?? World.fresh();
  world.deliver(inbound);

  let llmCalls = 0;
  const llm: LLM = {
    name: opts.llm.name, model: opts.llm.model,
    complete: (req) => { llmCalls++; return opts.llm.complete(req); },
  };
  const trace: Trace = { inboundId: inbound.id, tier: tier.id, backend: llm.name, model: llm.model, steps: [], ms: 0, llmCalls: 0 };
  const record = (s: Omit<Step, 'i'>) => {
    const step: Step = { i: trace.steps.length, ...s };
    trace.steps.push(step);
    opts.onStep?.(step);
  };

  try {
    const seen = tier.preprocess ? await tier.preprocess(inbound, { llm, world }) : inbound;
    const system = tier.system({ inbound: seen, world });
    const messages: ChatMessage[] = [{ role: 'user', content: (tier.wrapUntrusted ?? renderInbound)(seen) }];
    const ask = async () => (await llm.complete({ system, messages, json: true })).text;
    let repairs = 0;

    for (let calls = 0; ; calls++) {
      if (calls >= maxSteps) {
        trace.error = `stopped after ${maxSteps} steps without done`;
        break;
      }
      let raw = await ask();
      let parsed = parseReply(raw);
      if ('why' in parsed) {
        record({ raw, error: `malformed reply: ${parsed.why}` });
        if (repairs >= MAX_REPAIRS) {
          trace.error = `malformed reply with no repairs left (${MAX_REPAIRS} per episode): ${parsed.why}`;
          break;
        }
        repairs++;
        messages.push({ role: 'assistant', content: raw }, { role: 'user', content: repairPrompt(parsed.why) });
        raw = await ask();
        parsed = parseReply(raw);
        if ('why' in parsed) {
          record({ raw, error: `malformed reply after repair: ${parsed.why}` });
          trace.error = `malformed reply after one repair retry: ${parsed.why}`;
          break;
        }
      }
      const { thought, call } = parsed;
      const { result, blocked } = execute(world, call, tier.policy);
      // Clone: some tool results reference live world objects that later calls mutate.
      record({ ...(thought !== undefined && { thought }), call, result: structuredClone(result), ...(blocked !== undefined && { blocked }), raw });
      if (call.tool === 'done') break;
      messages.push(
        { role: 'assistant', content: JSON.stringify({ thought, tool: call.tool, args: call.args }) },
        { role: 'user', content: toolResultMessage(call.tool, result, blocked) },
      );
    }
  } catch (e) {
    trace.error = e instanceof Error ? e.message : String(e);
  }

  trace.ms = Date.now() - t0;
  trace.llmCalls = llmCalls;
  let verdict: Verdict;
  try {
    verdict = (opts.judgeFn ?? judge)(world.baseline, world.state, inbound);
  } catch (e) {
    // Keep the paid-for trace; score nothing. The judge failure goes first so classify() in
    // src/eval/summary.ts counts the episode as an error, even after a max-steps/malformed stop.
    const msg = `judge failed: ${e instanceof Error ? e.message : String(e)}`;
    trace.error = trace.error === undefined ? msg : `${msg}; ${trace.error}`;
    verdict = { breaches: [] };
  }
  return { trace, verdict, world };
}
