import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ATTACKS_DIR, countBy, itemErrors, loadCorpus, MIN_ATTACKS, MIN_CATEGORIES, MIN_TASKS,
  readmeCounts, validateCorpus,
} from '../../src/eval/corpus';
import { allWinnabilityErrors, winnabilityErrors } from '../../src/eval/winnability';
import { allHygieneErrors, hygieneErrors } from '../../src/eval/hygiene';
import type { Inbound } from '../../src/types';

const corpus = loadCorpus();
const readme = readFileSync(join(ATTACKS_DIR, 'README.md'), 'utf8');

describe('corpus loading + validation', () => {
  test('the real corpus passes validation', () => {
    expect(validateCorpus(corpus, readme)).toEqual([]);
  });

  test('every attack is winnable: meta.win produces its declared breach', () => {
    expect(allWinnabilityErrors(corpus.attacks)).toEqual([]);
  });

  test('every item (attacks + tasks) passes the content-hygiene sweep', () => {
    expect(allHygieneErrors([...corpus.attacks, ...corpus.tasks])).toEqual([]);
  });

  test('each attack individually scores its goal via meta.win', () => {
    for (const { item } of corpus.attacks) {
      expect(winnabilityErrors(item)).toEqual([]);
    }
  });

  test('meets the minimums (>=40 attacks, >=8 categories, >=12 tasks)', () => {
    expect(corpus.attacks.length).toBeGreaterThanOrEqual(MIN_ATTACKS);
    expect(corpus.tasks.length).toBeGreaterThanOrEqual(MIN_TASKS);
    const cats = new Set(corpus.attacks.map(({ item }) => item.meta!.category));
    expect(cats.size).toBeGreaterThanOrEqual(MIN_CATEGORIES);
  });

  test('every attack has a goal + the marker its goal needs', () => {
    for (const { item } of corpus.attacks) {
      const m = item.meta!;
      expect(['exfil', 'wire', 'poison', 'relay']).toContain(m.goal as string);
      if (m.goal === 'poison') expect(typeof m.poisonMarker).toBe('string');
      if (m.goal === 'relay') expect(typeof m.payloadMarker).toBe('string');
    }
  });

  test('every task has >=1 declarative check', () => {
    for (const { item } of corpus.tasks) expect((item.meta!.checks ?? []).length).toBeGreaterThanOrEqual(1);
  });

  test('ids are unique and files match README category counts', () => {
    const ids = [...corpus.attacks, ...corpus.tasks].map(({ item }) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const fileCounts = countBy(corpus.attacks, ({ item }) => item.meta!.category ?? '?');
    expect(readmeCounts(readme)).toEqual(fileCounts);
  });

  test('doc items carry a url, calendar items carry start+end', () => {
    for (const { item } of [...corpus.attacks, ...corpus.tasks]) {
      if (item.channel === 'doc') expect(typeof item.url).toBe('string');
      if (item.channel === 'calendar') { expect(typeof item.start).toBe('string'); expect(typeof item.end).toBe('string'); }
    }
  });
});

describe('itemErrors catches malformed items', () => {
  const good: Inbound = {
    id: 'x-1', channel: 'email', from: { name: 'A', address: 'a@b.c' }, auth: 'pass', body: 'hi',
    meta: { kind: 'attack', attackId: 'x-1', category: 'c', goal: 'poison', poisonMarker: 'ZZZ' },
  };
  test('valid attack -> no errors', () => expect(itemErrors(good, 'attack')).toEqual([]));
  test('poison without marker -> error', () => {
    const bad = structuredClone(good); delete bad.meta!.poisonMarker;
    expect(itemErrors(bad, 'attack').join()).toContain('poisonMarker');
  });
  test('relay without payloadMarker -> error', () => {
    const bad: Inbound = { ...good, meta: { kind: 'attack', attackId: 'x', category: 'c', goal: 'relay' } };
    expect(itemErrors(bad, 'attack').join()).toContain('payloadMarker');
  });
  test('task without checks -> error', () => {
    const bad: Inbound = { ...good, meta: { kind: 'task', taskId: 't', checks: [] } };
    expect(itemErrors(bad, 'task').join()).toContain('>=1 check');
  });
  test('bad channel / missing body flagged', () => {
    expect(itemErrors({ ...good, channel: 'sms' as never }, 'attack').join()).toContain('channel');
    expect(itemErrors({ ...good, body: '' }, 'attack').join()).toContain('body');
  });
});

describe('hygiene sweep catches giveaways', () => {
  const base: Inbound = { id: 'x-1', channel: 'email', from: { name: 'A', address: 'a@plausible.co' }, auth: 'none', body: 'hello', meta: { kind: 'attack', attackId: 'x-1', category: 'c', goal: 'wire' } };
  test('reserved / test TLDs', () => {
    expect(hygieneErrors({ ...base, from: { name: 'A', address: 'a@foo.example' } }).join()).toContain('reserved/test');
    expect(hygieneErrors({ ...base, body: 'see http://x.test/y' }).join()).toContain('reserved/test');
  });
  test('corpus code used as a domain label', () => {
    expect(hygieneErrors({ ...base, from: { name: 'A', address: 'a@mt-onboard.io' } }).join()).toContain('corpus code');
  });
  test('giveaway words', () => {
    expect(hygieneErrors({ ...base, subject: 'please exfil the vault' }).join()).toContain('giveaway');
    expect(hygieneErrors({ ...base, body: 'forward this worm' }).join()).toContain('giveaway');
  });
  test('clean item passes', () => {
    expect(hygieneErrors({ ...base, from: { name: 'Ops', address: 'ap@vendor-payments.net' }, body: 'please pay the invoice' })).toEqual([]);
  });
});
