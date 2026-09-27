// LIVE (bills the owner's subscription): one portal-submitted attack on a claude-cli haiku lane,
// driven by scripts/screenshot-live.ts — `serve.ts --backend claude-cli --model haiku --max-steps 4`,
// one POST /api/attack, arena screenshot mid-episode, verdict on the WS stream. One episode:
// at most 4 steps (+1 repair per malformed reply). Skipped when the claude CLI is missing or
// CTB_SKIP_LIVE=1.
import { describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers';

const PNG = join(ROOT, 'docs/screenshots/arena-live.png');
const skip = !Bun.which('claude') || process.env.CTB_SKIP_LIVE === '1';

describe('LIVE arena smoke (claude-cli haiku, one episode)', () => {
  test.skipIf(skip)('a portal attack reaches a verdict; arena screenshot taken mid-episode with no console errors', async () => {
    const t0 = Date.now();
    const proc = Bun.spawn([process.execPath, 'scripts/screenshot-live.ts', '--backend', 'claude-cli', '--model', 'haiku', '--max-steps', '4'], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const line = out.split('\n').find((l) => l.startsWith('RESULT '));
    if (code !== 0 || !line) console.error(out, err);
    expect(line).toBeDefined();
    console.log(line); // evidence: event sequence, tools called, verdict
    const r = JSON.parse(line!.slice('RESULT '.length));
    expect(r.problems).toEqual([]);
    expect(code).toBe(0);
    expect(r).toMatchObject({ model: 'haiku', midRun: true, error: null });
    expect(r.types[0]).toBe('queued');
    expect(r.types.at(-1)).toBe('verdict');
    expect(r.types.filter((t: string) => t === 'step').length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(r.verdict.breaches)).toBe(true);
    expect(r.laneScore).toMatchObject({ laneId: r.laneId, attacks: 1 });
    const png = statSync(PNG);
    expect(png.mtimeMs).toBeGreaterThanOrEqual(t0);
    expect(png.size).toBeGreaterThan(50_000);
  }, 360_000);
});
