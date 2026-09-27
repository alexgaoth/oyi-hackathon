// Arena state: per-lane FIFO queues (one episode at a time per lane, lanes in parallel), the
// leaderboard, and a bounded history of ArenaEvents for clients that connect mid-game. Transport
// lives in ./http; this module only emits events to its listeners.
import { runEpisode } from '../defender';
import type { LLM } from '../llm';
import type { ArenaEvent, Inbound, Step, Trace, Verdict } from '../types';
import { World } from '../world/world';
import { LANE_DEFAULTS, lanePoints, type LaneConfig } from './lanes';
import type { LLMFactory } from './llm';
import { infraError, type ReplayEpisode } from './replay';

/**
 * The verdict event, with two additive optional fields (src/types.ts is unchanged):
 *  - `error`: 'infra: <message>' when the episode failed for infrastructure reasons (backend
 *    error or timeout, call cap/quota, the lane's deadlineSec, a judge crash). Such an episode is
 *    NOT scored (lane and player stats unchanged); `verdict` still holds what the judge saw on
 *    the partial episode. The UI should stamp ERROR, not DEFENDED/BREACHED, whenever it's set.
 *  - `note`: how a scored episode stopped short of `done` (step cap, malformed model output).
 *    These are defender outcomes and are scored normally.
 */
export type VerdictEvent = Extract<ArenaEvent, { type: 'verdict' }> & { error?: string; note?: string };
export type ServerEvent = ArenaEvent | VerdictEvent;
type ScoreEvent = Extract<ArenaEvent, { type: 'score' }>;

export interface ArenaOptions {
  lanes: LaneConfig[];
  /** Builds each live episode's LLM. Without one (replay mode) submit() refuses attacks; replay() never uses it. */
  llmFactory?: LLMFactory;
  historySize?: number;
  /** Queued + running attacks per player (across lanes). */
  maxPerPlayer?: number;
  /** Waiting items per lane (the running one not included). */
  maxLaneQueue?: number;
}

export type SubmitResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Every model call of one episode shares a wall-clock deadline. A call still pending when it
 * passes is abandoned (the episode ends) and later calls fail at once. `onFail` sees the first
 * backend failure or the deadline, which marks the episode as an infra error.
 */
function guarded(llm: LLM, deadlineSec: number, onFail: (why: string) => void): LLM {
  const end = Date.now() + deadlineSec * 1000;
  const late = `deadline of ${deadlineSec}s exceeded`;
  return {
    name: llm.name, model: llm.model,
    async complete(req) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const left = end - Date.now();
        if (left <= 0) throw new Error(late);
        return await Promise.race([
          llm.complete(req),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(late)), left); }),
        ]);
      } catch (e) {
        onFail(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Tool results can hold vault secrets and raw replies are noise: neither goes on the wire. */
export function publicStep(s: Step): Step {
  const { result: _result, raw: _raw, ...rest } = s;
  return rest;
}

class Scoreboard {
  private players = new Map<string, { breaches: number; points: number }>();
  private lanes: Map<string, { attacks: number; breaches: number }>;

  constructor(lanes: LaneConfig[]) {
    this.lanes = new Map(lanes.map((l) => [l.id, { attacks: 0, breaches: 0 }]));
  }

  /** Attacks count toward their lane and player; benign tasks don't score. */
  record(lane: LaneConfig, item: Inbound, verdict: Verdict, player: string | undefined): void {
    if (item.meta?.kind !== 'attack') return;
    const breached = verdict.breaches.length > 0;
    const l = this.lanes.get(lane.id)!;
    l.attacks++;
    if (breached) l.breaches++;
    if (!player) return;
    const p = this.players.get(player) ?? { breaches: 0, points: 0 };
    if (breached) { p.breaches++; p.points += lanePoints(lane); }
    this.players.set(player, p);
  }

  event(): ScoreEvent {
    return {
      type: 'score',
      leaderboard: [...this.players].map(([player, s]) => ({ player, ...s }))
        .sort((a, b) => b.points - a.points || b.breaches - a.breaches || a.player.localeCompare(b.player)),
      lanes: [...this.lanes].map(([laneId, s]) => ({ laneId, ...s })),
    };
  }
}

interface LaneState { cfg: LaneConfig; queue: Inbound[]; running: boolean }

export class Arena {
  readonly lanes: LaneConfig[];
  private readonly opts: Required<Omit<ArenaOptions, 'llmFactory' | 'lanes'>>;
  private readonly llmFactory?: LLMFactory;
  private readonly state = new Map<string, LaneState>();
  private readonly board: Scoreboard;
  private readonly pending = new Map<string, number>();
  private readonly listeners = new Set<(ev: ServerEvent) => void>();
  private readonly timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  private history: ServerEvent[] = [];
  private seq = 0;
  private stopped = false;

  constructor(opts: ArenaOptions) {
    this.lanes = opts.lanes;
    this.llmFactory = opts.llmFactory;
    this.opts = {
      historySize: opts.historySize ?? 400,
      maxPerPlayer: opts.maxPerPlayer ?? 3,
      maxLaneQueue: opts.maxLaneQueue ?? 20,
    };
    for (const cfg of opts.lanes) this.state.set(cfg.id, { cfg, queue: [], running: false });
    this.board = new Scoreboard(opts.lanes);
  }

  // ── events ──────────────────────────────────────────────────
  listen(fn: (ev: ServerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  lanesEvent(): ArenaEvent {
    return { type: 'lanes', lanes: this.lanes.map(({ id, label, tier, model }) => ({ id, label, tier, model })) };
  }

  scoreEvent(): ScoreEvent {
    return this.board.event();
  }

  /** What a new connection receives: lanes, the current score, then recent history. */
  welcome(): ServerEvent[] {
    return [this.lanesEvent(), this.scoreEvent(), ...this.history];
  }

  private emit(ev: ServerEvent): void {
    if (this.stopped) return;
    if (ev.type !== 'score') {
      this.history.push(ev);
      if (this.history.length > this.opts.historySize) this.history.splice(0, this.history.length - this.opts.historySize);
    }
    for (const fn of this.listeners) {
      try { fn(ev); } catch (e) { console.error('[arena] listener failed:', e); }
    }
  }

  /** Emit the verdict and the score. Infra errors (`error`) are reported but never scored. */
  private finish(lane: LaneConfig, item: Inbound, verdict: Verdict, end: { error?: string; note?: string }): void {
    const player = item.meta?.player;
    const error = end.error === undefined ? undefined : `infra: ${end.error}`;
    this.emit({
      type: 'verdict', laneId: lane.id, inboundId: item.id, verdict,
      ...(player !== undefined && { player }), ...(error !== undefined && { error }), ...(end.note !== undefined && { note: end.note }),
    });
    // Score a clean episode, and also one that breached before an infra failure hit: the harmful
    // artifact (e.g. the leaked email) was really sent, so the breach counts even though a later
    // step timed out or errored.
    if (error === undefined || verdict.breaches.length > 0) this.board.record(lane, item, verdict, player);
    this.emit(this.scoreEvent());
  }

  // ── live ────────────────────────────────────────────────────
  nextAttackId(): string {
    return `atk-${++this.seq}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /** Queue an item on a lane (rate limits apply to attacks with a player). */
  submit(laneId: string, item: Inbound): SubmitResult {
    if (!this.llmFactory) return { ok: false, status: 403, error: 'This arena is replaying recorded runs; live attacks are off right now.' };
    const lane = this.state.get(laneId);
    if (!lane) return { ok: false, status: 400, error: `unknown lane "${laneId}"` };
    const key = item.meta?.player?.toLowerCase();
    if (key !== undefined && (this.pending.get(key) ?? 0) >= this.opts.maxPerPlayer) {
      return { ok: false, status: 429, error: `You already have ${this.opts.maxPerPlayer} attacks in flight. Wait for a verdict, then fire again.` };
    }
    if (lane.queue.length >= this.opts.maxLaneQueue) {
      return { ok: false, status: 429, error: `The ${lane.cfg.label} lane has ${lane.queue.length} attacks waiting. Try another lane or wait a minute.` };
    }
    if (key !== undefined) this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    lane.queue.push(item);
    this.emit({ type: 'queued', laneId, item });
    void this.drain(lane);
    return { ok: true };
  }

  private async drain(lane: LaneState): Promise<void> {
    if (lane.running) return;
    lane.running = true;
    try {
      while (lane.queue.length && !this.stopped) await this.runLive(lane.cfg, lane.queue.shift()!);
    } finally {
      lane.running = false;
    }
  }

  /** One episode on a fresh World. Never throws: failures become a verdict with `error`. */
  private async runLive(lane: LaneConfig, item: Inbound): Promise<void> {
    let lastStep: Step | undefined;
    const step = (s: Step) => {
      lastStep = s;
      this.emit({ type: 'step', laneId: lane.id, inboundId: item.id, step: publicStep(s) });
    };
    let verdict: Verdict = { breaches: [] };
    let trace: Trace | undefined;
    let failed: string | undefined; // first backend/deadline failure, or a throw from the factory/runner
    try {
      const llm = guarded(this.llmFactory!(lane, item), lane.deadlineSec ?? LANE_DEFAULTS.deadlineSec, (why) => { failed ??= why; });
      const r = await runEpisode(item, { tier: lane.tier, llm, maxSteps: lane.maxSteps ?? LANE_DEFAULTS.maxSteps, world: World.fresh(), onStep: step });
      verdict = r.verdict;
      trace = r.trace;
    } catch (e) {
      failed ??= e instanceof Error ? e.message : String(e);
    }
    try {
      const error = failed ?? (trace && infraError(trace));
      const note = error === undefined ? trace?.error : undefined;
      // Make the stop visible on the projector unless the defender already reported it as a step.
      if ((error ?? note) !== undefined && !lastStep?.error) {
        step({ i: (lastStep?.i ?? -1) + 1, error: error !== undefined ? `infra: ${error}` : note });
      }
      this.finish(lane, item, verdict, { error, note });
    } finally {
      const key = item.meta?.player?.toLowerCase();
      if (key !== undefined) {
        const n = (this.pending.get(key) ?? 1) - 1;
        if (n > 0) this.pending.set(key, n); else this.pending.delete(key);
      }
    }
  }

  // ── replay ──────────────────────────────────────────────────
  /**
   * Play saved episodes per lane (lanes in parallel): queued, each step, verdict, score. Pacing
   * follows each trace's recorded duration, divided by `speed`. Loops until stop() unless
   * `loop` is false. No LLM is involved.
   */
  async replay(byLane: Map<string, ReplayEpisode[]>, o: { speed?: number; loop?: boolean } = {}): Promise<void> {
    const speed = o.speed && o.speed > 0 ? o.speed : 1;
    const wait = (ms: number) => this.sleep(ms / speed);
    const playLane = async (lane: LaneConfig, eps: ReplayEpisode[], offset: number) => {
      await wait(offset);
      do {
        for (const ep of eps) {
          if (this.stopped) return;
          this.emit({ type: 'queued', laneId: lane.id, item: ep.item });
          await wait(700);
          const perStep = Math.min(3500, Math.max(700, ep.trace.ms / Math.max(1, ep.trace.steps.length)));
          for (const s of ep.trace.steps) {
            if (this.stopped) return;
            this.emit({ type: 'step', laneId: lane.id, inboundId: ep.item.id, step: publicStep(s) });
            await wait(perStep);
          }
          if (this.stopped) return;
          this.finish(lane, ep.item, ep.verdict, ep.error !== undefined ? { error: ep.error } : { note: ep.trace.error });
          await wait(2500);
        }
      } while (o.loop !== false && !this.stopped && eps.length);
    };
    await Promise.all(this.lanes.map((lane, i) => playLane(lane, byLane.get(lane.id) ?? [], i * 900)));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.timers.delete(t); resolve(); }, ms);
      this.timers.set(t, resolve);
    });
  }

  /** Stop emitting and end replay loops. Live episodes already running finish silently. */
  stop(): void {
    this.stopped = true;
    for (const [t, resolve] of this.timers) { clearTimeout(t); resolve(); }
    this.timers.clear();
    this.listeners.clear();
  }
}
