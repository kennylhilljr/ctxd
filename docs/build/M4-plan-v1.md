# M4 plan v1

Written per `docs/build/M3-M6-kickoff-v1.md` section 2, in M4's first PR, the way M3's plan was
written in its own first PR. M3 itself is still in progress elsewhere (feature flags and sync
core are merged; conflict policies, purge propagation, cross-node claims, ACL-as-events and the
partition-test suite are not), built by other agents, not by this one. M4 does not depend on
sync being finished: its own scope (service install, startup integrity, backups, doctor, status,
detached workers, Tailscale docs) is single-node work, so it branches from current `main` rather
than waiting.

## Practice note

The kickoff doc describes combining a milestone's slices into `integration/m<n>` before one PR
into `main`. In practice, M3's own slices (PRs #26 and #28) each merged straight to `main` as
they landed, not through an intermediate integration branch. M4 follows that same practice: each
slice is its own branch and PR based on the previous slice (the same sequential-chain pattern M2
used for its hook lifecycle, since several of these slices touch the same small set of files),
targeting `main` directly. A short closing PR still ties the milestone off once slice 7 lands,
matching the spirit of "one integration point," even though it is not a separate branch this
time.

## Slices

| # | Slice | Branch | Base | What it closes |
|---|---|---|---|---|
| 1 | Startup integrity | `m4/startup-integrity` | `main` | SPEC v8 section 12: `PRAGMA quick_check`, refusing to start over a missing database that looks previously initialized, pointing to `ctxd doctor`/`ctxd restore` |
| 2 | `ctxd service` | `m4/service` | `m4/startup-integrity` | `install\|uninstall\|status`, a launchd agent from `deploy/launchd`, `plutil -lint` validated |
| 3 | Backups | `m4/backups` | `m4/service` | `ctxd backup`/`ctxd restore`, nightly `VACUUM INTO` + `age` encryption, 14 kept, optional `copy_to`; flags `backups`, `backups.copy` |
| 4 | `ctxd doctor` | `m4/doctor` | `m4/backups` | Every check in Spec 12 |
| 5 | `ctxd status` / `ctxd statusline` | `m4/status` | `m4/doctor` | Health, scope, claims, sync; the one-line form, under 50 ms; flag `statusline` |
| 6 | `deploy/tailscale.md` | `m4/tailscale-docs` | `m4/status` | Exact `tailscale serve` commands (never Funnel) and the hub checklist; docs only |
| 7 | Detached workers | `m4/detached-workers` | `m4/tailscale-docs` | `ctxd worker <ticket>` (Spec 9.7); SessionEnd's work moved onto it, closing the M2 handoff gap |

Slices 1 through 6 are each a self-contained command or doc surface with no real overlap between
them; they are still sequenced (not parallelized across agents) because slice 4 (`doctor`) reads
facts slices 1 to 3 establish (the integrity check, the service's install state, backup
presence), and keeping one agent's context across the whole chain is cheaper here than
re-deriving that context for parallel agents the way M2's wave-1 split did for larger, more
independent pieces. Slice 7 is last and built most carefully: it is the one slice that touches
the hook write path (`src/hooks/writeMoments.ts`, `src/cli/hook.ts`), the most contested files in
this build, and the one most likely to need a conflict resolution against whatever M3 slice lands
on `main` in the meantime (the same situation PR #27 hit against PR #26).

## Slice 7's scope, precisely

SPEC 9.7's detached-worker sequence: the hook writes an end marker or work ticket file
(atomic, SPEC 9.8), spawns `ctxd worker <ticket>` detached (new session, stdio closed), and exits
0; the worker takes the per-session lock, does the work, and removes the ticket. Moving
SessionEnd's work onto this closes the M2 handoff's "SessionEnd's work is specified to run in a
detached worker... this runs synchronously within the hook's existing deadline instead" gap, and
with it the related "drift from checkpoint files needs the data directory in the write context"
gap: a detached worker is a full `ctxd` process with its own argv, so it can be given the data
directory directly, the way the hook's own `--data-dir`/`--config` flags already work, instead of
needing new plumbing through `WriteContext`/`RequestContext`.

Not reopened here: the crash sweep's own inability to check a crashed session's working tree, and
PreCompact's inability to record a phase or request summary, are both left exactly as
`docs/build/M2-handoff-v1.md` and Spec v8 already describe them: documented limits, no fix
planned.

## Definition of done per slice

Unchanged from M1 through M3: typecheck and tests pass, a live check against the real built CLI
(scratch config/data directories only, per the kickoff doc's stop conditions; never
`~/.config/ctxd`, real launchd jobs or real Tailscale configuration), a self-review of the diff,
then a commit, push and PR with the verification written into its description.

## Exit

A fresh install on a scratch home folder passes `ctxd doctor`; a backup and restore round-trip in
the tests; the service plist lints (`plutil -lint`) and loads under a test label. The owner's own
steps, same as every milestone: installing the real service (already done once, by hand, during
the earlier setup session; slice 2 gives it a proper, idempotent command), running real
`tailscale serve`, and the two-week unattended run.
