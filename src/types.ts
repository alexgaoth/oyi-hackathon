// Shared contracts — see PLAN.md "Shared contracts". Extend only additively.

export type Channel = 'email' | 'calendar' | 'doc';
export interface Party { name: string; address: string }
export interface Inbound {
  id: string; channel: Channel; from: Party;
  auth: 'pass' | 'fail' | 'none';          // DKIM-like sender authentication
  to?: string[]; cc?: string[]; subject?: string; body: string;
  start?: string; end?: string;            // calendar
  url?: string;                            // doc
  attachments?: { name: string; content: string }[];
  meta?: {
    kind: 'attack' | 'task';
    attackId?: string; taskId?: string; category?: string; player?: string;
    goal?: 'exfil' | 'wire' | 'poison' | 'relay';
    poisonMarker?: string; payloadMarker?: string;   // strings the judge looks for
    checks?: Check[];                                // utility checks for tasks
  };
}
export interface ToolCall { tool: string; args: Record<string, unknown> }
export interface Step {
  i: number; thought?: string; call?: ToolCall; result?: unknown;
  blocked?: string;                 // policy layer refused / downgraded the call
  raw?: string; error?: string;
}
export interface Trace {
  inboundId: string; tier: string; backend: string; model: string;
  steps: Step[]; ms: number; llmCalls: number; error?: string;
}
export type BreachType = 'exfil' | 'wire' | 'poison' | 'relay';
export interface Breach { type: BreachType; evidence: string }
export interface Verdict { breaches: Breach[]; utility?: { taskId: string; passed: boolean; reasons: string[] } }
export type Check =
  | { type: 'event_exists'; titleIncludes: string; start?: string }
  | { type: 'payment'; payee: string; amount: number }
  | { type: 'no_payment' }
  | { type: 'email_sent'; to: string; bodyIncludes?: string[] }
  | { type: 'page_contains'; path: string; text: string }
  | { type: 'no_email_to_external' };
export type ArenaEvent =
  | { type: 'lanes'; lanes: { id: string; label: string; tier: string; model: string }[] }
  | { type: 'queued'; laneId: string; item: Inbound }
  | { type: 'step'; laneId: string; inboundId: string; step: Step }
  | { type: 'verdict'; laneId: string; inboundId: string; verdict: Verdict; player?: string }
  | { type: 'score'; leaderboard: { player: string; breaches: number; points: number }[];
      lanes: { laneId: string; attacks: number; breaches: number }[] };
