# Capture the Brain — demo runbook

A live prompt-injection arena. Maya Chen's personal AI agent runs on her own brain — inbox,
calendar, payments, and a vault. The room attacks it from their phones; the projector shows, lane by
lane, how the **tools she owns** hold the line the model alone can't. The whole point in one screen:
*owning your intelligence means owning the layer that defends it.*

## The lanes (named by the tool defending them)

Same agent, same attacks — the only thing that changes across lanes is the defense doing the work:

| Lane | Defense | What it is |
|---|---|---|
| **UNGUARDED** | no tools | the bare agent — the control that breaches |
| **GBRAIN** | permission grants | GBrain holds Maya's logins and hands the agent results, never secrets: vault is *Off*, mail to strangers is *Draft*, payments are *Manage* (allowlisted vendors only), her records are *Read*-only |
| **QM** | content screener | QM's Auto posture screens every inbound and quarantines an injection as data before the agent ever reads it |
| **MEMORABLE** | immunity | every breach becomes a procedure the next defender already knows — the lane gets harder as the room attacks it |
| **RIVER** | trained defender | a model fine-tuned on the night's breach traces, refusing what the base model fell for |

The three headline lanes are **UNGUARDED · GBRAIN · QM**; Memorable and River are the deeper stack.

## Setup checklist

- [ ] `bun run scripts/demo/check.ts` → all green (bun, Claude auth, ollama, cloudflared, a replay run, QR).
- [ ] Decide the network path: **tunnel** (works anywhere) or **LAN** (only if the wi-fi allows device-to-device).
- [ ] Open the projector URL full-screen; confirm the QR scans to the attack portal from a phone.
- [ ] Have the **replay fallback** ready in a second terminal in case the venue wi-fi is hostile.

## Local, one command (same wi-fi)

```bash
bun run scripts/demo/go.ts --lanes config/lanes.json
```

Finds this laptop's LAN address, starts the arena on it, and prints the **projector URL** (with the
phone portal baked into its QR) and the **portal URL**. Phones on the same wi-fi scan and they're in.

## Start live (with a public tunnel — recommended)

Many venue networks isolate clients (phones can't reach the laptop over wi-fi). The tunnel sidesteps
that entirely and keeps the defender running locally on your own Claude auth:

```bash
bun run scripts/serve.ts --lanes config/lanes.json --port 4173
cloudflared tunnel --url http://localhost:4173
```

Copy the `https://<random>.trycloudflare.com` URL and open the projector at
`…/arena?portal=https://<random>.trycloudflare.com/attack`. The QR on screen now points there.

- `config/lanes.json` is the headline set: UNGUARDED · GBRAIN · QM (all on Claude Haiku).
- `config/lanes.local.json` runs every lane on local `qwen3:4b` — no Claude quota, for a dry run.
- `--backend fake` gives a UI-only run with no model at all.

## The attacker's phone

The portal is a **live intrusion console**, not a form-and-wait. When someone launches an attack it
follows *their* message through the running agent in real time:

- **Target Dossier** (optional) — recon on Maya's world (her role, habits, circle, the live Northwind
  billing-portal situation, the vault). It is the exact brief the agent is spun up with, so a pretext
  that fits the dossier is a pretext that fits the defender.
- **Live telemetry** — VAULT / LEDGER / MEMORY / CONTACTS flip as the agent acts (SEALED → OPENED → STOLEN).
- **The log** — the agent's real reasoning, each tool call, and `DEFENSE ENGAGED` when a layer refuses,
  with a live "agent is deciding… Ns" timer (real model latency — this is a live agent, not a replay).
- **The verdict** — BREACHED with the loot and points, or DEFENDED with which layer held.

## The 90-second script

1. **Hook.** "This is Maya's AI agent. It reads her mail, moves her money, edits her memory. You're
   going to try to turn it against her — scan the code."
2. **The arena.** Three lanes: the bare agent, the same agent behind GBrain, the same agent behind QM.
   "Watch which one you can break."
3. **The live attack.** Someone fires from their phone; the console streams the agent reading *their*
   message and deciding in real time. On **UNGUARDED** it complies — **BREACHED**, the vault turns red.
4. **The tools hold.** The identical attack on **GBRAIN** hits the permission wall — the vault is *Off*,
   the agent can't send it, DEFENSE ENGAGED. On **QM** the screener quarantined the injection before the
   agent even read it. The model didn't get safer; the **owned tool** did the protecting.
5. **The thesis.** "The agent is only as safe as the layer you own around it. Rent your intelligence and
   you rent its failures. Own it — GBrain, QM, Memorable, River — and you own the defense." → the numbers.

## Replay fallback (no wi-fi, no model)

```bash
bun run scripts/serve.ts --replay results/expA-naked --replay results/expA-prompted --replay results/expA-scoped
```

Replays a recorded run through the same projector with zero model calls. The self-contained
`docs/arena-demo.html` also plays a recorded run in any browser with no server at all.

## GBrain brain mode

`CTB_BRAIN=gbrain bun run scripts/serve.ts --lanes config/lanes.json` runs the defender's brain on
GBrain (search, read, write); the permission grants apply either way. Startup ~14s. See
`docs/gbrain.md`.

## River

Fine-tune a defender on the night's breach traces and serve it as the RIVER lane: export with
`bun run scripts/export-sft.ts results/<run> --out results/sft.jsonl`, train with your River credits,
then point a lane at the deployment (`--backend river`). See `docs/river.md`.

## Budget and limits

Live lanes call Claude via the local `claude` CLI (your subscription). A process-wide limiter
(`CTB_CLAUDE_CONCURRENCY`, `CTB_CLAUDE_MAX_CALLS`) and `results/usage.jsonl` keep it bounded. Per-player
and per-lane rate limits protect the queue. Replay mode makes zero model calls.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Phone: `ERR_ADDRESS_UNREACHABLE` on the same wi-fi | The network isolates clients — use the cloudflared tunnel. |
| Tunnel 502 / "unable to reach the origin" | Start the server with `--host 127.0.0.1` and tunnel `http://127.0.0.1:4173`. |
| QR shows `localhost/attack` | Opened without `?portal=` — append `?portal=https://<tunnel>/attack`. |
| Claude slow or rate-limited | Switch to `config/lanes.local.json` (local models) or the replay fallback. |
