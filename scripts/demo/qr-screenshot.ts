/**
 * Portal-QR check on the real server: starts `scripts/serve.ts --replay <run>` (no LLM calls), opens
 * /arena?portal=<url> in headless Chromium at 1920x1080, screenshots the whole page and decodes the QR
 * from that PNG with jsQR (plus zbarimg when installed). Passes only if every decoder returns exactly
 * the ?portal= URL, #portal-url shows it, and the page logged no console/page errors, failed requests
 * or HTTP >= 400. Always stops the server it started.
 *
 *   bun run scripts/demo/qr-screenshot.ts [--replay results/<run>] [--portal <url>] [--out <png>]
 *     defaults: first replayable results/<run>, https://example-tunnel.trycloudflare.com/attack,
 *               docs/screenshots/arena-qr.png
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import jsQR from 'jsqr';
import { chromium, type Browser, type Page } from 'playwright';
import { PNG } from 'pngjs';

const ROOT = join(import.meta.dir, '../..');
const { values } = parseArgs({ options: { replay: { type: 'string' }, portal: { type: 'string' }, out: { type: 'string' } } });
const portal = values.portal ?? 'https://example-tunnel.trycloudflare.com/attack';
const out = resolve(values.out ?? join(ROOT, 'docs/screenshots/arena-qr.png'));
const run = values.replay ?? readdirSync(join(ROOT, 'results'))
  .map((d) => join('results', d))
  .find((d) => existsSync(join(ROOT, d, 'results.jsonl')) && existsSync(join(ROOT, d, 'traces')));
if (!run) throw new Error('no replayable results/<run> (results.jsonl + traces/); pass --replay');

const problems: string[] = [];
function watch(page: Page) {
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
}
function check(ok: boolean, pass: string, fail: string) {
  if (ok) console.log(`✓ ${pass}`);
  else problems.push(fail);
}

const server = Bun.spawn([process.execPath, 'scripts/serve.ts', '--replay', run, '--port', '0', '--host', 'localhost'], {
  cwd: ROOT, stdout: 'pipe', stderr: 'inherit',
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { server.kill(); process.exit(1); });

async function serverUrl(): Promise<string> {
  const reader = server.stdout.getReader();
  const re = /arena\s+(http:\/\/\S+)\/arena/;
  let text = '';
  while (!re.test(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`serve.ts exited before listening:\n${text}`);
    text += new TextDecoder().decode(value);
  }
  process.stdout.write(text);
  void (async () => { for (;;) { const { done } = await reader.read(); if (done) break; } })(); // keep the pipe drained
  return re.exec(text)![1]!;
}

let browser: Browser | undefined;
try {
  const base = await serverUrl();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  watch(page);
  const url = `${base}/arena?portal=${portal}`;
  console.log(`open ${url}`);
  await page.goto(url);
  await page.waitForSelector('#portal-qr svg');
  await page.waitForSelector('#conn[data-state=live]');
  await page.waitForFunction("document.querySelectorAll('.lane').length > 0");
  await page.evaluate('document.fonts.ready');
  await page.waitForTimeout(800);
  mkdirSync(dirname(out), { recursive: true });
  const buf = await page.screenshot({ path: out, animations: 'disabled' });
  console.log(`✓ screenshot ${out}`);

  const shown = await page.textContent('#portal-url');
  check(shown === portal.replace(/^https?:\/\//, ''), `#portal-url shows "${shown}"`, `#portal-url shows ${JSON.stringify(shown)}`);

  const png = PNG.sync.read(buf);
  const jsqr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
  check(jsqr === portal, `jsQR decodes the ${png.width}x${png.height} screenshot to ${jsqr}`, `jsQR decoded ${JSON.stringify(jsqr ?? null)}, expected ${portal}`);

  const zbarimg = Bun.which('zbarimg');
  if (zbarimg) {
    const proc = Bun.spawnSync([zbarimg, '--raw', '-q', out]);
    const zbar = proc.stdout.toString().trim();
    check(proc.exitCode === 0 && zbar === portal, `zbarimg decodes the screenshot to ${zbar}`, `zbarimg exit ${proc.exitCode}, decoded ${JSON.stringify(zbar)}, expected ${portal}`);
  } else {
    console.log('- zbarimg not installed; jsQR only');
  }
} catch (err) {
  problems.push(`script error: ${(err as Error).message}`);
} finally {
  await browser?.close().catch((e: Error) => problems.push(`browser close: ${e.message}`));
  server.kill();
  await server.exited;
}

if (problems.length) {
  console.error(`\n✗ ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nQR decodes to the ?portal= URL; no console errors, page errors or failed requests');
