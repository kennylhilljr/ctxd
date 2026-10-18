# M2 handoff v1

Written at the end of the M2 build described in `docs/build/M2-kickoff-v1.md` (read via
`git show origin/main:docs/build/M2-kickoff-v1.md`, since it was never fetched into this
clone's working branches). This document is the exit check that kickoff doc asked for, plus
the state a reviewer needs to merge the work.

## What landed

Fourteen slices, each its own PR. Five were built by parallel agents directly off
`m1/exit-spec-v7`; the remaining nine (the hook lifecycle itself) were built sequentially,
each branched from the previous one, since they share a small set of files and conflict risk
outweighed parallelism there.

| # | Slice | PR | Branch | Base |
|---|---|---|---|---|
| 1 | Spec v7 | #13 | `m2/spec-v7` | `m1/exit-spec-v7` |
| 2 | Config and scope resolution | #11 | `m2/config-scope` | `m1/exit-spec-v7` |
| 3 | Sessions and hook CLI core | #15 | `m2/hook-core` | `m2/config-scope` |
| 4 | Path guard (PreToolUse) | #16 | `m2/path-guard` | `m2/hook-core` |
| 5 | Conformance kit | #17 | `m2/conformance-kit` | `m2/path-guard` |
| 6 | Crash sweep | #18 | `m2/crash-sweep` | `m2/conformance-kit` |
| 7 | Read moments | #19 | `m2/read-moments` | `m2/crash-sweep` |
| 8 | Write moments | #20 | `m2/write-moments` | `m2/read-moments` |
| 9 | Claims, complete | #21 | `m2/claims-complete` | `m2/write-moments` |
| 10 | Hygiene (quarantine, revert, release) | #14 | `m2/hygiene` | `m1/exit-spec-v7` |
| 11 | `ctxd review` | #22 | `m2/ctxd-review` | `m2/claims-complete` |
| 12 | Memory and journal CLI | #12 | `m2/memory-journal` | `m1/exit-spec-v7` |
| 13 | `ctxd install-hooks --dry-run` | #10 | `m2/install-hooks-dry-run` | `m1/exit-spec-v7` |
| 14 | This document | | | |

`m2/ctxd-review` (PR #22's head) is the deepest branch in the sequential chain and the one
this handoff's exit check ran against. It does not contain slices 1, 10, 12 or 13: those are
sibling branches off `m1/exit-spec-v7` that the sequential chain never merged in. Running
`ctxd install-hooks` on `m2/ctxd-review` fails with "not implemented" for exactly this
reason; it is proven working on its own branch (see below), just not yet integrated.

## Merging

Thirteen open PRs, two independent lineages sharing one root (`m1/exit-spec-v7`, itself
nine stacked PRs from M1, #1 through #9, none of them merged to `main` either). Suggested
order:

1. Merge the M1 chain (#1 through #9) to `main` first; nothing in M2 can land cleanly before
   it does.
2. Merge the sequential M2 chain (#11 through #22, in that numeric order) to `main`. Each PR's
   diff is already reviewed against its own immediate parent; merging in order keeps that
   reasoning valid.
3. Rebase the four sibling PRs (#13 spec-v7, #14 hygiene, #12 memory-journal, #10
   install-hooks) onto the new `main` one at a time, resolving the conflict described below
   as each lands, then merge each.

**The one real conflict to expect:** `SCHEMA_VERSION` in `src/store/schema.ts` was bumped
from 6 to 7 independently in three places, for three different reasons: spec-v7 (#13, a
`review_policy` default fix and a new `commits` table that nothing in the sequential chain
ended up needing, since write moments journals commits as regular entries instead), hygiene
(#14, the quarantine/batch columns), and the sequential chain itself (crash sweep's
`ended_by` column, claims-complete's `base_head`). Whichever merges last needs its bump
renumbered past whatever the earlier ones landed at, and its own schema additions kept. This
is additive column-by-column; none of the three removes or changes a column another one
added, so there is no real design conflict, only a number to fix.

No other cross-branch conflict is expected: the five sibling PRs touch different files
(`docs/spec`, `src/cli/quarantine.ts` and `src/store/hygiene.ts`, `src/cli/remember.ts` and
friends, `src/cli/install-hooks.ts`) from the sequential chain's hook-lifecycle files.

## Exit check: a simulated day

Run against `m2/ctxd-review`'s build, using the real `ctxd hook` binary (via the compiled
`dist/`, not a mock), a real throwaway git repository, and two real client identities. Full
transcript is in this session's tool history; this is the confirmed behavior, not a summary
of intent.

- `ctxd init` and `ctxd client add` for `claude-code` and `codex`: both succeed, exit 0.
- `claude-code`'s `session-start` runs the crash sweep, resolves the scope from `scope_map`,
  and prints a brief; exit 0.
- `claude-code` claims a task with declared write intent (`paths`); the lease records
  `session_ref` and `base_head` from the session's own last-observed git HEAD.
- `codex`'s `session-start` in the same scope sees `claude-code`'s claim in its own brief's
  "Open claims" section.
- `codex` tries to claim the same task and is correctly refused with `CLAIM_HELD`, naming the
  holder.
- `claude-code` makes a real commit; `post-tool-use` on the `git commit` Bash call journals it
  with the real commit subject, linked to its sha.
- `claude-code`'s `stop` hook, with `turns_threshold` lowered to 1 for the test, blocks once
  with the exact nudge reason text from PRD-hooks-v5 section 6.
- The agent responds as instructed: writes a handoff. A second `stop` right after does not
  block (the loop guard and the recent-handoff check both hold).
- `claude-code`'s `session-end` writes a mechanical journal entry (client, duration, branch,
  HEAD, changed-file count) and mechanically releases the earlier claim, since HEAD had moved
  past `base_head` and the working tree was clean. The release's `changed_files` is correctly
  derived from the commit pointer `post-tool-use` recorded, with no `changed_files` supplied
  by hand.
- A `codex` session is forced 45 minutes silent (its `last_seen_hlc` set into the past
  directly); the next real `session-start` on the node finds and finalizes it
  (`state: ended, ended_by: sweep`), without disturbing the session that is actually running.
- A `bypass_patterns` entry matching the hook's real process `cwd` makes `session-start` exit
  0 with zero output and zero new database rows; this took two attempts to demonstrate
  correctly, since `/var/folders` on macOS is a symlink to `/private/var/folders` and
  `process.cwd()` reports the resolved path. Worth knowing if this test is ever rerun: use
  the resolved path in `bypass_patterns`, not the one `mktemp -d` prints.
- An agent-written proposed decision shows up under `ctxd review`; `--approve <ref>` moves it
  to active; approving it again correctly fails, since it is no longer proposed.
- `ctxd install-hooks --client claude-code --dry-run` and `--client codex --dry-run`, run on
  `m2/install-hooks-dry-run` directly (see above for why not on `m2/ctxd-review`), print the
  exact SPEC v6 9.4 and 9.5 configuration blocks and exit 0, writing nothing.

**Every hook path exits 0 except the intentional Stop block.** Confirmed structurally (the
conformance kit's own cross-check asserts this for every event and both adapters) and
observed directly in every step above. The deadline budget and its unit tests
(`withDeadline` in `test/unit/hooks-core.test.ts`) were not re-demonstrated live here, since
simulating a slow handler in a real process adds nothing the existing tests do not already
cover deterministically.

`npm run typecheck`, `npm test` (414 tests) and `npm run build` all pass clean on
`m2/ctxd-review` as of this writing.

## Known gaps, each already flagged in the code that has it

None of these are silent; each has a comment at its own call site pointing here.

- **Mechanical release's drift derivation** (`src/store/claim.ts`) only covers commit
  pointers from PostToolUse. The other half SPEC 7.5.4 asks for, working-tree changes from
  the latest PreCompact/Stop/SessionEnd checkpoint *file*, needs a data directory that
  neither `WriteContext` nor `RequestContext` carries from an MCP tool call. That is a
  separate, broader plumbing change.
- **The crash sweep's own mechanical release** (`src/hooks/crashSweep.ts`) still cannot
  verify a clean working tree for a session that crashed, since it has no live `cwd` to
  check. SessionEnd's mechanical release can, because it runs inside the real session.
- **PreCompact's `recovery` update** writes the checkpoint file but not a guessed `phase` or
  `last_request_summary`, since neither client's documented PreCompact payload carries one.
- **Review rules** (`scopes.review_policy`) are read and written directly, not through an
  event, matching the same pre-existing pattern in `ctxd grant` and `ctxd pool`. SPEC v6 10.4
  describes rules traveling through scope metadata events once sync exists (M3); this is a
  cross-cutting gap in all three commands, not something to fix for review rules alone.
- **Conflicted entries and auto-resolved entries** (`ctxd review`) are both artifacts of a
  concurrent event arriving from another node. Sync is M3. The queries are correct and will
  start returning rows the day sync lands; they are not stubs.
- **R7 (prompt-time hints on UserPromptSubmit)** has no handler. It is off by default per
  spec and needs a per-scope enable flag with no config surface yet.
- **Detached workers** (`ctxd worker <ticket>`, SPEC 9.7) do not exist. SessionEnd's work
  runs synchronously inside the hook's own deadline instead; a git check and one database
  write fit comfortably within it in the normal case, but a slow disk or a very large repo
  could change that calculus later.

## What the owner does next

Per the kickoff doc: review and merge the PRs above in the suggested order, resolving the
`SCHEMA_VERSION` renumbering as each sibling lands. Installing hooks for real, in a live
`~/.claude` or `~/.codex` configuration, is the owner's own step; this build only ever prints
what it would write.
