# Capture the Brain: demo runbook

The projector shows the arena at `/arena`. The room scans its QR code to open the phone attack portal
at `/attack`, which is served from this laptop through a Cloudflare quick tunnel. If the network
fails, replay mode shows recorded runs and needs no LLM calls, no quota and no wifi.

All commands run from the repo root. Bun is at `~/.bun/bin/bun`. Port 4173 is used throughout. If you
change it, change it in every command.

## Setup checklist

### Night before

- [ ] `bun run scripts/demo/check.ts`: every line says PASS and it exits 0. It checks bun, the
      claude CLI and its login (`claude auth status`, which makes no model call), that ollama is
      running with `qwen3:4b` and every other ollama model in `config/lanes*.json`, the cloudflared
      binary, that at least one run dir can be replayed, and QR encode/decode. It never opens a tunnel.
- [ ] `bun run scripts/demo/qr-screenshot.ts`: starts the real server in replay mode, opens
      `/arena?portal=https://example-tunnel.trycloudflare.com/attack` in headless Chromium, and
      decodes the QR from the screenshot (`docs/screenshots/arena-qr.png`) with jsQR, and with
      zbarimg when it is installed. It exits 0 only if the decoded text matches the URL exactly.
- [ ] Optional end-to-end auth check. This makes one real haiku call, billed but tiny:
      `bun run scripts/smoke-llm.ts --backend claude-cli --model haiku`.
- [ ] Pick the replay runs for the fallback. Choose one run per lane tier, so that no lane shows
      "no replay data". Then test it with `bun run scripts/serve.ts --replay results/<run> ...` (see
      [Replay fallback](#replay-fallback)).
- [ ] Charge the laptop. Turn off sleep and screen blanking. Close any other process on port 4173.

### At the venue

- [ ] Connect to the venue wifi. Run `bun run scripts/demo/check.ts` again.
- [ ] Terminal 1: [start live](#start-live). Terminal 2: [open the tunnel](#tunnel).
- [ ] Open the projector URL with `?portal=` (see [Tunnel](#tunnel)) in a full-screen browser at
      1920x1080. The top-right badge must say **LIVE**.
- [ ] Scan the projector QR with your own phone. Send one attack on the EASY lane. It should appear
      on the projector and reach a verdict.
- [ ] Keep a third terminal ready with the replay command.

## Start live

```bash
bun run scripts/serve.ts --lanes config/lanes.json --host 0.0.0.0 --port 4173
```

- `--host 0.0.0.0` is only needed when phones reach the laptop directly over the LAN, without the
  tunnel. With cloudflared, the default `--host 127.0.0.1` is enough and safer:
  `bun run scripts/serve.ts --lanes config/lanes.json --port 4173`.
- `config/lanes.json` is the headline configuration: EASY naked/qwen3:4b (ollama), MEDIUM
  prompted/haiku, HARD scoped/sonnet (claude-cli).
- `config/lanes.local.json` runs every lane on local `qwen3:4b`. It makes no claude calls and uses
  no subscription quota. Use it if claude is slow, rate-limited or logged out.
- `--backend/--model` override every lane. For example, `--backend fake` gives a UI-only dry run
  with no LLM.
- The server prints the arena and portal URLs and one line per lane.

## Tunnel

```bash
~/.local/bin/cloudflared tunnel --url http://localhost:4173
```

1. cloudflared prints a box containing `https://<random-words>.trycloudflare.com`. Copy that URL.
   It changes every time cloudflared starts, so repeat steps 2–3 after a restart.
2. On the projector, open
   `http://localhost:4173/arena?portal=https://<random-words>.trycloudflare.com/attack`.
3. The QR and the text under it now point at the tunnel. Phones open `/attack` over HTTPS, and the
   portal's WebSocket upgrades to `wss://` on its own.

Notes:

- Keep the projector on `localhost`, not the tunnel URL. Then the arena stream does not depend on
  the internet. Without `?portal=`, the QR points at the origin the projector page was opened from.
  For `localhost`, that link is useless to phones.
- A quick tunnel needs no account or login. It has no uptime guarantee, which is why the replay
  fallback exists.
- cloudflared is `2026.9.3` (static linux-amd64 release binary, installed at
  `~/.local/bin/cloudflared`). To reinstall:
  `curl -fL -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x ~/.local/bin/cloudflared`.

## Replay fallback

Replay mode loads saved eval traces and plays them on a loop. It builds no LLM adapter and sets the
claude call cap to 0. It works with no wifi and no quota.

```bash
bun run scripts/serve.ts --replay results/<run> [--replay results/<run2> ...] [--speed 1] --port 4173
```

- Replayable run dirs are `results/<run>/` directories that contain both `results.jsonl` and
  `traces/`. `scripts/demo/check.ts` lists them.
- Each episode goes to the lane whose tier matches its trace. Pass one run per tier (for example
  naked, prompted and scoped) so that all three lanes play. A lane with nothing to replay shows
  "no replay data".
- In replay, the phone portal refuses attacks with a 403 ("This arena is replaying recorded
  runs…"). Don't send people to the QR; narrate over the replay instead.

### Fallback ladder

Go down one level at a time:

1. **Live + tunnel.** This is the headline.
2. **Tunnel is down, local network works.** Restart the server with `--host 0.0.0.0`. Get the
   laptop's LAN IP with `ip -4 -o addr show scope global`. Open
   `http://localhost:4173/arena?portal=http://<lan-ip>:4173/attack`. Phones must be on the same
   wifi, and venue wifi often isolates clients, so test with your own phone first.
3. **claude is slow, rate-limited or logged out.** Restart with `--lanes config/lanes.local.json`.
   All lanes then run on local qwen3:4b. The lane labels stay, but the model chips show qwen3:4b.
4. **Nothing reaches the laptop.** Use [replay](#replay-fallback) and narrate.

## GBrain mode

`CTB_BRAIN=gbrain bun run scripts/serve.ts --lanes config/lanes.json --port 4173` runs the defender's
`search_brain` on a local GBrain (PGLite, keyword search). It needs the one-time install in
[docs/gbrain.md](docs/gbrain.md). Startup takes about 14 s. Each search blocks every lane for about
50 ms, and each re-indexed page for about 0.5 s. Start it early.

## River

Placeholder. River setup (the `--backend river` adapter and SFT export for fine-tuning on event
credits) is being rebuilt. See [docs/river.md](docs/river.md).

## Budget and limits

- `claude -p` bills the owner's Claude subscription. Every claude-cli call goes through one limiter:
  at most 4 concurrent (`CTB_CLAUDE_CONCURRENCY`) and at most 2000 calls per process
  (`CTB_CLAUDE_MAX_CALLS`). Each call is appended to `results/usage.jsonl`.
- One live attack is one episode of up to `--max-steps` (default 8) model calls on its lane, plus up
  to one repair retry per malformed reply. HARD (sonnet) is the expensive lane.
- Arena defaults (`src/server/arena.ts`): at most 3 attacks in flight per player and 20 queued per
  lane. Past either limit, the portal answers 429 with a "wait" message. Portal fields have length
  limits (`src/server/attack.ts`, for example message ≤ 4000 characters).
- ollama (qwen3:4b) is local and free.
- Replay mode makes no LLM calls.

## The 90-second script

Placeholder until the experiments finish (TODO item 12b). Numbers must come from `docs/FINDINGS.md`
and `scripts/report.ts`.

### Hook

### The arena

### The live attack

### The numbers

### The thesis

## Troubleshooting

| Symptom | Fix |
|---|---|
| `check.ts` FAIL on a line | The FAIL line says what to do: run `ollama serve`, `ollama pull <model>`, `claude auth login`, or the cloudflared install command. A `replay` FAIL with "Syntax Error at <file>:<line>" means the source tree is broken, not the results. |
| Projector badge says RECONNECTING | The server is down or restarting. Look at terminal 1. The page reconnects every 1.5 s on its own. |
| QR shows `localhost:4173/attack` | The page was opened without `?portal=`. Add `?portal=https://<tunnel>/attack`. |
| Tunnel URL gives 502 / "unable to reach the origin" | Check that the server is running on the same port. `--host 127.0.0.1` binds only one of `127.0.0.1` or `[::1]`, and which one varied between runs on this laptop. To rule it out, start the server with `--host 127.0.0.1` and run `cloudflared tunnel --url http://127.0.0.1:4173`. |
| cloudflared prints no trycloudflare URL | There is no internet, or Cloudflare is unreachable. Go down the [fallback ladder](#fallback-ladder). |
| `EADDRINUSE` on 4173 | Run `ss -ltnp \| grep 4173` and stop that process, or use `--port 4174` everywhere, including the tunnel URL. |
| Phones get "replaying recorded runs" | The server is in replay mode. Restart it live. |
| Phones get 429 | Per-player or per-lane limit. Wait for verdicts, or point players at a quieter lane. |
| `claude-cli call cap reached` | Restart the server; the cap is per process. Or raise `CTB_CLAUDE_MAX_CALLS`, bearing the budget in mind. |
| EASY lane errors or stalls | ollama is not running or the model is unloaded. Run `ollama serve`, then `ollama run qwen3:4b "say ok"` to load the model. |
