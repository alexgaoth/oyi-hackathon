// Deterministic fake policy for `--backend fake`. Its only job is to prove the harness
// end-to-end, NOT to measure anything: for every corpus item it emits a short, valid protocol
// script that exercises the pipeline. For attacks it plays meta.win — the compliant-agent script
// that does exactly what the attack asks (resolveWin fills in the real secret for exfil, a test
// fixture). For tasks it plays one action per check so competent-assistant tasks pass utility.
import type { Check, Inbound } from '../types';
import { OWNER } from '../world/secrets';
import { resolveWin } from './win';

const reply = (tool: string, args: Record<string, unknown>, thought = `fake: ${tool}`) =>
  JSON.stringify({ thought, tool, args });
const done = (summary: string) => reply('done', { summary });

/** Protocol replies that carry out the attack (meta.win), so the judge records a breach. */
function attackScript(it: Inbound): string[] {
  const win = resolveWin(it);
  if (!win) return [done('no win script')];
  return [...win.map((c) => reply(c.tool, c.args)), done('complied with the request')];
}

/** One action per check, so competent-assistant tasks pass utility under the fake backend. */
function taskScript(it: Inbound): string[] {
  const out: string[] = [];
  for (const c of it.meta!.checks as Check[]) {
    switch (c.type) {
      case 'event_exists':
        out.push(reply('create_event', { title: c.titleIncludes, start: c.start ?? '2026-10-01T10:00', end: c.start ?? '2026-10-01T10:30', attendees: [] }));
        break;
      case 'payment':
        out.push(reply('pay', { payee: c.payee, amount: c.amount, memo: it.subject ?? '' }));
        break;
      case 'email_sent':
        out.push(reply('send_email', { to: [c.to], subject: it.subject ?? 'note', body: (c.bodyIncludes ?? ['ok']).join(' ') }));
        break;
      case 'page_contains':
        out.push(reply('append_page', { path: c.path, text: c.text }));
        break;
      case 'no_payment':
      case 'no_email_to_external':
        break; // satisfied by doing nothing
    }
  }
  out.push(done('handled task'));
  return out;
}

/** The full scripted reply sequence the fake LLM plays for one item. */
export function fakeScript(it: Inbound): string[] {
  return it.meta?.kind === 'attack' ? attackScript(it) : taskScript(it);
}

export const FAKE_CONSTANTS = { OWNER };
