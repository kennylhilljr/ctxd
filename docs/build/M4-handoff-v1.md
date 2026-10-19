# M4 handoff v1

Written at the end of the M4 build described in `docs/build/M4-plan-v1.md`. Seven slices, each
its own branch and PR, sequentially chained per that plan's own stated practice (M3's slices
merged straight to `main` as they landed rather than through an intermediate integration
branch; M4 followed the same practice). This document is slice 8, the closing handoff that
plan's own "Practice note" called for, committed onto the last branch rather than a new one.

## What landed

| # | Slice | PR | Branch | Base | Status as of this writing |
|---|---|---|---|---|---|
| 1 | Startup integrity | #29 | `m4/startup-integrity` | `main` | Merged to `main` |
| 2 | `ctxd service` | #30 | `m4/service` | `m4/startup-integrity` | Merged into its base |
| 3 | `ctxd backup` / `ctxd restore` | #31 | `m4/backups` | `m4/service` | Merged into its base |
| 4 | `ctxd doctor` | #33 | `m4/doctor` | `m4/backups` | Merged into its base |
| 5 | `ctxd status` / `ctxd statusline` | #35 | `m4/status` | `m4/doctor` | Open |
| 6 | Hub checklist in `deploy/tailscale.md` | #36 | `m4/tailscale-docs` | `m4/status` | Open |
| 7 | Detached workers for SessionEnd | #37 | `m4/detached-workers` | `m4/tailscale-docs` | Open |
| 8 | This document | | `m4/detached-workers` | | Open (same branch as #37) |

Only slice 1's PR targets `main` directly; every later slice's PR targets its immediate
predecessor, the same stacking M2's hook lifecycle used. Slices 2 through 4 are already merged
into their own predecessor branches (#30 into `m4/startup-integrity`, #31 into `m4/service`,
#33 into `m4/backups`), but that only advances those branches, not `main` itself: `main` still
has only slice 1 as of this writing. `m4/detached-workers` (this branch) is the one branch that
actually contains all seven slices in sequence.

## Merging

**The one remaining step to land all of M4:** `main` needs `m4/detached-workers` merged into
it. The simplest path is to change PR #37's base to `main` (or open one fresh PR from
`m4/detached-workers` to `main`) rather than relying on #35 and #36 each separately reaching
`main` first, since `m4/detached-workers` already carries every commit from slices 2 through 7
on top of slice 1. PRs #35 and #36 can then be closed without merging (their diffs are already
included), or merged in order first if a slice-by-slice `main` history is preferred.

**Checked, not assumed:** a local dry-run merge of `origin/main` into `m4/detached-workers`
(`git merge --no-commit --no-ff`, then `git merge --abort`, touching nothing) applied cleanly
with no conflicts, confirming M4's own files never overlap with M3 slice 3's (PR #32, already
on `main`): that PR touches `src/store/schema.ts`, `src/sync/apply.ts`, `src/sync/pull.ts`,
`src/store/review.ts`, `src/store/hygiene.ts`, `src/store/materialize.ts`,
`src/store/rebuild.ts`, `src/core/ids.ts`, `src/core/kinds.ts` and `src/cli/sync.ts`; this
build deliberately never edited any of them (see "Known gaps" below for why doctor, status and
the detached-worker slices each avoided `schema.ts` and `server/sync.ts` specifically).

## Exit check

`npm run typecheck`, `npm test` (556 tests across 47 files) and `npm run build` all pass clean
on `m4/detached-workers` as of this writing. Beyond the unit suite, each slice was separately
verified live against the real built CLI on scratch config and data directories (never real
`~/.config/ctxd`, real launchd jobs or real Tailscale configuration), summarized here rather
than repeated slice by slice:

- `ctxd server` refuses to start over a missing or corrupted database, pointing to `ctxd
  doctor` and `ctxd restore`; it starts normally over a healthy one.
- `ctxd service install|status|uninstall` installed, reported, and tore down a real `launchd`
  job under a scratch label and path, confirmed with `plutil -lint`, without ever touching the
  real `dev.ctxd.server` job already running on this machine.
- `ctxd backup` and `ctxd restore` round-tripped a real database through a fake `age` stand-in
  (this machine has no real `age` binary installed; see slice 3's PR for why that is the
  correct scope boundary, not a gap), confirmed by `PRAGMA quick_check` on the restored file.
- `ctxd doctor` correctly failed only the hook-installation check on a fresh scratch `HOME`,
  then passed all seven checks once hooks were installed into that same scratch `HOME`.
- `ctxd status` / `ctxd statusline` correctly flipped between the down and up health indicators
  as a scratch server was stopped and started, showed a bound scope with `brief ✓` once one was
  added, and printed nothing once the `statusline` flag was turned off.
- The full detached-worker pipeline ran for real: a real `ctxd hook session-end` wrote a ticket
  file, a real detached `ctxd worker` picked it up within about a second and wrote the
  mechanical journal entry with real git facts, and a hand-planted stale ticket was correctly
  swept and processed by the next `ctxd hook session-start`'s crash sweep.

## Known gaps, each already flagged in the code or docs that has it

None of these are silent; each has a comment or a doc note at its own call site pointing here.

- **Peer reachability's "last sync age"** (SPEC section 12, `ctxd doctor`) cannot be reported:
  `sync_state` (M3) stores only `through_seq` per peer, no timestamp of when that was last
  updated. `ctxd doctor`'s own output says so directly rather than guessing.
- **`ctxd statusline`'s "unsynced" count** is `0` when there is nothing to sync (sync off, or no
  peers) and reported as untracked otherwise, for the same underlying reason: the sync server
  never records what it has already served each peer. Fixing this needs a new watermark, either
  a column on `sync_state` or a new table, in files M3 was actively changing throughout this
  build (`src/store/schema.ts`, `src/server/sync.ts`); deliberately left to a future slice
  rather than risked as a merge conflict or invented as a fake number.
- **`ctxd statusline`'s "brief available"** is a current-state check (would a session starting
  now, in this scope, with the hooks flags as they stand, get a brief), not a record of whether
  any specific past session's brief actually succeeded, for the same reason: that would need a
  new `sessions` column.
- **`ctxd node adopt`** (SPEC section 12's migration checklist, documented in
  `deploy/tailscale.md`) does not exist. The checklist documents the manual `node.name` edit as
  the only supported path to migrate to a new hub today.
- **Nightly backup scheduling** has no launchd calendar job. `ctxd backup` (slice 3) is the
  complete mechanism; slice 3's own PR named the hub checklist (slice 6) as where the cron-style
  trigger would be documented, but slice 6 ended up scoped to the Air settings and migration
  checklist SPEC section 12 actually lists, neither of which mentions a calendar job by name. A
  `StartCalendarInterval` launchd agent invoking `ctxd backup` nightly is still undocumented and
  unbuilt; this is the real gap between "the mechanism exists" and "the Air actually backs
  itself up unattended," and it is the most actionable item for whoever picks up M5.
- **The crash sweep's own mechanical release and journal entry**, for a session that crashes
  without ever reaching SessionEnd (so no ticket is ever written), still cannot run: a crashed
  session has no live `cwd` to check "working tree clean" against or derive git facts from. This
  is unchanged from the M2 handoff; detached workers (this milestone) close the gap for a
  session that *does* reach SessionEnd, not this one.
- **PreCompact's `recovery` update** still only writes the checkpoint file, not a guessed
  `phase` or `last_request_summary`, since neither client's documented PreCompact payload
  carries one. Unchanged from M2.

## What the owner does next

Per the kickoff doc: merge `m4/detached-workers` into `main` (see "Merging" above), then the
owner's own real-machine steps, same division as every milestone: install the real launchd
service with `ctxd service install` (superseding the by-hand setup from the earlier session),
run the real `tailscale serve` command from `deploy/tailscale.md`, set a real `[backup]
age_recipient` in `config.toml` and run `ctxd backup` by hand until a scheduled trigger exists,
and the two-week unattended run the M4 plan's own exit criteria ask for.
