// HTTP + WebSocket transport for the arena.
//   GET  /, /arena        web/arena.html            GET /attack  web/attack.html
//   GET  /<file>          web/<file> (no traversal; malformed escapes -> 400)
//   WS   /ws              ArenaEvent JSON: lanes, score, recent history, then live events
//   POST /api/attack      {player, laneId, channel, from:{name,address}, subject, body}
//                         -> 200 {inboundId} | 400/403/413/429 {error}
import { statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Arena } from './arena';
import { parseAttack } from './attack';
import { SCENARIO } from '../prompts';

export const WEB_DIR = resolve(import.meta.dir, '../../web');
const PAGES: Record<string, string> = { '/': 'arena.html', '/arena': 'arena.html', '/attack': 'attack.html' };
const MAX_BODY = 64 * 1024;

export interface ServeOptions { arena: Arena; port?: number; host?: string; webDir?: string }

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

function serveStatic(pathname: string, webDir: string): Response {
  let rel = PAGES[pathname];
  if (!rel) {
    try { rel = decodeURIComponent(pathname); } catch { return new Response('bad request', { status: 400 }); }
    if (rel.includes('\0')) return new Response('bad request', { status: 400 });
  }
  const abs = resolve(webDir, `.${rel.startsWith('/') ? '' : '/'}${rel}`);
  if (!abs.startsWith(webDir + sep)) return new Response('not found', { status: 404 });
  try {
    if (!statSync(abs).isFile()) return new Response('not found', { status: 404 });
  } catch {
    return new Response('not found', { status: 404 });
  }
  return new Response(Bun.file(abs), { headers: { 'cache-control': 'no-cache' } });
}

async function handleAttack(req: Request, arena: Arena): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: 'request too large' }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({ error: 'invalid JSON' }, 400); }
  const parsed = parseAttack(body, arena.lanes.map((l) => l.id), arena.nextAttackId());
  if ('error' in parsed) return json(parsed, 400);
  const res = arena.submit(parsed.laneId, parsed.item);
  if (!res.ok) return json({ error: res.error }, res.status);
  return json({ inboundId: parsed.item.id });
}

export function startServer(opts: ServeOptions) {
  const { arena } = opts;
  const webDir = resolve(opts.webDir ?? WEB_DIR);
  const server = Bun.serve({
    port: opts.port ?? 4173,
    hostname: opts.host ?? '127.0.0.1', // explicit IPv4 loopback: 'localhost' can bind only [::1]
    maxRequestBodySize: MAX_BODY,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (srv.upgrade(req, { data: undefined })) return undefined;
        return new Response('websocket upgrade required', { status: 400 });
      }
      if (url.pathname === '/api/attack') {
        if (req.method !== 'POST') return json({ error: 'use POST' }, 405);
        return handleAttack(req, arena);
      }
      if (url.pathname === '/api/scenario') {
        // The same "plot" the defender is spun up with — the portal shows it as the Target Dossier.
        return json({ markdown: SCENARIO });
      }
      if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
      return serveStatic(url.pathname, webDir);
    },
    error(err) {
      console.error('[serve] request error:', err);
      return new Response('internal error', { status: 500 });
    },
    websocket: {
      open(ws) {
        for (const ev of arena.welcome()) ws.send(JSON.stringify(ev));
        ws.subscribe('arena');
      },
      message() { /* clients only listen */ },
    },
  });
  const unlisten = arena.listen((ev) => { server.publish('arena', JSON.stringify(ev)); });
  return {
    server,
    url: `http://${server.hostname}:${server.port}`,
    stop() {
      unlisten();
      arena.stop();
      server.stop(true);
    },
  };
}
