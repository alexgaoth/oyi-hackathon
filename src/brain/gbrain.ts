// GBrain-backed brain (CTB_BRAIN=gbrain). GBrain (github.com/garrytan/gbrain, MIT) is the search
// index; World.state.brain stays the record the judge diffs, so reads and writes hit the World and
// the index is re-synced to the current World before every search. That sync is what keeps
// episodes isolated: pages another episode wrote are re-put or deleted before this episode's
// search runs. Vault pages are never indexed.
//
// One private GBRAIN_HOME (PGLite, keyless, keyword search) per process, in a temp dir. The worker
// in gbrain-worker.ts owns the gbrain processes; calls block on Atomics.wait because tools are
// synchronous.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { World } from '../world/world';
import { title } from './markdown';
import { isVault, type BrainBackend, type SearchHit } from './types';

/** gbrain checkout (`bun install` done); override with CTB_GBRAIN_CLI. */
const GBRAIN_CLI = process.env.CTB_GBRAIN_CLI ?? join(process.env.HOME ?? '', '.local/share/gbrain/src/cli.ts');
/** The gbrain commit this adapter was tested against (docs/gbrain.md pins it). */
export const GBRAIN_COMMIT = 'e78f1c38b947b053f3a46881340f74f316be855a';
const CALL_TIMEOUT_MS = 120_000;             // the first call also waits for init + import (~15 s)

const SLUG_OK = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

/** gbrain's import treats these basenames as directory scaffolding and skips them (SYNC_SKIP_FILES). */
const METAFILE = /(^|\/)(index|readme|log|schema|resolver)$/;

/**
 * World page path -> gbrain slug. gbrain reserves skills/, skips metafiles on import and only
 * accepts slug-safe segments, so those paths get an opaque slug; results map back through `paths`.
 */
export function slugFor(path: string): string {
  const base = path.replace(/\.md$/, '');
  if (SLUG_OK.test(base) && !/^(skills|ctb)\//.test(base) && !METAFILE.test(base)) return base;
  return `ctb/${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;
}

/**
 * The whole environment of every gbrain process. Nothing is inherited: gbrain auto-detects model
 * API keys (OPENAI_API_KEY, ...) and would send page text to them, and it probes $HOME.
 */
export function gbrainEnv(home: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off' };
}

export class GbrainBrain implements BrainBackend {
  readonly name = 'gbrain';
  /** Pages the gbrain index holds: world path -> content. */
  private indexed = new Map<string, string>();
  /** Page versions deliberately not indexed (empty, or refused by gbrain): world path -> content. */
  private skipped = new Map<string, string>();
  private paths = new Map<string, string>();  // slug -> world path
  private ctrl = new Int32Array(new SharedArrayBuffer(12));
  private data = new Uint8Array(new SharedArrayBuffer(4 << 20));
  private worker: Worker;
  private seq = 0;
  private broken?: string;
  readonly home: string;

  constructor() {
    this.home = mkdtempSync(join(tmpdir(), 'ctb-gbrain-'));
    // Reaper: blocks reading a pipe only this process writes, so it removes the temp home however
    // this process ends (exit, signal, crash, or `bun test`, which skips 'exit' handlers).
    const reaper = Bun.spawn(['sh', '-c', `trap '' INT TERM HUP; while read -r _; do :; done; sleep 1; rm -rf "$0"`, this.home], {
      stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
    });
    reaper.unref();
    const seedDir = join(this.home, 'seed');
    for (const [path, md] of Object.entries(World.fresh().state.brain)) {
      if (isVault(path)) continue;
      const file = join(seedDir, `${this.slug(path)}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, md);
      this.indexed.set(path, md);
    }
    this.worker = new Worker(new URL('./gbrain-worker.ts', import.meta.url).href);
    this.worker.unref();
    this.worker.postMessage({
      type: 'setup', ctrl: this.ctrl.buffer, data: this.data.buffer, seedDir, seedCount: this.indexed.size,
      cli: GBRAIN_CLI, env: gbrainEnv(this.home), commit: GBRAIN_COMMIT,
    });
    process.on('exit', () => this.close());
  }

  /** Stop gbrain and delete this process's GBRAIN_HOME now (the reaper would, at process end). */
  close(): void {
    if (this.broken === 'gbrain brain closed') return;
    this.broken = 'gbrain brain closed';
    const pid = this.servePid();
    if (pid) try { process.kill(pid); } catch {}
    this.worker.terminate();
    rmSync(this.home, { recursive: true, force: true });
  }

  /** pid of the running `gbrain serve`, 0 until it has started. */
  servePid(): number {
    return Atomics.load(this.ctrl, 2);
  }

  private slug(path: string): string {
    const s = slugFor(path);
    this.paths.set(s, path);
    return s;
  }

  /** Blocking call into the worker. */
  private call(op: string, args: Record<string, unknown>): any {
    if (this.broken) throw new Error(this.broken);
    const seq = ++this.seq;
    this.worker.postMessage({ type: 'call', seq, op, args });
    const deadline = Date.now() + CALL_TIMEOUT_MS;
    for (let done; (done = Atomics.load(this.ctrl, 0)) !== seq;) {
      if (Atomics.wait(this.ctrl, 0, done, deadline - Date.now()) === 'timed-out') {
        this.broken = `gbrain ${op} timed out after ${CALL_TIMEOUT_MS} ms`;
        throw new Error(this.broken);
      }
    }
    const out = JSON.parse(new TextDecoder().decode(this.data.slice(0, Atomics.load(this.ctrl, 1))));
    if (out.error !== undefined) throw new Error(out.error);
    return out.value;
  }

  /** Make the index hold exactly this world's non-vault pages, minus any gbrain refuses. */
  private sync(world: World): void {
    for (const [path, md] of Object.entries(world.state.brain)) {
      if (isVault(path) || this.indexed.get(path) === md || this.skipped.get(path) === md) continue;
      this.skipped.delete(path);
      if (md.trim()) {                                             // gbrain refuses empty pages
        try {
          this.call('put', { slug: this.slug(path), content: md });
          this.indexed.set(path, md);
          continue;
        } catch (e) {
          if (this.broken) throw e;
          console.warn(`[gbrain] not indexing ${path}: ${e instanceof Error ? e.message : e}`);
        }
      }
      this.skipped.set(path, md);
      if (this.indexed.delete(path)) this.call('delete', { slug: this.slug(path) });  // drop the stale copy
    }
    for (const path of [...this.indexed.keys()]) {
      if (path in world.state.brain) continue;
      this.call('delete', { slug: this.slug(path) });
      this.indexed.delete(path);
    }
    for (const path of [...this.skipped.keys()]) if (!(path in world.state.brain)) this.skipped.delete(path);
  }

  search(world: World, query: string): { results: SearchHit[] } {
    this.sync(world);
    const terms = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
    const chunks: { slug: string; chunk_text: string }[] = this.call('search', { query: String(query), limit: 20 });
    const results: SearchHit[] = [];
    for (const c of chunks) {
      const path = this.paths.get(c.slug);
      if (!path || !this.indexed.has(path) || results.some((r) => r.path === path)) continue;  // our pages, one hit each
      const lines = c.chunk_text.split('\n').filter((l) => l.trim());
      const line = lines.find((l) => terms.some((t) => l.toLowerCase().includes(t))) ?? lines[0] ?? '';
      results.push({ path, title: title(path, this.indexed.get(path)!), snippet: line.trim().slice(0, 200) });
      if (results.length === 5) break;
    }
    return { results };
  }

  read(world: World, path: string): string | undefined {
    return world.state.brain[path];
  }

  write(world: World, path: string, content: string): void {
    world.state.brain[path] = content;
  }

  /** gbrain's own stored copy of a page (compiled body), for verifying the index round-trip. */
  indexedPage(path: string): { slug: string; title: string; compiled_truth: string } {
    return this.call('get', { slug: slugFor(path) });
  }
}
