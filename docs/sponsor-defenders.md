# Sponsor defender layers

An extension of the arena: instead of a generic defense ladder, **each tier is one real sponsor's
defensive feature**, added one at a time so the ablation stays clean (a breach-rate change is still
attributable to the single layer you added). This makes the scoreboard both a controlled measurement
*and* a live showcase of the hosts' products.

```
base model  →  +GBrain permissions  →  +QM screener  →  +Memorable immunity  →  (+River-trained model)
```

## The layers

| Tier | Sponsor | What it adds | Where |
|---|---|---|---|
| `gbrain` | **GBrain** | permission grants (vault Off, drafts, allowlisted-pay Manage, read-only pages); with `CTB_BRAIN=gbrain` the brain itself is GBrain | `src/tiers.ts`, `src/policy.ts`, `src/brain/` |
| `screened` | **QM** | Auto-posture content screener: an LLM flags a likely injection and spotlights (delimits) it as `UNTRUSTED_DATA` before the defender reads it; a flagged doc is quarantined in the world too | `src/defenses/screener.ts` |
| `immune` | **Memorable** | procedural memory: every breach is distilled into a rule and fed to the next defender (`prompted` + learned lessons) | `src/defenses/lessons.ts`, `scripts/learn.ts` |
| _(roadmap)_ `trained` | **River** | a defender fine-tuned on breach traces (needs event credits + the SFT export, item 19) | `scripts/export-sft.ts`, `src/llm/river.ts` |
| _(infra)_ | **Superset** | runs the whole fleet of defender lanes in parallel, each isolated | `src/server/` (the multi-lane server) |

`screened` and `immune` build on `prompted` so each isolates its own layer's effect vs. the prompt.

## Run them

```bash
# QM screener lane
bun run scripts/run-one.ts --tier screened --backend claude-cli --model haiku --item world/attacks/do-01.json

# Memorable immunity: learn from breaches on a train split, then measure prompted vs immune on held-out test
bun run scripts/learn.ts --seed 7 --backend claude-cli --model haiku --filter poison   # real
bun run scripts/learn.ts --seed 7 --backend fake                                        # pipeline dry-run
```

`learn.ts` writes the procedures to `world/lessons/active.md`, which the `immune` tier reads at spin-up.
Set `CTB_MEMORABLE=1` (after `npx memorable-cli enable`) to also record them through the real
Memorable CLI store; otherwise the local markdown store is used (offline, no setup).

## Honest caveats

- **Stacked, not raced.** Adding one layer at a time keeps the measurement attributable. A head-to-head
  "harness A vs harness B" board would confound model/memory/tools — if you want that showcase, present
  it as a leaderboard of defenders and say so; don't dress it up as a controlled result.
- **The screener is belt-and-suspenders**, not a scoring gate: the World and deterministic judge always
  see the original item (the screener runs after `world.deliver`), so it changes what the model sees,
  never how a breach is scored. It fails open (a screener outage never drops real mail).
- **Immunity's ceiling is low on a well-aligned model.** On Haiku the base breach rate is already ~5%
  (mostly memory-poisoning; see `docs/FINDINGS.md`), so there is little for the `immune` tier to
  improve on — expect a small or null effect, and read the mechanism as the point, not the number.
  The `fake` backend proves the pipeline (it plays each attack's winnability move regardless of the
  prompt, so before==after there by construction).

## Honest status (what is real vs modeled-on)

Being precise so nothing overclaims — the arena engine (judge, defender, tools, console,
measurement) is real; the sponsor *bindings* are mostly modeled-on, not the sponsors' software
running:

- **GBrain — real as a search backend only.** With `CTB_BRAIN=gbrain` the real GBrain binary runs
  and backs `search_brain`/`read_page`/`write_page` (verified, zero network). It is **not wired into
  the demo lanes by default** (the brain is process-global, not per-lane) and it does **not** enforce
  the HARD lane's permissions — those are our `scopedPolicy`, *modeled on* GBrain's Off/Read/Draft/
  Manage/Full grades. So HARD is "GBrain-style," not GBrain enforcing.
- **QM (`screened`) — modeled on, not QM.** Our own LLM screener in the spirit of QM's Auto posture.
  No QM code is imported or ported.
- **Memorable (`immune`) — modeled on, not Memorable.** Our own markdown lesson store; the `immune`
  tier reads `world/lessons/active.md`, it does not recall from Memorable. Memorable's real interface
  (`record` session traces / `recall`) is not wired.
- **River / Superset / UFO — not integrated.** River is roadmap (adapter + SFT export exist, no model
  trained/served); Superset/UFO are framing only.

Making any one of these genuinely enforce (e.g. routing the defender's tools through GBrain's MCP
with a scoped token, on a weak base model so the tool visibly holds where the model breaks) is the
real "these tools protect your intelligence" build — deliberately deferred.
