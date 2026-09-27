/**
 * Arena server: the real defender per lane behind a queue, the phone portal, the projector stream.
 *
 *   bun run scripts/serve.ts [--lanes config/lanes.json] [--port 4173] [--host 127.0.0.1]
 *                            [--backend <b>] [--model <m>] [--max-steps <n>]
 *   bun run scripts/serve.ts --replay results/<run> [--replay results/<run2>] [--speed 1]
 *
 * Live: POST /api/attack queues an attack on its lane; each lane runs one episode at a time on a
 * fresh World and streams queued -> step... -> verdict -> score over WS /ws.
 * `--backend/--model/--max-steps` override every lane (e.g. `--backend fake` for offline UI work,
 * `--backend claude-cli --model haiku` for a cheap smoke run). Per-lane `maxSteps`/`deadlineSec`
 * live in the lanes file; an episode past its deadline is reported as an infra error, not scored.
 * Replay (demo insurance): replays saved eval traces on a loop; no LLM adapter is built and the
 * claude-cli call cap is set to 0, so it works without wifi or quota. Attacks are refused (403).
 * Binds to 127.0.0.1 by default (IPv4 loopback, what tunnels and `curl 127.0.0.1` reach); pass
 * `--host 0.0.0.0` to let phones on the LAN reach the portal.
 */
import { basename, join, resolve } from 'node:path';
import { claudeLimiter } from '../src/llm';
import { Arena } from '../src/server/arena';
import { startServer } from '../src/server/http';
import { LANE_DEFAULTS, loadLanes, overrideLanes } from '../src/server/lanes';
import { defaultLLMFactory } from '../src/server/llm';
import { assignLanes, loadRun, type ReplayEpisode } from '../src/server/replay';

const ROOT = join(import.meta.dir, '..');
const VALUE_FLAGS = ['lanes', 'port', 'host', 'backend', 'model', 'max-steps', 'replay', 'speed'];

function parseArgs(argv: string[]): { one: Record<string, string>; replay: string[] } {
  const one: Record<string, string> = {};
  const replay: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const key = a.startsWith('--') ? a.slice(2) : '';
    if (!VALUE_FLAGS.includes(key)) throw new Error(`unknown argument "${a}". Flags: ${VALUE_FLAGS.map((f) => `--${f}`).join(' ')}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`--${key} needs a value`);
    if (key === 'replay') replay.push(v); else one[key] = v;
  }
  return { one, replay };
}

const num = (v: string | undefined, name: string, fallback: number, allowZero = false) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !allowZero)) throw new Error(`--${name} must be a positive number`);
  return n;
};

const { one: args, replay } = parseArgs(process.argv.slice(2));
const lanesFile = resolve(args.lanes ?? join(ROOT, 'config/lanes.json'));
const maxSteps = args['max-steps'] === undefined ? undefined : num(args['max-steps'], 'max-steps', 8);
if (maxSteps !== undefined && !Number.isInteger(maxSteps)) throw new Error('--max-steps must be an integer');
let lanes = overrideLanes(loadLanes(lanesFile), { backend: args.backend, model: args.model, maxSteps });
const port = num(args.port ?? process.env.PORT, 'port', 4173, true); // 0 = any free port (printed below)
const host = args.host ?? '127.0.0.1';

let arena: Arena;
let replayPlan: Map<string, ReplayEpisode[]> | undefined;
if (replay.length) {
  claudeLimiter.maxCalls = 0; // belt and braces: replay can never bill the subscription
  const episodes = replay.flatMap((dir) => {
    const eps = loadRun(resolve(dir));
    // Several runs usually share item ids; keep ids unique across lanes.
    if (replay.length > 1) for (const ep of eps) ep.item.id = `${basename(resolve(dir))}/${ep.item.id}`;
    return eps;
  });
  if (!episodes.length) throw new Error(`no traces found in ${replay.join(', ')}`);
  const plan = assignLanes(lanes, episodes);
  lanes = plan.lanes;
  replayPlan = plan.byLane;
  arena = new Arena({ lanes });
} else {
  arena = new Arena({ lanes, llmFactory: defaultLLMFactory });
}

const app = startServer({ arena, port, host });
const shutdown = () => { app.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`arena  ${app.url}/arena\nportal ${app.url}/attack`);
for (const l of lanes) {
  const plan = replayPlan
    ? ` · replaying ${replayPlan.get(l.id)?.length ?? 0} episodes`
    : ` · ${l.backend} · ≤${l.maxSteps ?? LANE_DEFAULTS.maxSteps} steps · ${l.deadlineSec ?? LANE_DEFAULTS.deadlineSec}s deadline`;
  console.log(`lane ${l.id.padEnd(8)} ${l.label} · ${l.tier} · ${l.model}${plan}`);
}
if (replayPlan) {
  const speed = num(args.speed, 'speed', 1);
  console.log(`replay mode (speed ×${speed}): no LLM calls; POST /api/attack answers 403`);
  void arena.replay(replayPlan, { speed });
}
