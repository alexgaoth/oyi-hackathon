// Lane config files: every config/lanes*.json loads, bad configs fail loudly, CLI overrides.
import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadLanes, overrideLanes, parseLanes } from '../../src/server/lanes';
import { ROOT } from './helpers';

describe('lanes config', () => {
  test('every config/lanes*.json is valid (retune freely: nothing pins the lane choices)', () => {
    const files = readdirSync(join(ROOT, 'config')).filter((f) => /^lanes.*\.json$/.test(f));
    expect(files).toContain('lanes.json');
    for (const f of files) expect(loadLanes(join(ROOT, 'config', f)).length).toBeGreaterThan(0);
  });

  test('bad configs are rejected with the offending lane named', () => {
    const lane = { id: 'a', label: 'A', tier: 'naked', backend: 'fake', model: 'fake' };
    expect(() => parseLanes([])).toThrow(/non-empty/);
    expect(() => parseLanes([{ ...lane, tier: 'titanium' }])).toThrow(/unknown tier/);
    expect(() => parseLanes([{ ...lane, backend: 'gpt' }])).toThrow(/\[0\].*backend/);
    expect(() => parseLanes([lane, lane])).toThrow(/duplicate lane id "a"/);
    expect(() => parseLanes([{ ...lane, model: '' }])).toThrow(/"model"/);
    expect(() => parseLanes([{ ...lane, points: -5 }])).toThrow(/points/);
    expect(() => parseLanes([{ ...lane, maxSteps: 0 }])).toThrow(/maxSteps/);
    expect(() => parseLanes([{ ...lane, maxSteps: 2.5 }])).toThrow(/maxSteps/);
    expect(() => parseLanes([{ ...lane, deadlineSec: 0 }])).toThrow(/deadlineSec/);
    expect(parseLanes([{ ...lane, maxSteps: 4, deadlineSec: 120 }])[0]).toMatchObject({ maxSteps: 4, deadlineSec: 120 });
  });

  test('--backend/--model override every lane, with a default model per backend', () => {
    const lanes = loadLanes(join(ROOT, 'config/lanes.json'));
    expect(overrideLanes(lanes, { backend: 'claude-cli' }).map((l) => [l.backend, l.model])).toEqual(lanes.map(() => ['claude-cli', 'haiku']));
    expect(overrideLanes(lanes, { backend: 'fake' }).every((l) => l.model === 'fake')).toBe(true);
    expect(overrideLanes(lanes, { model: 'm' }).map((l) => [l.backend, l.model])).toEqual(lanes.map((l) => [l.backend, 'm']));
    expect(overrideLanes(lanes, { maxSteps: 3 }).every((l) => l.maxSteps === 3)).toBe(true);
    expect(() => overrideLanes(lanes, { backend: 'openai' })).toThrow(/--model is required/);
    expect(() => overrideLanes(lanes, { backend: 'nope' })).toThrow(/--backend/);
  });
});
