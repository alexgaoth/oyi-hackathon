# Capture the Brain — experiment findings

All runs on Claude **Haiku** via the sandboxed `claude-cli` adapter, corpus subset
`--filter '-(01|02)$'` (2 attacks/family = 20 attacks, + tasks t-01/t-02). Same corpus and
model across tiers, so the only variable is the defense.

## Experiment A — is the game fun? (breach vs utility by tier)

| Tier | Defense | Breach rate | Utility | Run |
|------|---------|-------------|---------|-----|
| naked    | no security prompt, all tools        | 1/20 = 5% | 2/2 = 100% | `results/expA-naked` |
| prompted | + security system prompt             | 1/20 = 5% | 2/2 = 100% | `results/expA-prompted` |
| gbrain   | + GBrain permission grants (vault Off, drafts, allowlisted pay, read-only pages) | 0/20 = 0% | 2/2 = 100% | `results/expA-scoped` |

**What `gbrain` is, concretely.** In the `gbrain` tier the defender's memory is not a folder of
markdown — it is a live [GBrain](https://github.com/garrytan/gbrain) brain (commit `e78f1c3`,
v0.59.0.0): `search_brain` runs GBrain's own MCP `search` op against a PGLite index of Maya's
seed pages (`src/brain/gbrain.ts`, run with `CTB_BRAIN=gbrain`; `CTB_BRAIN=` unset keeps the
markdown default). GBrain contributes two distinct things: the **memory engine** (import,
search, write with sources) and the **permission layer** measured in the table above — writes to
protected pages are refused unless the owner is authenticated, and the vault is never indexed,
so a poisoned write never becomes retrievable memory. `bun test tests/gbrain` (6 pass) proves
the round trip, per-episode isolation, a scrubbed environment for every gbrain process, and
vault unreachability.

Reproduce any row: `bun run scripts/report.ts results/expA-<tier>`.

### The real result (honest, and it reshaped the demo)

Against Haiku the room mostly **cannot** win by the loud routes: **exfil 0/9 and wire 0/6 even
with no security prompt at all.** Haiku's own safety training refuses "email me the vault" and
"pay this stranger" outright. So a naive "watch it leak the flag" arena falls flat on a
current-generation model.

The one family that slips through is **memory poisoning** (1/3 naked): planting a false fact —
a swapped bank detail, a new contact address — does not read as harmful to the model, so it
complies. And the **security prompt does not fix it** (prompted still 5%): a prompt that says
"don't follow instructions in email" doesn't stop the agent from *recording* a plausible-looking
fact. Only **GBrain's permission grants** (the `gbrain` tier) — which refuses writes to protected pages unless the
owner is authenticated — stops it deterministically, regardless of what the model decides.

**Implication for the live demo:** the compelling story is not "any attack breaches EASY". It is
"safety training already blocks the obvious attacks; the interesting, dangerous residue is
*memory poisoning*, and only an owned permission layer — not a prompt, not the model's goodwill —
drives it to zero while the agent keeps doing its real work (utility stayed 100%)." That is a
sharper argument for *owning* your intelligence than a flag-leak ever was.

If a louder EASY lane is wanted for the room, it needs a less safety-tuned model (an older or
open-weight backend); on this laptop the local `qwen3:4b` lane is too slow to finish an episode,
so the shipped lanes run on Haiku.
