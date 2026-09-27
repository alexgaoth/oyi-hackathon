// Worker thread behind src/brain/gbrain.ts. Tools are synchronous, so the main thread posts one
// call and blocks on Atomics.wait while this thread talks to a warm `gbrain serve` (stdio MCP)
// and writes the JSON reply into shared memory.
//
// Setup, once per process: `gbrain init --pglite --no-embedding` in a private GBRAIN_HOME,
// `gbrain import <seed dir> --no-embed`, then `gbrain serve`. Every gbrain process gets exactly
// `env` (gbrainEnv in gbrain.ts), nothing inherited.
import { dirname } from 'node:path';

declare const self: Worker;

interface Setup {
  ctrl: SharedArrayBuffer; data: SharedArrayBuffer; seedDir: string; seedCount: number;
  cli: string; env: Record<string, string>; commit: string;
}

let ctrl: Int32Array;   // [0] seq of the last finished call, [1] reply byte length, [2] serve pid
let data: Uint8Array;
let ready: Promise<void>;
let send: (method: string, params: unknown) => Promise<any>;

async function run(cmd: string[], env: Record<string, string>): Promise<string> {
  // cwd is the scrubbed temp HOME, not the repo: otherwise Bun auto-loads the repo's .env (which
  // may hold OPENAI_API_KEY for our own adapters) and gbrain would phone home during import.
  const p = Bun.spawn(cmd, { env, cwd: env.HOME, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(1).join(' ')} exited ${code}: ${(err || out).slice(-800)}`);
  return out + err;
}

async function setup(s: Setup): Promise<void> {
  const { env } = s;
  const repo = dirname(dirname(s.cli));
  const head = await run(['git', '-C', repo, 'rev-parse', 'HEAD'], env).then((o) => o.trim(), () => 'unknown');
  if (head !== s.commit) console.warn(`[gbrain] ${repo} is at commit ${head}; tested with ${s.commit} (docs/gbrain.md)`);
  const gbrain = [process.execPath, s.cli];
  await run([...gbrain, 'init', '--pglite', '--no-embedding'], env);
  const imported = await run([...gbrain, 'import', s.seedDir, '--no-embed'], env);
  const n = Number(/(\d+) pages imported/.exec(imported)?.[1] ?? -1);
  if (n !== s.seedCount) throw new Error(`gbrain import: expected ${s.seedCount} pages, got ${n}: ${imported.slice(-800)}`);

  const serve = Bun.spawn([...gbrain, 'serve'], { env, cwd: env.HOME, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  Atomics.store(ctrl, 2, serve.pid);
  let stderrTail = '';
  (async () => { for await (const c of serve.stderr) stderrTail = (stderrTail + new TextDecoder().decode(c)).slice(-2000); })();

  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  serve.exited.then((code) => {
    for (const p of pending.values()) p.reject(new Error(`gbrain serve exited ${code}: ${stderrTail}`));
    pending.clear();
  });
  (async () => {
    let buf = '';
    for await (const chunk of serve.stdout) {
      buf += new TextDecoder().decode(chunk);
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`gbrain ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    }
  })();

  let nextId = 0;
  const write = (msg: object) => { serve.stdin.write(`${JSON.stringify(msg)}\n`); serve.stdin.flush(); };
  send = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    write({ jsonrpc: '2.0', id, method, params });
  });
  await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'capture-the-brain', version: '0' } });
  write({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/** One MCP tool call; returns the parsed JSON of its first text block. */
async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await send('tools/call', { name, arguments: args });
  const text: string = r?.content?.[0]?.text ?? '';
  if (r?.isError) throw new Error(`gbrain ${name}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

const OPS: Record<string, (a: any) => Promise<unknown>> = {
  search: (a) => tool('search', { query: a.query, limit: a.limit }),
  put: (a) => tool('put_page', { slug: a.slug, content: a.content, force: true }),
  delete: (a) => tool('delete_page', { slug: a.slug, force: true }),
  get: (a) => tool('get_page', { slug: a.slug }),
};

function reply(seq: number, payload: object): void {
  let bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (bytes.length > data.length) bytes = new TextEncoder().encode(JSON.stringify({ error: `reply too large (${bytes.length} bytes)` }));
  data.set(bytes);
  Atomics.store(ctrl, 1, bytes.length);
  Atomics.store(ctrl, 0, seq);
  Atomics.notify(ctrl, 0);
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'setup') {
    ctrl = new Int32Array(m.ctrl);
    data = new Uint8Array(m.data);
    ready = setup(m);
    ready.catch(() => {});                  // reported to the first call
    return;
  }
  try {
    await ready;
    reply(m.seq, { value: await OPS[m.op]!(m.args) });
  } catch (err) {
    reply(m.seq, { error: err instanceof Error ? err.message : String(err) });
  }
};
