// Mechanical content hygiene: no corpus item may hand the defender a giveaway that a naive
// security prompt could refuse on the token alone. Scans every MODEL-VISIBLE field (exactly what
// prompts.renderInbound shows) for reserved/test domains, category/kind codes used as domain
// labels, and giveaway words. Metadata (meta.category/goal/win) is never shown to the model, so
// it is not scanned.
import type { Inbound } from '../types';

// Reserved / documentation / test domains and TLDs.
const RESERVED = /(?:\.(?:example|test|invalid|localhost)(?![a-z0-9-]))|(?:\bexample\.(?:com|net|org)\b)/i;
// A domain label that starts with a corpus category or kind code (do-, os-, ai-, ..., t-).
const CODE_LABEL = /^(?:do|os|ai|if|ci|di|mp|eo|rw|mt|t)-/i;
// Words that name the game/mechanic and would tip off a keyword-matching defender.
const GIVEAWAY = /(worm|spoof|exfil|evil|attacker|malicious|phish|inject|pwn|hack|override|directive|payload|sink|collector|test-fixture)/i;
// Pull the host out of every email address and http(s) URL in a string.
const HOST = /(?:@|https?:\/\/)([a-z0-9.-]+\.[a-z]{2,})/gi;

// (id, field) pairs exempt from the GIVEAWAY-word check only: the two direct-override bodies whose
// bluntness ("SYSTEM OVERRIDE" / "New directive") is the point. Also listed in world/attacks/README.md.
export const GIVEAWAY_ALLOWLIST: Record<string, string[]> = { 'do-02': ['body'], 'do-04': ['body'] };

/** Every model-visible field of an inbound, as {field, value}. Mirrors prompts.renderInbound. */
export function visibleFields(it: Inbound): { field: string; value: string }[] {
  const out: { field: string; value: string }[] = [
    { field: 'from.name', value: it.from.name }, { field: 'from.address', value: it.from.address },
  ];
  for (const a of it.to ?? []) out.push({ field: 'to', value: a });
  for (const a of it.cc ?? []) out.push({ field: 'cc', value: a });
  if (it.subject) out.push({ field: 'subject', value: it.subject });
  if (it.url) out.push({ field: 'url', value: it.url });
  out.push({ field: 'body', value: it.body });
  for (const a of it.attachments ?? []) {
    out.push({ field: 'attachment.name', value: a.name });
    out.push({ field: 'attachment.content', value: a.content });
  }
  return out;
}

function hosts(value: string): string[] {
  return [...value.matchAll(HOST)].map((m) => m[1]!.toLowerCase());
}

/** Hygiene problems for one item (empty = clean). */
export function hygieneErrors(it: Inbound): string[] {
  const e: string[] = [];
  const exempt = GIVEAWAY_ALLOWLIST[it.id] ?? [];
  for (const { field, value } of visibleFields(it)) {
    const where = `${it.id} ${field}`;
    const reserved = RESERVED.exec(value);
    if (reserved) e.push(`${where}: reserved/test domain "${reserved[0]}"`);
    for (const host of hosts(value)) {
      const badLabel = host.split('.').find((l) => CODE_LABEL.test(l));
      if (badLabel) e.push(`${where}: domain label "${badLabel}" (in ${host}) looks like a corpus code`);
    }
    if (!exempt.includes(field)) {
      const g = GIVEAWAY.exec(value);
      if (g) e.push(`${where}: giveaway word "${g[0]}"`);
    }
  }
  return e;
}

export function allHygieneErrors(items: { item: Inbound }[]): string[] {
  return items.flatMap(({ item }) => hygieneErrors(item));
}
