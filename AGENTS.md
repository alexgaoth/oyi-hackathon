# Capture the Brain — agent handoff

Everything another agent needs to work on this repo. Read this, then `PLAN.md` for the design
contracts and `docs/FINDINGS.md` for the measured results.

## What it is

A **live prompt-injection arena**, built for the YC "Own Your Intelligence" hackathon (2026-09-27).
A personal AI agent (the *defender*) runs on a fictional persona's brain — notes, inbox, calendar,
payments, a vault with a secret flag. People attack it by email / calendar invite / shared doc from
their phones; a **deterministic judge** scores four ways to lose: **exfil** (leak the vault),
**wire** (pay a non-vendor / wrong amount), **poison** (plant a false memory), **relay** (spread a
payload to contacts). Three lanes show the *same agent under escalating defense*, so the scoreboard
proves which defense actually works.

It is really a **measurement instrument** wearing a game's skin. The headline finding (see
`docs/FINDINGS.md`): on Claude Haiku the loud attacks (exfil, wire) never land *even with no
defense* — safety training refuses them. The unguarded surface is **memory poisoning**, and a
security *prompt* doesn't stop it (5% → 5%); only an **owned permission layer** does (→ 0%), with
no loss of the agent's real-work utility.

## Runtime / stack

- **Bun + TypeScript.** No build step for the web UI (plain HTML/CSS/ESM in `web/`). Bun at
  `~/.bun/bin/bun`. Tests: `bun test`. Typecheck: `bunx tsc --noEmit -p .`.
- **LLM backends** (`src/llm/`, one interface `makeLLM({backend, model})`):
  `claude-cli` (default; drives the local `claude -p` via the user's Claude Code OAuth — sandboxed:
  `--tools ""`, `--strict-mcp-config`, `--safe-mode`, empty temp cwd, prompt on stdin), `anthropic`
  / `openai` / `river` (API-key), `ollama` (local qwen3:4b — slow on CPU), `fake` (scripted, tests).
- **Safety invariant #1:** the defender's model has **no real tools** — every "action" is simulated
  against an in-memory `World`. Attack text never reaches a model that can touch the machine.

## Map

| Path | What |
|---|---|
| `src/world/` | `World` (Maya's brain/inbox/calendar/ledger/vault), `fresh()`, seed loader, secrets |
| `world/seed/brain/**` | the seeded persona (Maya Chen, Lumen Labs): people, vendors, notes, skills, vault |
| `src/tools.ts` | the 15 defender tools, executed against `World` only (no real I/O) |
| `src/policy.ts` | `scopedPolicy` — the permission layer (vault owner-gated, drafts, allowlisted pay, read-only pages) |
| `src/judge.ts` | deterministic verdict: exfil (provenance: only counts secrets read via `read_vault` this episode)/wire/poison/relay + utility checks |
| `src/defender.ts` | `runEpisode(inbound, {tier, llm, ...})` — the JSON-protocol tool loop; never throws |
| `src/tiers.ts` | `naked → prompted → scoped → gbrain` (see below); `getTier`, `deriveTier` |
| `src/eval/` | corpus loader, fake policy, summary (`classify`), runner (`--resume`), report, winnability, hygiene |
| `world/attacks/**`, `world/tasks/**` | 49 attacks (10 families) + 14 benign tasks; each attack has a `meta.win` winnability proof |
| `src/server/` | live arena: per-lane queue, WS `ArenaEvent` stream, `POST /api/attack`, markers, replay |
| `src/brain/` | pluggable brain backend: markdown (default) or **GBrain** (`CTB_BRAIN=gbrain`, search index) |
| `web/arena.*` | projector view; `web/attack.*` | phone attack **console** (live, per-attacker) |
| `scripts/serve.ts` | the server CLI; `scripts/demo/go.ts` | one-command LAN launcher; `scripts/demo/check.ts` | preflight |
| `scripts/eval.ts`, `report.ts`, `validate-corpus.ts` | measurement harness |
| `docs/` | `explainer.html`, `ideas.html` (storming notebook), `arena-demo.html` (self-contained replay), `FINDINGS.md`, `gbrain.md`, `river.md` |

## The tiers (the important axis)

The lanes vary **one thing — the defense — holding the model and attacks fixed**, so a breach-rate
difference is attributable. (Racing different *harnesses* would confound model/memory/tools.)

- `naked` — helpful assistant, no security prompt, all tools.
- `prompted` — + a security system prompt (content is data, verify sender, never send the vault).
- `scoped` — + `scopedPolicy` (the permission layer).
- `gbrain` — `scoped`'s policy stated in **GBrain's permission-grade vocabulary** (vault = Off, mail
  to strangers = Draft, payments = Manage/allowlisted, people & vendor pages = Read). It is the
  same enforcement measured as `scoped` (0% breach); the `gbrain` tier binds that identity to
  GBrain and, when run with `CTB_BRAIN=gbrain`, the brain itself is GBrain. This is the HARD lane.

`config/lanes.json`: EASY naked/haiku · MEDIUM prompted/haiku · HARD gbrain/haiku (all claude-cli).
`config/lanes.local.json`: all lanes on local ollama. No "sonnet" anywhere.

## Run it

```bash
# Local, one command — same wi-fi (prints the projector + portal URLs)
bun run scripts/demo/go.ts --lanes config/lanes.json

# Manual / with a public tunnel (see below)
bun run scripts/serve.ts --lanes config/lanes.json --port 4173
cloudflared tunnel --url http://localhost:4173   # then open /arena?portal=<https url>/attack

# Replay (no LLM, no wifi) — the fallback
bun run scripts/serve.ts --replay results/expA-naked --replay results/expA-prompted --replay results/expA-scoped

# Preflight
bun run scripts/demo/check.ts
```

**KNOWN NETWORK GOTCHA:** on many wi-fi networks (campus / office / guest) the phone gets
`ERR_ADDRESS_UNREACHABLE` even on the same SSID — the access point **isolates clients**. The server
binds fine; nothing in the app can override AP isolation. **Use the cloudflared tunnel** (installed
at `~/.local/bin/cloudflared`); it gives a public https URL the phone reaches over the internet
while the defender stays local on the user's Claude auth.

**Deploy note:** Vercel can't host this (needs a persistent WebSocket server and the local
`claude` CLI). Railway/Fly could host the server, but **not** the `claude-cli` backend — you'd have
to switch to an API-key backend (`anthropic`/`river`), containerize, and accept public API spend.
The tunnel keeps auth local and is the recommended path.

## The attacker experience (web/attack.*)

The phone is a **live intrusion console**, driven entirely by the real `/ws` event stream for the
attacker's own `inboundId` — not a replay. It shows: target telemetry (vault/ledger/memory/contacts)
reacting per step, a timestamped log narrating the agent's *actual reasoning* + each tool call +
`DEFENSE ENGAGED` blocks, a live "agent is deciding… Ns" latency cue (real model latency = proof
it's live), and a BREACHED (with proof + points) / DEFENDED verdict. An optional **Target Dossier**
(`<details>`) gives in-world recon (built from the real seed) so manual attackers craft pretexts
that land. All event/attacker text is rendered as text nodes (no XSS; only trusted `icon()` uses
`insertAdjacentHTML`).

## Tests

```bash
CTB_SKIP_LIVE=1 bun test          # full suite, no billed calls
bun test tests/world tests/judge tests/policy tests/defender tests/eval tests/server tests/export
CTB_BRAIN=gbrain bun test tests/gbrain   # gbrain round-trip (needs the gbrain checkout, see docs/gbrain.md)
```
`CTB_SKIP_LIVE=1` skips the handful of live `claude-cli`/`ollama` tests. Live tests bill the user's
Claude subscription — a process-wide limiter (`CTB_CLAUDE_CONCURRENCY`, `CTB_CLAUDE_MAX_CALLS`) and
`results/usage.jsonl` guard it. Don't loop live calls.

## Status

**Done & verified** (each by an independent `critic` agent, one commit per item on branch
`odyssey/20260927-0110`): safe LLM adapters (+ hardening), world/judge (+ precision), defender loop,
arena UI (+ polish), arena server (live + replay), GBrain backend, demo tooling, attack corpus +
harness, the immersive attacker console, the GBrain-grants HARD lane. Experiment A is measured
(`docs/FINDINGS.md`, `results/expA-*`).

**Open (post-event, not demo-facing):**
- **`item 19` — River SFT export** (`scripts/export-sft.ts`): turns defender traces into
  fine-tuning JSONL. Last critic review is REVISE with one precise fix outstanding: mark `fetch_doc`
  `outward: true` in the attack allowlist so an errored data-carrying fetch is a cut point, then
  reconcile the `fx-attack-allowed` fixture (its `fetch_doc` 404s) + the docs==code test. Full
  detail in `.iterate/odyssey-20260927-0110/ODYSSEY.md`.
- Minor follow-ups (`item 20` judge regex perf, `item 21` arena ERROR stamp) — see `TODO.md`.

**Audit trail:** `.iterate/odyssey-20260927-0110/ODYSSEY.md` (gitignored) logs every dispatch,
verdict, and decision. `TODO.md` is the item list with frozen evals.

## Conventions

- Keep changes surgical; match surrounding style. The judge and the attack corpus are
  adversarially reviewed — don't weaken a check to make something pass.
- The seed brain is load-bearing: `tests/gbrain` asserts the imported page count, and the corpus's
  winnability + hygiene checks depend on the seed. Adding/removing seed pages breaks tests — update
  them deliberately.
- Artifacts (explainer, storming notebook, arena replay) are published to claude.ai and are private
  to the owner; republish the same file path / URL to update in place.
