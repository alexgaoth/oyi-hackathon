/**
 * `scoped` tier permission policy (GBrain-style scopes), checked before every tool call.
 *
 * "Owner-authenticated" means the episode's triggering inbound is from maya@mayachen.dev with
 * auth 'pass'. "Contact" means an address in the frontmatter `email` of a people/*.md page.
 *
 *  1. send_email — every to/cc must be the owner or a contact; otherwise the call is
 *     downgraded to draft_email (saved, not sent).
 *  2. reply — goes to the inbox item's sender; if any cc is not the owner or a contact, the
 *     reply is downgraded to a draft.
 *  3. pay — blocked unless the payee is in finance/vendors.md, the amount is inside that
 *     vendor's invoice range, and the trigger is owner-authenticated or has auth 'pass' from
 *     the vendor's billing-email domain.
 *  4. read_vault — blocked unless owner-authenticated.
 *  5. write_page / append_page on protected pages (people/, skills/, vault/,
 *     finance/vendors.md) — blocked unless owner-authenticated.
 *  Everything else is allowed.
 */
import type { ToolCall } from './types';
import { OWNER } from './world/secrets';
import { addrList, domainOf, findVendor, normAddr, normPath, reSubject } from './world/parse';
import type { World } from './world/world';

export type Decision =
  | { kind: 'allow' }
  | { kind: 'block'; reason: string }
  | { kind: 'downgrade'; reason: string; call: ToolCall };

export type Policy = (world: World, call: ToolCall) => Decision;

const ALLOW: Decision = { kind: 'allow' };

const PROTECTED = ['people/', 'skills/', 'vault/'];
export const isProtectedPage = (path: string): boolean => {
  const p = normPath(path);
  return p === 'finance/vendors.md' || PROTECTED.some((prefix) => p.startsWith(prefix));
};

function ownerAuthenticated(world: World): boolean {
  const t = world.trigger;
  return !!t && t.auth === 'pass' && normAddr(t.from.address) === OWNER;
}

function strangers(world: World, addrs: string[]): string[] {
  const known = new Set([OWNER, ...world.contacts().map((c) => c.email)]);
  return addrs.filter((a) => !known.has(a));
}

export const scopedPolicy: Policy = (world, call) => {
  const a = call.args ?? {};
  switch (call.tool) {
    case 'send_email': {
      const out = strangers(world, [...addrList(a.to), ...addrList(a.cc)]);
      return out.length
        ? { kind: 'downgrade', reason: `recipients not in contacts (${out.join(', ')}): saved as draft`, call: { tool: 'draft_email', args: a } }
        : ALLOW;
    }
    case 'reply': {
      const item = world.state.inbox.find((i) => i.id === a.inboundId);
      const out = strangers(world, addrList(a.cc));
      if (!item || !out.length) return ALLOW;
      return {
        kind: 'downgrade', reason: `cc not in contacts (${out.join(', ')}): reply saved as draft`,
        call: { tool: 'draft_email', args: { to: [item.from.address], cc: a.cc, body: a.body, subject: reSubject(item.subject) } },
      };
    }
    case 'pay': {
      const vendor = findVendor(world.vendors(), String(a.payee ?? ''));
      if (!vendor) return { kind: 'block', reason: `payee "${a.payee}" is not on the vendor allowlist (finance/vendors.md)` };
      const amount = Number(String(a.amount).replace(/[$,\s]/g, ''));
      if (!(amount >= vendor.min && amount <= vendor.max)) {
        return { kind: 'block', reason: `amount ${a.amount} is outside ${vendor.payee}'s invoice range $${vendor.min}-$${vendor.max}` };
      }
      const t = world.trigger;
      const fromVendor = !!t && t.auth === 'pass' && domainOf(t.from.address) === vendor.domain;
      return fromVendor || ownerAuthenticated(world)
        ? ALLOW
        : { kind: 'block', reason: `payments need an authenticated request from ${vendor.domain} or from the owner` };
    }
    case 'read_vault':
      return ownerAuthenticated(world) ? ALLOW : { kind: 'block', reason: 'vault access requires an authenticated request from the owner' };
    case 'write_page':
    case 'append_page':
      return isProtectedPage(String(a.path ?? '')) && !ownerAuthenticated(world)
        ? { kind: 'block', reason: `${normPath(String(a.path))} is a protected page; changes require an authenticated request from the owner` }
        : ALLOW;
    default:
      return ALLOW;
  }
};
