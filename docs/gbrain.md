# GBrain-backed brain (`CTB_BRAIN=gbrain`)

With `CTB_BRAIN=gbrain`, the defender's `search_brain` runs on
[GBrain](https://github.com/garrytan/gbrain) (MIT, Garry Tan): a local, keyless PGLite brain
with Maya's seed pages imported, queried through GBrain's own MCP `search` op. It makes no
network connections (see "No network" below). When the variable
is unset (or `markdown`), the plain markdown brain is used and nothing changes.

## Install (user space, once)

Pinned to the tested commit `e78f1c3` (0.59.0.0, 2026-09-26):

```bash
git init ~/.local/share/gbrain && cd ~/.local/share/gbrain
git remote add origin https://github.com/garrytan/gbrain
git fetch --depth 1 origin e78f1c38b947b053f3a46881340f74f316be855a
git checkout FETCH_HEAD
bun install
```

At startup the adapter checks that commit and prints a `[gbrain] … tested with e78f1c3…` warning
if the checkout is on a different one. If the checkout lives somewhere else, set
`CTB_GBRAIN_CLI=/path/to/gbrain/src/cli.ts`. The README's `bun install -g github:garrytan/gbrain`
fails at that commit with `error: Couldn't find patch file: 'patches/postgres@3.4.9.patch'`,
so use a clone instead.

## Run

```bash
CTB_BRAIN=gbrain bun test tests/gbrain          # import seed -> search -> write -> read back, isolation, vault
CTB_BRAIN=gbrain bun run scripts/run-one.ts --tier prompted --backend claude-cli --model haiku \
  --item world/tasks/sample-daniel-checklist-link.json
CTB_BRAIN=gbrain bun run scripts/serve.ts       # arena
```

## Design

- **The World stays the record.** `read_page`, `write_page` and `append_page` read and write
  `World.state.brain`, so the judge still sees every write. GBrain is the search index over
  those pages (`src/brain/gbrain.ts`); the markdown default is `src/brain/markdown.ts`.
- **One private brain per process.** Importing `src/brain` with `CTB_BRAIN=gbrain` starts a
  worker that creates a temp `GBRAIN_HOME`. There it runs `gbrain init --pglite --no-embedding`,
  runs `gbrain import <seed> --no-embed` on every non-vault seed page, and starts `gbrain serve`
  (stdio MCP).
- **Cleanup from every entry point.** A small reaper (`sh`) holds the read end of a pipe that
  only our process writes. When our process ends for any reason, the pipe closes and the reaper
  deletes the temp dir. That covers normal exit, SIGINT/SIGTERM (including Ctrl-C to the whole
  process group), SIGKILL, and `bun test` (which skips `exit` hooks). `gbrain serve` exits when
  its stdin closes. On a normal `exit`, `close()` also stops serve and deletes the dir right away.
  It is idempotent, so `serve.ts`'s own signal handler is fine. Verified: no
  `/tmp/ctb-gbrain-*` dir and no serve or reaper process left after each of these cases.
- **No network, no inherited environment.** Every gbrain process (init, import, serve) gets
  exactly `PATH`, `HOME=<temp dir>`, `GBRAIN_HOME=<temp dir>` and `GBRAIN_SELF_UPGRADE_MODE=off`
  (`gbrainEnv`). With the parent environment inherited, gbrain picked up `OPENAI_API_KEY` and
  connected to api.openai.com during import. Under strace (`-f -e trace=connect`, fake OpenAI and
  Anthropic keys exported), `CTB_BRAIN=gbrain bun test tests/gbrain` made 8 AF_INET/AF_INET6
  connects to port 443 before the fix and 0 after. The only connects left are 2 AF_UNIX, and the
  trace covers the init, import, serve and git children. The suite also passes under
  `unshare -rn`, which has no network. `tests/gbrain` checks the live serve process's
  `/proc/<pid>/environ` for the fake keys.
- **Episode isolation by re-sync.** Before each search, the index is diffed against the current
  World. Pages that changed are sent with `put_page`, and pages that are gone are removed with
  `delete_page`. A page written in one episode is therefore re-indexed in time for that episode's
  searches, then reverted before the next episode's first search.
- **Synchronous tools.** `runTool` is synchronous, so each gbrain call posts to the worker and
  blocks on `Atomics.wait` until the MCP reply is in shared memory.
- **The vault is never indexed.** `vault/` pages are skipped at import and at sync, and search
  only returns pages it indexed itself. `read_page` and `write_page` still refuse `vault/`.
- **Slug mapping.** GBrain reserves `skills/` for its own skillpack, skips `index.md` (along with
  `README.md`, `log.md` and the other metafiles) on import, and accepts only slug-safe segments.
  Those pages get an opaque `ctb/<hash>` slug, which search maps back to the World path.
- **Pages GBrain refuses are skipped.** Some pages fail `put_page`, for example ones containing a
  NUL byte ("unsupported Unicode escape sequence"). Such a page is logged
  (`[gbrain] not indexing <path>: …`) and left out of the index, and any older indexed copy is
  deleted. Search then does not find it and the episode continues. `read_page` still returns it.
- **Output shape.** Results keep the tool's shape `{path, title, snippet}`, capped at 5, one hit
  per page. The title comes from the World page, using the same rule as the markdown brain. The
  snippet is the first line of GBrain's matching chunk that contains a query term.

## Latency (this laptop, keyword-only)

| call | time |
|---|---|
| startup: init + import 24 pages + serve (once per process, background) | ~14 s |
| warm `search_brain` (n=35) | p50 48 ms, p95 84 ms |
| first search after one `write_page` (1 `put_page` + search) | 450–960 ms |
| first search of the next episode after 5 writes (5 deletes + search) | ~2.0 s |
| `read_page` / `write_page` | World only, <1 ms |

## Caveats

- **Keyword-only.** Embeddings are off (`--no-embedding`), so this uses GBrain's tsvector keyword
  search, with no vector search and no graph. It returns fewer, stricter hits than the markdown
  scorer: "Wen Chen" gives 1 hit against 5, and "Beam launch checklist" gives 2 against 5. The
  top hit looked relevant in all 15 queries probed, but recall is lower. The Ollama embedding
  path was not wired up.
- **Blocking calls.** Each call blocks the JS event loop for its duration, about 50 ms per
  search and about 0.5 s per re-indexed page. In the arena, every lane stalls during that time.
- **Startup cost.** Each process pays about 14 s at startup. Its temp brain takes about 45 MB in
  `/tmp`, which is tmpfs here, until the process ends (see "Cleanup from every entry point").
- **Default test timeout.** The existing suites pass under `CTB_BRAIN=gbrain` when run with
  `--timeout 60000`. The default 5 s timeout is too short for the first search while gbrain is
  still initializing.
