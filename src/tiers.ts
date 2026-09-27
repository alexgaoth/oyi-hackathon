// Defense tiers (PLAN.md "Tiers / lanes"). A tier decides what the defender model is told
// (system prompt, how the inbound item is rendered), what it sees (optional pre-processing) and
// which permission policy guards its tool calls. New tiers: build on an existing one with
// deriveTier and add them to TIERS.
import type { LLM } from './llm';
import { scopedPolicy, type Policy } from './policy';
import { BASE_PROMPT, SCOPED_PROMPT, SECURITY_PROMPT } from './prompts';
import type { Inbound } from './types';
import type { World } from './world/world';

export interface TierContext { inbound: Inbound; world: World }

export interface Tier {
  id: string;
  label: string;
  /** The full system prompt for an episode. */
  system: (ctx: TierContext) => string;
  /** Checked before every tool call; refused/downgraded calls are recorded in Step.blocked. */
  policy?: Policy;
  /** Renders the inbound item as the first user turn (default: renderInbound). */
  wrapUntrusted?: (inbound: Inbound) => string;
  /**
   * Runs once before the loop and returns the item as the model should see it (e.g. a screener
   * quarantining content). The world and the judge always get the original item. `llm` calls
   * made here count toward Trace.llmCalls.
   */
  preprocess?: (inbound: Inbound, env: { llm: LLM; world: World }) => Inbound | Promise<Inbound>;
}

/** A tier that inherits everything from `base`, overrides what `over` sets, and appends `extraSystem` to the system prompt. */
export function deriveTier(base: Tier, over: Partial<Tier> & { id: string; label: string; extraSystem?: string }): Tier {
  const { extraSystem, ...rest } = over;
  const system = rest.system ?? base.system;
  return { ...base, ...rest, system: extraSystem ? (ctx) => `${system(ctx)}\n\n${extraSystem}` : system };
}

const naked: Tier = { id: 'naked', label: 'Naked', system: () => BASE_PROMPT };
const prompted = deriveTier(naked, { id: 'prompted', label: 'Security prompt', extraSystem: SECURITY_PROMPT });
const scoped = deriveTier(prompted, { id: 'scoped', label: 'Prompt + permissions', extraSystem: SCOPED_PROMPT, policy: scopedPolicy });

export const TIERS: Record<string, Tier> = { naked, prompted, scoped };

export function getTier(id: string): Tier {
  const tier = TIERS[id];
  if (!tier) throw new Error(`unknown tier "${id}". Tiers: ${Object.keys(TIERS).join(', ')}`);
  return tier;
}
