# Spec v10 draft

Working notes collected while the completion kickoff ([docs/build/completion-kickoff-v1.md](../build/completion-kickoff-v1.md)) runs. M7 slice 8 folds this into the numbered Spec v10; until then each workstream appends its own section here instead of editing Spec v9 directly.

## W4: scheduled backups

`ctxd backup` worked but nothing ran it unattended.

- **`ctxd backup schedule install|uninstall|status`** (`src/cli/backup-schedule.ts`): a launchd agent running `ctxd backup` on `[backup] schedule` (new config field, "HH:MM" local, default `03:15`), via `StartCalendarInterval`, not `RunAtLoad`/`KeepAlive` (this is a once-daily job, not a long-running service). Mirrors `src/cli/service.ts`'s plist generation and reuses its `lintPlist`.
- **`ctxd doctor`** gained a "backup age" check: the newest `*.db.age` file's mtime in `backups/`, warning past 36 hours. Informational (always passes) when `backups` is off. Fails outright with no backups yet, since that is itself worth surfacing.
- No new feature flag: both the schedule and the doctor check respect the existing `backups` flag, as the kickoff plan specifies.
- Installing the schedule for real, and running it unattended, are the owner's steps (section 3 of the kickoff plan already lists this).
