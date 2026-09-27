// Memorable-style immunity: breaches become procedures the next defender applies.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dedupe, formatLessons, lessonFromBreach, lessonsBlock, writeLessons } from '../../src/defenses/lessons';
import type { Inbound, Verdict } from '../../src/types';

const attack = (over: Partial<Inbound> = {}): Inbound => ({
  id: 'mp-01', channel: 'email', from: { name: 'x', address: 'x@y.io' }, auth: 'fail', body: 'b',
  meta: { kind: 'attack', attackId: 'mp-01', category: 'memory-poisoning', goal: 'poison' }, ...over,
});
const verdict = (type: string): Verdict => ({ breaches: [{ type: type as any, evidence: 'e' }] });

const tmpFiles: string[] = [];
afterEach(() => { for (const f of tmpFiles.splice(0)) rmSync(f, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ctb-lessons-')); tmpFiles.push(d); return join(d, 'active.md'); };

describe('lessons', () => {
  test('a breach becomes a procedure that cites its attack (category/goal/channel/id)', () => {
    const l = lessonFromBreach(attack(), verdict('poison'));
    expect(l).toMatchObject({ attackId: 'mp-01', category: 'memory-poisoning', goal: 'poison', channel: 'email' });
    expect(l.rule.toLowerCase()).toContain('brain'); // the poison rule is about not writing false facts
  });

  test('the verdict breach type wins over meta.goal', () => {
    expect(lessonFromBreach(attack({ meta: { kind: 'attack', goal: 'exfil' } }), verdict('wire')).goal).toBe('wire');
  });

  test('dedupe keeps one procedure per (category, goal)', () => {
    const ls = [lessonFromBreach(attack(), verdict('poison')), lessonFromBreach(attack({ id: 'mp-02' }), verdict('poison'))];
    expect(dedupe(ls)).toHaveLength(1);
  });

  test('formatLessons + lessonsBlock round-trip; empty file yields no block', () => {
    const path = tmp();
    writeLessons([lessonFromBreach(attack(), verdict('poison'))], path);
    const block = lessonsBlock(path);
    expect(block).toContain('Procedural memory');
    expect(block).toContain('poison');
    writeFileSync(path, '');
    expect(lessonsBlock(path)).toBe('');
    expect(lessonsBlock(join(tmpdir(), 'does-not-exist-xyz.md'))).toBe('');
  });

  test('formatLessons of nothing is empty', () => {
    expect(formatLessons([])).toBe('');
  });
});
