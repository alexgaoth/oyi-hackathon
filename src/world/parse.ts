// Pure helpers over brain pages and addresses, shared by world, tools, policy and judge.
import { posix } from 'node:path';
import type { Contact, Vendor } from './types';

/** Lowercased bare address; accepts "Name <a@b.c>". */
export function normAddr(a: string): string {
  const m = /<([^>]+)>/.exec(a);
  return (m ? m[1]! : a).trim().toLowerCase();
}

export const domainOf = (addr: string): string => normAddr(addr).split('@')[1] ?? '';

/** A string or array (or comma/semicolon separated string) -> trimmed non-empty strings. */
export function asList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const items = Array.isArray(v) ? v : String(v).split(/[,;]/);
  return items.map((x) => String(x).trim()).filter(Boolean);
}

export const addrList = (v: unknown): string[] => asList(v).map(normAddr);

export const reSubject = (subject = ''): string => (/^re:/i.test(subject) ? subject : `Re: ${subject}`.trim());

/** Canonical page path: lowercase, no leading "/" or "./", ".md" suffix. */
export function normPath(p: string): string {
  let s = posix.normalize(p.trim().toLowerCase()).replace(/^(\.?\/)+/, '');
  if (!s.endsWith('.md')) s += '.md';
  return s;
}

/** Payee comparison key: lowercase alphanumerics, "&" read as "and", company suffixes (Inc, LLC, ...) dropped. */
export function payeeKey(name: string): string {
  return name.toLowerCase().replace(/&/g, ' and ').replace(/\b(inc|llc|llp|ltd|corp|co)\b\.?/g, '').replace(/[^a-z0-9]/g, '');
}

/** Minimal YAML-ish frontmatter: `key: value` lines; true/false become booleans. */
export function frontmatter(md: string): Record<string, string | boolean> {
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const out: Record<string, string | boolean> = {};
  for (const line of m ? m[1]!.split(/\r?\n/) : []) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    out[line.slice(0, i).trim()] = v === 'true' ? true : v === 'false' ? false : v;
  }
  return out;
}

/** Contacts = people/*.md pages whose frontmatter has an email. */
export function parseContacts(brain: Record<string, string>): Contact[] {
  const out: Contact[] = [];
  for (const [path, md] of Object.entries(brain)) {
    if (!path.startsWith('people/')) continue;
    const fm = frontmatter(md);
    if (typeof fm.email !== 'string' || !fm.email) continue;
    out.push({
      path, name: String(fm.name ?? path), email: normAddr(fm.email),
      relationship: String(fm.relationship ?? ''), trusted: fm.trusted === true,
    });
  }
  return out;
}

/** Cells of every markdown table row in finance/vendors.md (header and separator rows included). */
function vendorTable(brain: Record<string, string>): string[][] {
  return (brain['finance/vendors.md'] ?? '').split('\n')
    .map((line) => line.trim().split('|').slice(1, -1).map((c) => c.trim()))
    .filter((cells) => cells.length >= 2);
}

/**
 * Every row of the vendors table, however incomplete, as (payee, billing email, bank details).
 * Used for protected-fact comparison, so a partial or duplicate row for a payee still counts.
 */
export function vendorRows(brain: Record<string, string>): { payee: string; billingEmail: string; bank: string }[] {
  return vendorTable(brain).map((cells) => ({
    payee: cells[0]!, billingEmail: normAddr(cells[2] ?? ''), bank: (cells[3] ?? '').replace(/\s+/g, ' '),
  }));
}

/**
 * Vendor allowlist from the table in finance/vendors.md (complete rows only):
 * | Payee | Service | Billing email | Bank details | Invoice range (USD) |
 */
export function parseVendors(brain: Record<string, string>): Vendor[] {
  const out: Vendor[] = [];
  for (const cells of vendorTable(brain)) {
    if (cells.length < 5 || !cells[2]!.includes('@')) continue;       // header, separator
    const nums = (cells[4]!.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, '')));
    if (!nums.length) continue;
    const billingEmail = normAddr(cells[2]!);
    out.push({
      payee: cells[0]!, billingEmail, domain: domainOf(billingEmail), bank: cells[3]!.replace(/\s+/g, ' '),
      min: nums[0]!, max: nums[1] ?? nums[0]!,
    });
  }
  return out;
}

export function findVendor(vendors: Vendor[], payee: string): Vendor | undefined {
  const key = payeeKey(payee);
  return key ? vendors.find((v) => payeeKey(v.payee) === key) : undefined;
}
