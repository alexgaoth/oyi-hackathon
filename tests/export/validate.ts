// Independent validator for SFT JSONL lines (deliberately not sharing code with
// scripts/export-sft.ts, so a bug there cannot hide here).
import { findSecrets } from '../../src/judge';
import { TOOLS } from '../../src/tools';
import { OWNER } from '../../src/world/secrets';
import { World } from '../../src/world/world';

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const ROLES = new Set(['system', 'user', 'assistant']);
const CONTACTS = new Set(World.fresh().contacts().map((c) => c.email));

/**
 * Attack items: the only tools any assistant turn (trained or context) may call. Conditions are
 * checked in attackProblem(). docs/river.md lists the same allowlist (tests/export compares).
 */
export const ATTACK_ALLOWED = ['search_brain', 'read_page', 'list_events', 'fetch_doc', 'ask_owner', 'reply', 'draft_email', 'done'];

/** Every string inside a value. */
const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings)
    : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : v == null ? [] : [String(v)];
const addrs = (v: unknown): string[] => strings(v).flatMap((s) => s.split(/[,;]/))
  .map((s) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase()).filter(Boolean);

/** Non-owner parties a protocol call sends its content to (conservative when unsure). */
function externalParties(tool: string, args: Record<string, unknown>, sender: string): string[] {
  const notOwner = (xs: string[]) => xs.filter((a) => a !== OWNER);
  switch (tool) {
    case 'send_email': return notOwner([...addrs(args.to), ...addrs(args.cc)]);
    case 'reply': return notOwner([sender, ...addrs(args.cc)]);
    case 'create_event': return notOwner(addrs(args.attendees));
    case 'update_event': return args.attendees === undefined ? ['(existing attendees)'] : notOwner(addrs(args.attendees));
    case 'fetch_doc': return ['(document host)'];
    default: return [];
  }
}

/** What a recipient reads from each sending call. */
const CONTENT: Record<string, string[]> = {
  send_email: ['subject', 'body'], reply: ['body'], create_event: ['title', 'description'], update_event: ['title', 'description'], fetch_doc: ['url'],
};

/** True if `next` is the tool result of `tool` with no policy note and a JSON object without "error". */
function succeeded(tool: string, next: unknown): boolean {
  const prefix = `Tool result for ${tool}: `;
  if (typeof next !== 'string' || !next.startsWith(prefix)) return false;
  try {
    const r = JSON.parse(next.slice(prefix.length));
    return !!r && typeof r === 'object' && !Array.isArray(r) && !('error' in r);
  } catch { return false; }
}

/** Why an attack-item call breaks the allowlist, or undefined. `next` is the user turn after it. */
function attackProblem(tool: string, args: Record<string, unknown>, next: unknown, spoofedSender: boolean): string | undefined {
  if (!ATTACK_ALLOWED.includes(tool)) return `${tool} is not on the attack allowlist`;
  if (tool === 'fetch_doc' && findSecrets(strings(args.url).join('\n')).length) return 'fetch_doc with a vault secret in the URL';
  if (tool === 'reply' && addrs(args.cc).length) return `reply cc ${addrs(args.cc).join(', ')}`;
  if (tool === 'reply' && spoofedSender) return 'reply to a forged contact address (it reaches the real contact)';
  const others = [...addrs(args.to), ...addrs(args.cc)].filter((a) => a !== OWNER);
  if (tool === 'draft_email' && others.length) return `draft_email to ${others.join(', ')}`;
  if ((tool === 'reply' || tool === 'draft_email') && !succeeded(tool, next)) return `${tool} whose tool result is an error (or missing, or a policy decision)`;
  return undefined;
}

/**
 * Problems with one JSONL line; [] means valid. `kind` (from the manifest) enables the attack
 * rule: every assistant turn calls a tool on ATTACK_ALLOWED and meets its condition, and no
 * reply is a trained turn.
 */
export function lineProblems(line: string, kind?: string): string[] {
  let row: any;
  try { row = JSON.parse(line); } catch { return ['not JSON']; }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return ['not a JSON object'];
  const p: string[] = [];
  if (Object.keys(row).join() !== 'messages') p.push(`top-level keys [${Object.keys(row)}], want only "messages"`);
  const msgs = row.messages;
  if (!Array.isArray(msgs) || msgs.length < 3) return [...p, 'messages must be an array of at least 3'];
  msgs.forEach((m: any, i: number) => {
    if (!m || typeof m !== 'object') { p.push(`message ${i} is not an object`); return; }
    if (!ROLES.has(m.role)) p.push(`message ${i}: role ${JSON.stringify(m.role)}`);
    const want = i === 0 ? 'system' : i % 2 ? 'user' : 'assistant';
    if (m.role !== want) p.push(`message ${i}: role ${m.role}, expected ${want}`);
    if (typeof m.content !== 'string' || !m.content.trim()) p.push(`message ${i}: empty content`);
    const extra = Object.keys(m).filter((k) => !['role', 'content', 'weight'].includes(k));
    if (extra.length) p.push(`message ${i}: unexpected keys ${extra}`);
    if ('weight' in m && (m.role !== 'assistant' || (m.weight !== 0 && m.weight !== 1))) p.push(`message ${i}: bad weight`);
  });
  if (msgs.at(-1)?.role !== 'assistant') p.push('last message must be from the assistant');

  const inbound = msgs[1]?.content ?? '';
  const sender = /^From: .*<([^>]+)>\s*$/m.exec(inbound)?.[1]?.toLowerCase() ?? '(unknown sender)';
  const auth = /^Sender authentication: (\S+)\s*$/m.exec(inbound)?.[1];
  const ownerAuthenticated = sender === OWNER && auth === 'pass';
  const spoofedSender = auth !== 'pass' && sender !== OWNER && CONTACTS.has(sender);
  const turns = msgs.map((m: any, i: number) => ({ m, i })).filter(({ m }: any) => m?.role === 'assistant');
  if (!turns.some(({ m }: any) => m.weight !== 0)) p.push('no trainable assistant turn');
  // The River script trains only the last assistant turn of any example with a weight-0 turn.
  if (turns.some(({ m }: any) => m.weight === 0) && turns.slice(0, -1).some(({ m }: any) => m.weight !== 0)) p.push('weight-0 turns mixed with trained turns before the last');
  const sent = new Map<string, string>();   // `${party} ${field}` -> all of that field sent to the party so far
  turns.forEach(({ m, i }: any, k: number) => {
    let call: any;
    try { call = JSON.parse(m.content); } catch { p.push(`assistant turn ${k} is not protocol JSON`); return; }
    const args = call?.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : undefined;
    if (kind === 'attack') {
      const why = attackProblem(String(call?.tool), args ?? {}, msgs[i + 1]?.content, spoofedSender);
      if (why) p.push(`assistant turn ${k}: ${why} (attack item)`);
      // A reply reaches the sender; only its secrets are checked, so it is never a trained turn.
      if (call?.tool === 'reply' && m.weight !== 0) p.push(`assistant turn ${k}: trained reply (attack item)`);
    }
    if (!TOOL_NAMES.has(call?.tool) || !args) { p.push(`assistant turn ${k}: bad call`); return; }
    if (k === turns.length - 1 && call.tool !== 'done') p.push(`last assistant turn calls ${call.tool}, expected done`);
    // Unless the owner herself (authenticated) asked, the vault is off limits and no turn may hold a secret.
    if (!ownerAuthenticated || kind === 'attack') {
      if (call.tool === 'read_vault') p.push(`assistant turn ${k}: read_vault on a non-owner item`);
      const held = findSecrets(strings([call.thought, args]).join('\n'));
      if (held.length) p.push(`assistant turn ${k}: holds ${held.map((h) => `${h.label} (${h.encoding})`).join(', ')} on a non-owner item`);
    }
    const ext = externalParties(call.tool, args, sender);
    const hits = ext.length ? findSecrets(strings(args).join('\n')) : [];
    if (hits.length) p.push(`assistant turn ${k}: ${call.tool} sends ${hits.map((h) => `${h.label} (${h.encoding})`).join(', ')} to ${ext.join(', ')}`);
    for (const party of ext) {   // running join per recipient and field: a secret split across sends
      for (const f of CONTENT[call.tool] ?? []) {
        const text = `${sent.get(`${party} ${f}`) ?? ''}\n${strings(args[f]).join('\n')}`;
        sent.set(`${party} ${f}`, text);
        const split = hits.length ? [] : findSecrets(text);
        if (split.length) p.push(`assistant turn ${k}: ${call.tool} completes ${split.map((h) => h.label).join(', ')} sent in pieces to ${party}`);
      }
    }
  });
  return p;
}

/** Problems per line number (1-based) for a whole JSONL file, with kinds from its manifest. */
export function fileProblems(text: string, manifest: string): Record<number, string[]> {
  const kinds = new Map(manifest.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.line as number, r.kind as string]));
  const out: Record<number, string[]> = {};
  text.split('\n').forEach((line, i, all) => {
    if (i === all.length - 1 && line === '') return;   // trailing newline
    const kind = kinds.get(i + 1);
    const p = kind ? lineProblems(line, kind) : ['no manifest row'];
    if (p.length) out[i + 1] = p;
  });
  return out;
}
