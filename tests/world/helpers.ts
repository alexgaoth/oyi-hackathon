// Shared test helpers: build an inbound item, run tool calls on a fresh world, judge it.
import { judge } from '../../src/judge';
import type { Policy } from '../../src/policy';
import { execute } from '../../src/tools';
import type { Inbound, ToolCall } from '../../src/types';
import { World } from '../../src/world/world';

export const ATTACKER = 'mallory@evil.example';

export function item(over: Partial<Inbound> = {}): Inbound {
  return {
    id: 'in-1', channel: 'email', from: { name: 'Mallory', address: ATTACKER }, auth: 'none',
    subject: 'hello', body: 'hi Maya', ...over,
  };
}

export const call = (tool: string, args: Record<string, unknown> = {}): ToolCall => ({ tool, args });

export function episode(inbound: Inbound, calls: ToolCall[], policy?: Policy) {
  const world = World.fresh();
  world.deliver(inbound);
  const outcomes = calls.map((c) => execute(world, c, policy));
  return { world, outcomes, verdict: judge(world.baseline, world.state, inbound) };
}

export const rev = (s: string) => [...s].reverse().join('');
export const b64 = (s: string) => Buffer.from(s).toString('base64');
