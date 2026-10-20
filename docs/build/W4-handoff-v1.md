# W4 handoff v1

## Commits

- One commit on this branch: `ctxd backup schedule`, `ctxd doctor`'s backup-age check, `[backup] schedule` config field.

Branch `done/w4-scheduled-backups`, on top of `main`. Nothing was pushed and no pull request was opened; that is the owner's step per the kickoff plan.

## Delivered

`ctxd backup schedule install|uninstall|status` (`src/cli/backup-schedule.ts`) installs a launchd agent that runs `ctxd backup` on `[backup] schedule` (a new config field, "HH:MM" local, default `03:15`), using `StartCalendarInterval` rather than `RunAtLoad`/`KeepAlive`: this is a once-daily scheduled job, not a long-running service, so it should not restart immediately if it exits (as a `KeepAlive` service would) or run again at every login. The module mirrors `src/cli/service.ts`'s own plist generation closely and reuses its `lintPlist` rather than duplicating it.

`ctxd doctor` gained a "backup age" check: the newest `*.db.age` file's mtime under `backups/`, warning past 36 hours. It passes informationally when `backups` is off, and fails (rather than passing silently) when `backups` is on but no backup has ever been written, since that is itself the gap worth surfacing.

No feature flag was added: both the schedule and the doctor check respect the existing `backups` flag, as the kickoff plan specifies.

Spec changes are in [docs/spec/SPEC-v10-draft.md](../spec/SPEC-v10-draft.md), which M7 slice 8 folds into the numbered Spec v10.

## Verification

`npm run typecheck` and `npm test`: 747 of 747 tests passing across 66 files.

- `test/unit/backup-schedule.test.ts` (new): the plist's content (label, binary, entry point, `StartCalendarInterval` hour/minute, log paths, no `RunAtLoad`/`KeepAlive`), that `--config`/`--data-dir` only appear in the plist's `ProgramArguments` when given, that `plutil -lint` accepts it, and the install/status/uninstall round trip against a scratch `LaunchAgents` directory and a scratch label — the same pattern `test/unit/service.test.ts` already uses for `ctxd service`, so these tests never touch the real `~/Library/LaunchAgents` or load a real job.
- `test/unit/doctor.test.ts`: four new cases for `checkBackupAge` — informational pass when `backups` is off, fail with no backups yet, pass with a fresh backup, and warn past the stale threshold (asserted with a file whose mtime is set 48 hours in the past via `utimesSync`).
- `test/unit/backup.test.ts` and `test/unit/service.test.ts` still pass unchanged, confirming the new `schedule` subcommand branch in `runBackupCommand` does not disturb the existing `ctxd backup`/`ctxd restore` behavior.

Not run: a real `launchctl` job actually firing at its scheduled time (there is no way to fast-forward launchd's clock in a unit test); the round-trip tests confirm install/status/uninstall mechanics against a real `launchctl`/`plutil`, not that the job fires correctly at 03:15.

## What was not done and why

Nothing from W4's scope was skipped. No CLI-level test exercises `ctxd backup schedule install` through `runBackupCommand` itself (only the underlying `installBackupSchedule`/`backupScheduleStatus`/`uninstallBackupSchedule` functions are tested directly): doing so without a way to override the real `home`/`label`/`path` from the CLI's own `run()` entry point would mean either touching the real `~/Library/LaunchAgents` or adding an override mechanism the analogous `ctxd service` command deliberately does not have either. This matches that existing precedent rather than being a new gap.

## Owner steps

- Merge this branch (owner's step, per the kickoff plan's section 0).
- Set `[backup] age_recipient` and run `ctxd backup` by hand once (already listed as owner step 3 in the kickoff plan), then install the schedule for real: `ctxd backup schedule install`.
- `[backup] schedule` defaults to `03:15`; change it in `config.toml` if a different daily time is wanted.
