# W8 handoff v1: unattended mobile inbox pulls

The first of [W7's](W7-plan-v1.md) approved follow-ups ("Scheduling `ctxd inbox pull`"), approved
by the owner on 2026-10-21.

## Commits

- `3dc5332` `W8 slice 1: ctxd inbox schedule, for unattended mobile inbox pulls`
- this handoff

Branch `done/w8-inbox-schedule`. It was first cut from `done/w1-mobile-inbox` (PR #60), since the
command it schedules only existed there; W1 merged while this was open, so `main` has been merged
back in (one merge commit) and the PR now targets `main` directly. That merge also moved this
change's documentation: `main` had meanwhile split the spec into an L3 HLD plus L4 LLDs and
contracts, so what this originally added to `SPEC-v10.md` section 17.6 now lives in
[LLD: Mobile inbox](../lld/LLD-mobile-inbox-v1.md) 17.6 and the
[CLI contract](../contracts/cli-reference-v1.md).

## Delivered

**`ctxd inbox schedule install|uninstall|status`** (`src/cli/inbox-schedule.ts`): a launchd agent
running `ctxd inbox pull` every `[inbox] schedule_minutes` (new config field, default 15, valid 1
to 1440). Writes `~/Library/LaunchAgents/dev.ctxd.inbox-pull.plist`, lints it with `plutil`, loads
it with `launchctl`; `status` reports installed, loaded and last exit status; `uninstall` unloads
and removes it, and is a harmless no-op when nothing is installed. The installed job inherits
whichever `--config` and `--data-dir` the installing invocation was given, so a scratch instance
schedules itself rather than the default one.

**Deliberately a near-twin of W4's `src/cli/backup-schedule.ts`**, down to the function names. The
two differ only in what they launch and in how launchd is told when to run it (`StartInterval`
here, since inbox capture wants "every few minutes"; `StartCalendarInterval` there, since a backup
wants "once a day at 03:15"). Only `lintPlist` is shared today. **W4 has since merged, so this is
the second concrete instance W7's plan said was needed before generalizing**: extracting one
shared plist helper is now a small, obvious, test-covered refactor. It is deliberately not done
here, because the owner approved this item and not that one; it stays listed in
[W7's plan](W7-plan-v1.md).

**Safe with the flag off.** `ctxd inbox pull` already reports `mobile_inbox` off and exits 0
without a single network call, so a loaded job on a machine with the flag off does nothing. The
plist never sets `RunAtLoad` or `KeepAlive`: on an interval job those would mean "run now, then
restart forever" rather than "every 15 minutes". Both are asserted in the tests, since getting
that wrong would be silent and expensive.

Spec v10 section 17.6 and the CLI reference gained the subcommand and the new config field. The
deploy runbook's section 7 was rewritten: it previously told the owner the scheduler did not exist
and to hand-roll a `launchd` or cron entry.

## Verification

`npm run typecheck` and `npm test`: 820 of 820 tests passing across 77 files (9 new, in
`test/unit/inbox-schedule.test.ts`): the minutes-to-seconds conversion and its range refusals,
plist contents (including the `RunAtLoad`/`KeepAlive`/`StartCalendarInterval` negative
assertions), `plutil` acceptance, a full install/status/uninstall round trip through real
`launchctl`, a never-installed label, and a no-op uninstall. Every test uses a scratch `home`,
scratch `path` and the test-only label `dev.ctxd.inbox-pull.test`, so none of them touch a real
installed schedule.

Also run live against a scratch `ctxd init` instance: confirmed `ctxd init` serializes
`schedule_minutes = 15`, `ctxd inbox schedule status` correctly reports not-installed against the
real plist path, and an unknown subcommand prints usage and exits 1.

## What was not done and why

- **`install` was never run against the real `~/Library/LaunchAgents`.** That is an owner step
  (the kickoff's stop rules cover real launchd jobs); the scratch-label tests cover the real
  `launchctl` load and unload paths instead.
- **No `doctor` check for inbox pull freshness.** Unlike W4's backup-age check, nothing persists a
  "last successful pull" timestamp, so there is no local fact to report yet. Adding one means a
  schema change; not worth it on its own, and `ctxd inbox schedule status`'s `LastExitStatus`
  already answers "did the last run fail".
- **Changing the interval still means reinstalling**, since launchd reads it from the plist. Noted
  in the runbook rather than solved with a watcher.

**Corrected by [W11](W11-handoff-v1.md), after review:** reinstalling did not actually work. This
handoff and the runbook both told the owner to change `schedule_minutes` and reinstall, but
`launchctl load` on an already-loaded label prints `Load failed: 5` *and exits 0*, so the install
rewrote the plist, swallowed the complaint and left the old interval running. W11 reloads instead,
checks `load`'s output rather than its exit code, writes `--config`/`--data-dir` as absolute paths,
and moves all of this into one shared launchd helper that `ctxd service` and `ctxd backup schedule`
use too, so the same two bugs are fixed once rather than three times.

## Owner steps

1. Merge W1 (#60) first; this branch is stacked on it.
2. Set `[inbox] schedule_minutes` if 15 is wrong for you, then `ctxd inbox schedule install`.
   Safe to do before turning `mobile_inbox` on.
3. Once W4 (#57) has also merged, W7's "shared scheduling abstraction" item is ready: two real
   instances now exist to generalize from.
