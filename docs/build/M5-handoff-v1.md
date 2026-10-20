# M5 handoff v1

Written at the end of the M5 build described in `docs/build/M5-plan-v1.md`. Eight slices, each
its own branch and PR, sequentially chained per that plan's own stated practice (M3 and M4 both
followed this: slice 1 merged to `main`, every later slice's PR targets its immediate
predecessor branch rather than `main` directly). This document is slice 9, the closing handoff,
committed onto the last branch rather than a new one, matching M4's own precedent.

## What landed

| # | Slice | PR | Branch | Base | Status as of this writing |
|---|---|---|---|---|---|
| 1 | Embeddings architecture: spec, ADR, flags | #41 | `m5/embeddings-spec` | `m4/detached-workers` | Merged to `main` |
| 2 | `ctxd stdio` (Desktop chat integration) | #42 | `m5/stdio` | `m5/embeddings-spec` | Merged into its base |
| 3 | Importance ranking | #43 | `m5/importance` | `m5/stdio` | Merged into its base |
| 4 | Review-by dates and `ctxd tidy` | #44 | `m5/review-tidy` | `m5/importance` | Merged into its base |
| 5 | Scope rollback | #45 | `m5/scope-rollback` | `m5/review-tidy` | Merged into its base |
| 6 | Weekly digest | #47 | `m5/digest` | `m5/scope-rollback` | Merged into its base |
| 7 | Native skill sync | #48 | `m5/skill-sync` | `m5/digest` | Merged into its base |
| 8 | Semantic search end to end | #51 | `m5/semantic-search` | `m5/skill-sync` | Open |
| 9 | This document | | `m5/semantic-search` | | Open (same branch as #51) |

Only slice 1's PR is merged into `main` itself; every later slice's PR is merged into its
immediate predecessor branch, so `main` as of this writing has only slice 1 of the eight. The one
branch that actually carries every slice in sequence is `m5/semantic-search` (this branch).

**A detail worth calling out:** partway through slice 8, `origin/m5/skill-sync` was found to be
12 commits ahead of this build's own local history, carrying a merge of M3 slices 3, 5, 6 and 7
(conflict policies, claims across nodes, ACL events, sync freshness) done outside this build's own
context. Flagged to the owner before touching anything; they confirmed merging it in. That work is
not M5's own, but it now travels with this branch: `main` is also missing M3 slice 7 (sync
freshness, PR #46, merged into `m3/sync-acl-events` but not yet into `main`), and merging
`m5/semantic-search` into `main` closes that gap too, as a side effect.

## Merging

**The one remaining step to land all of M5 (and M3 slice 7 along with it):** `main` needs
`m5/semantic-search` merged into it. As with M4, the simplest path is to change PR #51's base to
`main` (or open one fresh PR from `m5/semantic-search` to `main`) rather than relying on each
intermediate PR separately reaching `main` first, since this branch already carries every slice's
commits in sequence on top of slice 1. The intermediate PRs (#42 through #48) can then be closed
without merging (their diffs are already included), or merged in order first if a slice-by-slice
`main` history is preferred.

**Checked, not assumed:** a local dry-run merge of `origin/main` into `m5/semantic-search`
(`git merge --no-commit --no-ff`, then `git merge --abort`, touching nothing) applied cleanly with
no conflicts.

## Exit check

`npm run typecheck`, `npm test` (691 tests across 60 files) and `npm run build` all pass clean on
`m5/semantic-search` as of this writing. Each slice was also separately verified live against the
real built CLI on scratch config and data directories (never real `~/.config/ctxd`, a real running
`ctxd server`, or the real `~/.claude/skills`), summarized here rather than repeated slice by
slice:

- `ctxd mcp`/`ctxd stdio` both launch the same stdio proxy, auto-starting the real server when it
  is not already running.
- `ctxd show --why` printed the importance score and its four parts; a brief and a search both
  reordered correctly between the `importance` flag on and off.
- `ctxd tidy` listed and applied findings across all five categories (supersede-archive,
  low-importance archive, review-due, duplicate-merge-refusal, stale-flag-close) against a scratch
  node.
- `ctxd scope rollback` previewed and then reverted a real entry created after a timestamp
  boundary, leaving an earlier entry untouched, on a scratch node.
- `ctxd digest` assembled and wrote a real weekly digest (correct counts, not counting itself),
  reran idempotently with no duplicate, and correctly picked up a milestone entry.
- `ctxd skills sync`/`ctxd skills import` round-tripped a real `SKILL.md` through a scratch
  `$HOME`'s `.claude/skills/` folder: wrote it, confirmed `allowed-tools` stripped and the
  managed-by comment present, reran idempotently, and confirmed `import` skips files it had
  already written itself rather than re-ingesting its own output (a real bug caught this way and
  fixed before commit).
- Semantic search ran end to end with the real downloaded model against a scratch node on a
  non-default port: `ctxd model fetch`/`status`, the real `ctxd server`'s background tick
  embedding two real entries, a real MCP `context_search` call for "shipping" (zero literal
  keyword overlap with either entry) correctly surfacing and ranking the deploy-related one first
  using the model's actual semantic understanding, and `ctxd doctor` reporting the healthy state.

## Known gaps, each already flagged in the code or docs that has it

None of these are silent; each has a comment or a doc note at its own call site pointing here.

- **PRD-v7's M5 exit criterion, "Hybrid search measurably better on a test set,"** was not
  measured quantitatively. Verification was live manual testing (the "shipping" example above) and
  unit tests exercising reciprocal rank fusion with a deterministic fake embedder, not a scored
  benchmark against a real query/relevance test set. Building that test set and running it is the
  most actionable item for whoever picks up where this leaves off.
- **Codex's personal skills folder path is unverified** (SPEC v8 open issue 16: "Confirm Codex's
  user skills folder... at the pinned version"). Native skill sync and import both support
  Claude Code only; asking for `codex` reports "not yet confirmed" rather than guessing a path.
- **`entries.approved_hlc`/`approved_by`** are defined in the schema but nothing in the write,
  review or materialize path ever sets them. The weekly digest's "decisions made" section uses
  `updated_hlc` instead (review-approval does update it), noted in a comment at that call site.
  Fixing the real gap (an actual approval timestamp) is a review.ts change, not this milestone's.
- **`ctxd skills sync`'s "after any change to a synced skill" automatic trigger** (SPEC 12.2) was
  not built; only the on-demand `ctxd skills sync` command exists. Wiring a trigger into the write
  path for every relevant event would be considerably more invasive than this slice's scope, the
  same reasoning that kept embedding computation out of `writeEntry` itself (slice 8).
- **`src/search/fts.ts`'s list-mode ranking** (`query: "*"`): the SQL orders by time, but the final
  JS sort still re-sorts by `_score`, which equals the importance score in list mode when the
  `importance` flag is on. So list mode's own claim ("lists by time instead of relevance") is only
  exactly true when the flag is off. Found during slice 3, deliberately not fixed there (fixing it
  means deciding whether scope/flag multipliers should still apply in list mode, which is an
  editorial call, not a slice-3 one) and not revisited since.
- **Semantic search's x64 (Intel hub) support** was checked via `sqlite-vec` and
  `@huggingface/transformers`'s published npm platform metadata (both explicitly list
  `darwin-x64`), not by literally running x64 code: this build's own machine is `arm64`, with no
  x64 Node runtime installed to test under. Real verification on the actual Intel Air hub, once
  this lands, is still the first real-hardware confirmation.
- **M4's `backups`/`backups.copy` default mismatch**, flagged in M4's own handoff, is still
  unresolved; changing a shipped default is the owner's call, not something fixed in passing here.

## What the owner does next

Per the kickoff doc's own pattern: merge `m5/semantic-search` into `main` (see "Merging" above),
then the owner's own real-machine steps. Specifically for this milestone: run `ctxd model fetch`
on whichever client machine will compute embeddings (never on the hub, which must not need the
model), turn on `semantic_search.compute` there and `semantic_search` wherever search should be
hybrid, and set `[skills] sync_clients` if native skill sync should run automatically rather than
only on demand. The exit criterion gap above (a real test set for "measurably better") is the one
item worth a deliberate decision rather than drifting into M6 unaddressed.
