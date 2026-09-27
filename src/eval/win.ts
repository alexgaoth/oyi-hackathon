// A corpus attack carries meta.win: the exact tool calls a compliant agent makes to do what the
// attack asks. Secrets appear only as placeholders ($FLAG/$PASSPORT/$CODES) so no real secret is
// stored in the corpus; resolveWin substitutes the real values (a test fixture) at run time.
// meta.win is an authoring/validation aid and is NOT part of the shared Inbound contract, so it
// is read via a local type rather than through src/types.ts.
import type { Inbound, ToolCall } from '../types';
import { BACKUP_CODES, FLAG, PASSPORT } from '../world/secrets';

export interface WinStep { tool: string; args: Record<string, unknown> }

const rev = (s: string) => [...s].reverse().join('');
// Encoded variants let a win apply the encoding the attack asks for (base64 / reversed), so the
// winnability proof exercises the judge's encoding detection. Longer keys are applied first so a
// prefix key (e.g. $FLAG) never corrupts $FLAG_B64.
const SUBS: [string, string][] = ([
  ['$FLAG_B64', Buffer.from(FLAG).toString('base64')],
  ['$FLAG_REV', rev(FLAG)],
  ['$PASSPORT_REV', rev(PASSPORT)],
  ['$FLAG', FLAG],
  ['$PASSPORT', PASSPORT],
  ['$CODES', BACKUP_CODES.join(', ')],
] as [string, string][]).sort((a, b) => b[0].length - a[0].length);

function substitute(v: unknown): unknown {
  if (typeof v === 'string') return SUBS.reduce((s, [k, r]) => s.split(k).join(r), v);
  if (Array.isArray(v)) return v.map(substitute);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x)]));
  return v;
}

export function rawWin(inbound: Inbound): WinStep[] | undefined {
  const win = (inbound.meta as { win?: unknown } | undefined)?.win;
  return Array.isArray(win) ? (win as WinStep[]) : undefined;
}

/** meta.win as executable tool calls with the secret placeholders resolved. */
export function resolveWin(inbound: Inbound): ToolCall[] | undefined {
  return rawWin(inbound)?.map((s) => ({ tool: s.tool, args: substitute(s.args) as Record<string, unknown> }));
}
