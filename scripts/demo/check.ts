/**
 * Demo-day preflight: one PASS/FAIL line per prerequisite, exit 1 if any FAIL.
 *
 *   bun run scripts/demo/check.ts
 *
 * Checks bun, the claude CLI + its login (`claude auth status`: no model call, bills nothing), ollama
 * running with every model the lane configs need, the cloudflared binary, at least one replayable run
 * dir (loaded with the same loader as `serve.ts --replay`), and the vendored QR encoder (encode a
 * tunnel-style URL, rasterize it, decode it back with jsQR). Never opens a tunnel; the only network
 * call is to the local ollama.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import jsQR from 'jsqr';
import { encode } from '../../web/vendor/uqr.js';

const ROOT = join(import.meta.dir, '../..');
const LOCAL_CLOUDFLARED = join(homedir(), '.local/bin/cloudflared');
const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
const OLLAMA_URL = 'http://localhost:11434';

async function run(cmd: string[], ms = 10_000) {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: ms });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`\`${cmd.join(' ')}\` exited ${code}: ${(err || out).trim().split('\n')[0]}`);
  return out.trim();
}

const checks: [string, () => Promise<string>][] = [
  ['bun', async () => `${Bun.version} (${process.execPath})`],

  ['claude', async () => {
    const bin = Bun.which('claude');
    if (!bin) throw new Error('claude CLI not on PATH');
    const version = await run([bin, '--version']);
    const status = JSON.parse(await run([bin, 'auth', 'status'])) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    if (status.loggedIn !== true) throw new Error(`${version}, but not logged in: run \`claude auth login\``);
    return `${version} · logged in (${status.authMethod ?? '?'}${status.subscriptionType ? `, ${status.subscriptionType}` : ''})`;
  }],

  ['ollama', async () => {
    const need = new Set(['qwen3:4b']);
    for (const f of readdirSync(join(ROOT, 'config')).filter((n) => /^lanes.*\.json$/.test(n))) {
      for (const l of JSON.parse(readFileSync(join(ROOT, 'config', f), 'utf8')) as { backend: string; model: string }[]) {
        if (l.backend === 'ollama') need.add(l.model);
      }
    }
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) }).catch(() => {
      throw new Error(`not reachable at ${OLLAMA_URL}: start it with \`ollama serve\``);
    });
    const have = new Set(((await res.json()) as { models: { name: string }[] }).models.map((m) => m.name));
    const missing = [...need].filter((m) => !have.has(m));
    if (missing.length) throw new Error(`missing model(s) ${missing.join(', ')}: run \`ollama pull ${missing[0]}\``);
    return `running · ${[...need].join(', ')} present`;
  }],

  ['cloudflared', async () => {
    const bin = existsSync(LOCAL_CLOUDFLARED) ? LOCAL_CLOUDFLARED : Bun.which('cloudflared');
    if (!bin) throw new Error(`not in ~/.local/bin or PATH: mkdir -p ~/.local/bin && curl -fL -o ${LOCAL_CLOUDFLARED} ${CLOUDFLARED_URL} && chmod +x ${LOCAL_CLOUDFLARED}`);
    return `${await run([bin, '--version'])} (${bin})`;
  }],

  ['replay', async () => {
    const { loadRun } = await import('../../src/server/replay'); // same loader as serve.ts --replay; a broken src/ FAILs here
    const results = join(ROOT, 'results');
    const ok: string[] = [];
    for (const d of readdirSync(results, { withFileTypes: true })) {
      const dir = join(results, d.name);
      if (!d.isDirectory() || !existsSync(join(dir, 'results.jsonl')) || !existsSync(join(dir, 'traces'))) continue;
      try {
        const n = loadRun(dir).length;
        if (n) ok.push(`results/${d.name} (${n})`);
      } catch { /* unreadable run: not replayable */ }
    }
    if (!ok.length) throw new Error('no results/<run>/ with results.jsonl + traces/: run an eval first (scripts/eval.ts)');
    return `${ok.length} replayable run dir(s): ${ok.join(', ')}`;
  }],

  ['qr', async () => {
    const url = 'https://example-tunnel.trycloudflare.com/attack';
    const { size, data } = encode(url, { ecc: 'M', border: 4 }); // same options as web/arena.js
    const scale = 4, w = size * scale;
    const px = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
      const v = data[Math.floor(y / scale)]![Math.floor(x / scale)] ? 0 : 255;
      px.set([v, v, v, 255], (y * w + x) * 4);
    }
    const got = jsQR(px, w, w)?.data;
    if (got !== url) throw new Error(`encoded ${url}, decoded ${JSON.stringify(got ?? null)}`);
    return `web/vendor/uqr.js encodes ${url} and jsQR decodes it back (${size - 8}x${size - 8} modules)`;
  }],
];

const t0 = performance.now();
const results = await Promise.all(checks.map(async ([name, fn]) => {
  try { return { name, ok: true, detail: await fn() }; } catch (e) {
    const at = (e as { position?: { file: string; line: number } }).position; // Bun build errors (e.g. a syntax error in src/)
    return { name, ok: false, detail: (e as Error).message + (at ? ` at ${relative(ROOT, at.file)}:${at.line}` : '') };
  }
}));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(12)} ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? `${failed} FAIL` : 'all PASS'} · ${results.length} checks in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);
