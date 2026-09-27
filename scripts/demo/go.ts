// One-command LOCAL demo launcher. Finds this machine's LAN address, starts the arena server
// bound to it, and prints the exact URLs to open — the projector arena (with the phone portal
// baked into its QR) and the portal itself. Phones on the same wi-fi scan the on-screen QR and
// get the live attack console. No tunnel, no cloud.
//
//   bun run scripts/demo/go.ts [--lanes config/lanes.json] [--port 4173] [--backend b --model m]
//
// For attacks over the public internet instead of a LAN, use a tunnel (see DEMO.md):
//   bun run scripts/serve.ts --lanes config/lanes.json
//   cloudflared tunnel --url http://localhost:4173
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name: string, def: string) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : def;
};
const port = flag('port', '4173');

function lanIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

const ip = lanIPv4();
if (!ip) {
  console.error('go: could not find a LAN IPv4 address (not on wi-fi/ethernet?).');
  console.error('    Falling back to localhost — only this machine can reach it.');
}
const host = ip ?? '127.0.0.1';
const portalUrl = `http://${host}:${port}/attack`;
const arenaUrl = `http://${host}:${port}/arena?portal=${encodeURIComponent(portalUrl)}`;

const line = '─'.repeat(64);
console.log('\n' + line);
console.log('  CAPTURE THE BRAIN — local arena');
console.log(line);
console.log('  On the projector, open:');
console.log('    \x1b[1;36m' + arenaUrl + '\x1b[0m');
console.log('  (its QR points phones at the portal — they must be on the same wi-fi)');
console.log('');
console.log('  Phones can also open directly:');
console.log('    \x1b[1;36m' + portalUrl + '\x1b[0m');
console.log(line);
console.log('  Phone says ERR_ADDRESS_UNREACHABLE? This wi-fi likely isolates clients');
console.log('  (common on campus / office / guest networks). Use a tunnel instead — in');
console.log('  another terminal, once this is running:');
console.log('    \x1b[1;33mcloudflared tunnel --url http://localhost:' + port + '\x1b[0m');
console.log('  then open  /arena?portal=<the https://….trycloudflare.com>/attack  on the projector.');
console.log(line + '\n');

// Hand off to the real server, bound to 0.0.0.0 so phones on the LAN can reach it.
const serveArgs = ['run', 'scripts/serve.ts', '--host', '0.0.0.0', '--port', port];
const passthrough = ['lanes', 'backend', 'model', 'max-steps'];
for (const name of passthrough) {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1]) serveArgs.push('--' + name, argv[i + 1]!);
}
if (!argv.includes('--lanes') && !argv.includes('--backend')) serveArgs.push('--lanes', 'config/lanes.json');

const child = spawn(process.execPath, serveArgs, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
