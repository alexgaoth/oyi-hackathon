// Corpus loading + schema validation for world/attacks/*.json and world/tasks/*.json.
// Each file holds one Inbound item. sample-*.json in world/tasks are owned by item 4 and skipped.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, Inbound } from '../types';

export const ROOT = join(import.meta.dir, '../..');
export const ATTACKS_DIR = join(ROOT, 'world/attacks');
export const TASKS_DIR = join(ROOT, 'world/tasks');

export const MIN_ATTACKS = 40;
export const MIN_CATEGORIES = 8;
export const MIN_TASKS = 12;

export interface CorpusItem { file: string; item: Inbound }

function jsonFiles(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((f) => f.endsWith('.json') && !f.startsWith('sample-')).sort();
}

export function loadDir(dir: string): CorpusItem[] {
  return jsonFiles(dir).map((f) => ({ file: join(dir, f), item: JSON.parse(readFileSync(join(dir, f), 'utf8')) as Inbound }));
}

export function loadCorpus(dirs = { attacks: ATTACKS_DIR, tasks: TASKS_DIR }) {
  return { attacks: loadDir(dirs.attacks), tasks: loadDir(dirs.tasks) };
}

const CHANNELS = ['email', 'calendar', 'doc'];
const AUTHS = ['pass', 'fail', 'none'];
const GOALS = ['exfil', 'wire', 'poison', 'relay'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function checkErrors(c: Check, where: string): string[] {
  const e: string[] = [];
  switch (c?.type) {
    case 'event_exists': if (!isStr(c.titleIncludes)) e.push(`${where}: event_exists needs titleIncludes`); break;
    case 'payment': if (!isStr(c.payee) || typeof c.amount !== 'number') e.push(`${where}: payment needs payee + numeric amount`); break;
    case 'email_sent': if (!isStr(c.to)) e.push(`${where}: email_sent needs to`); break;
    case 'page_contains': if (!isStr(c.path) || !isStr(c.text)) e.push(`${where}: page_contains needs path + text`); break;
    case 'no_payment': case 'no_email_to_external': break;
    default: e.push(`${where}: unknown check type ${JSON.stringify((c as { type?: unknown })?.type)}`);
  }
  return e;
}

/** Schema errors for one item (empty = valid). */
export function itemErrors(it: Inbound, expected: 'attack' | 'task'): string[] {
  const e: string[] = [];
  const w = it?.id ?? '(no id)';
  if (!isStr(it?.id)) e.push(`${w}: missing id`);
  if (!CHANNELS.includes(it?.channel)) e.push(`${w}: bad channel`);
  if (!isStr(it?.from?.name) || !isStr(it?.from?.address)) e.push(`${w}: from needs name + address`);
  if (!AUTHS.includes(it?.auth)) e.push(`${w}: bad auth`);
  if (!isStr(it?.body)) e.push(`${w}: empty body`);
  if (it?.channel === 'doc' && !isStr(it.url)) e.push(`${w}: doc item needs url`);
  if (it?.channel === 'calendar' && (!isStr(it.start) || !isStr(it.end))) e.push(`${w}: calendar item needs start + end`);
  const m = it?.meta;
  if (!m || m.kind !== expected) return [...e, `${w}: meta.kind must be "${expected}"`];
  if (expected === 'attack') {
    if (!isStr(m.attackId)) e.push(`${w}: missing meta.attackId`);
    if (!isStr(m.category)) e.push(`${w}: missing meta.category`);
    if (!GOALS.includes(m.goal as string)) e.push(`${w}: meta.goal must be one of ${GOALS.join('/')}`);
    if (m.goal === 'poison' && !isStr(m.poisonMarker)) e.push(`${w}: poison goal needs poisonMarker`);
    if (m.goal === 'relay' && !isStr(m.payloadMarker)) e.push(`${w}: relay goal needs payloadMarker`);
  } else {
    if (!isStr(m.taskId)) e.push(`${w}: missing meta.taskId`);
    if (!Array.isArray(m.checks) || !m.checks.length) e.push(`${w}: task needs >=1 check`);
    else m.checks.forEach((c, i) => e.push(...checkErrors(c, `${w} check[${i}]`)));
  }
  return e;
}

/** Category counts from the README table: rows like `| category | description | N |`. */
export function readmeCounts(md: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of md.split('\n')) {
    const cells = line.trim().split('|').slice(1, -1).map((c) => c.trim());
    const n = Number(cells[cells.length - 1]);
    if (cells.length >= 3 && /^`[^`]+`$/.test(cells[0]!) && Number.isInteger(n)) out[cells[0]!.slice(1, -1)] = n;
  }
  return out;
}

export function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

/** All corpus-level errors (empty = the corpus passes). */
export function validateCorpus(c: { attacks: CorpusItem[]; tasks: CorpusItem[] }, readme: string): string[] {
  const e: string[] = [];
  for (const { item } of c.attacks) e.push(...itemErrors(item, 'attack'));
  for (const { item } of c.tasks) e.push(...itemErrors(item, 'task'));
  const ids = [...c.attacks, ...c.tasks].map(({ item }) => item?.id);
  for (const [id, n] of Object.entries(countBy(ids, String))) if (n > 1) e.push(`duplicate id ${id}`);
  const cats = countBy(c.attacks, ({ item }) => item.meta?.category ?? '?');
  if (c.attacks.length < MIN_ATTACKS) e.push(`need >=${MIN_ATTACKS} attacks, have ${c.attacks.length}`);
  if (Object.keys(cats).length < MIN_CATEGORIES) e.push(`need >=${MIN_CATEGORIES} categories, have ${Object.keys(cats).length}`);
  if (c.tasks.length < MIN_TASKS) e.push(`need >=${MIN_TASKS} tasks, have ${c.tasks.length}`);
  const listed = readmeCounts(readme);
  for (const k of new Set([...Object.keys(cats), ...Object.keys(listed)])) {
    if (cats[k] !== listed[k]) e.push(`README count for ${k}: listed ${listed[k] ?? 0}, files ${cats[k] ?? 0}`);
  }
  return e;
}
