# W11 handoff v1: one launchd helper, and two bugs fixed once

From a review of [W8](W8-handoff-v1.md) (PR #63, merged). The owner approved extracting the shared
helper so the two defects it found could be fixed in one place rather than three.

## Commits

- `(this branch)` `W11: one shared launchd helper, with reinstall and absolute-path fixes`

Branch `done/w11-launchd-helper`, based on `main` after `#63` merged.

## What the review got right, and what it got wrong

Two of its five items were real defects, and both are fixed. Three did not survive checking, which
is worth recording so nobody re-files them:

- **Item 1 (retarget and rebase `#63`) was moot.** `#63` was already merged; `main`'s tip is its
  merge commit. Rebasing a merged branch would also have meant a force-push.
- **Item 2 (relocate the docs) was already done.** The restructure carried W8's section 7 rewrite
  into `docs/runbooks/mobile-inbox-deploy-v1.md`, which already had the `ctxd inbox schedule`
  text.
- **Item 4's diagnosis was wrong in detail, right in consequence.** It described `launchctl load`
  on a loaded label as a no-op. It is not: it prints `Load failed: 5: Input/output error` *and
  exits 0*, verified directly against a scratch label on this macOS version. So the old code was
  not quietly skipping work, it was discarding an error launchd had actually reported, because the
  exit status looked fine. Same user-visible outcome (the reinstall silently did nothing), but the
  difference is worth knowing: install now also checks `load`'s output instead of trusting its
  exit code, so a genuinely refused load gets reported rather than swallowed.
- **Item 4's proposed test was not possible as written.** It asked for a test that "reinstalling
  with a different interval leaves the loaded job on the new interval". `launchctl list <label>`
  does not report the schedule at all; it reports `Label`, `OnDemand`, `LastExitStatus`,
  `Program` and `ProgramArguments`. The test therefore proves the reload reached launchd by
  changing an *argument* between installs and asserting on what launchd holds, and checks the new
  interval in the plist on disk. Same guarantee, through something actually observable.

## Delivered

**`src/cli/launchd.ts`**, the one place that builds, lints, loads, unloads and inspects a ctxd
launchd agent. The three installers (`ctxd service`, `ctxd backup schedule`, `ctxd inbox
schedule`) are now thin wrappers that keep every one of their existing exports and signatures,
contributing only what actually differs: the subcommand to run, the log name, and one schedule
(`{kind: "keepalive"}`, `{kind: "calendar", hour, minute}` or `{kind: "interval", seconds}`).

**Fix 1, reinstall applies.** Install unloads before loading, ignoring the failure when nothing
was loaded, then inspects `load`'s own output. Before this, changing `[inbox] schedule_minutes` or
`[backup] schedule` and reinstalling rewrote the plist and left the running job exactly as it was,
reporting success. W8's handoff and the deploy runbook both told the owner to do precisely that,
so the advice was wrong too; both are corrected.

**Fix 2, absolute paths.** `--config` and `--data-dir` are resolved before they are written into
`ProgramArguments`. launchd gives a job no useful working directory, so a relative path baked into
a plist would not resolve when the job actually ran.

**Why now and not in W7.** W7's plan listed this extraction but deliberately left it unbuilt,
because only one instance existed and generalizing from one example guesses wrong. W8 made it two,
and these two bugs needing the same fix in three files settled it. That is the case the plan said
to wait for.

## Verification

`npm run typecheck`, `npm run build` and `npm test`: 859 of 859 tests passing across 81 files.

The strongest signal is what was *not* changed: `service.test.ts` (6), `backup-schedule.test.ts`
(8) and `inbox-schedule.test.ts` (9) all pass untouched against the rewritten modules, which is
what makes this a behavior-preserving refactor rather than a rewrite.

New `test/unit/launchd.test.ts` (9 tests): each schedule kind emits the right keys and only those
(an interval job must never carry `RunAtLoad`/`KeepAlive`, which would mean "run now, then restart
forever"); a bad interval is refused rather than written; relative `--config`/`--data-dir` become
absolute and the relative forms do not survive into the plist; an already-absolute path is left
alone; log files follow `logName`; **a reinstall with changed arguments and a changed interval is
really applied** (the regression test for fix 1, which fails without the unload); install, status
and uninstall round trip; uninstall of nothing is a no-op; a never-installed label reports neither
installed nor loaded.

Live, through the real CLI on a scratch instance: `ctxd service status`, `ctxd backup schedule
status` and `ctxd inbox schedule status` all work through the rewritten wrappers.

## What was not done and why

- **`install` was not run against the real `~/Library/LaunchAgents`.** Installing a real launchd
  job is an owner step under the kickoff's stop rules. The new tests do drive the real `launchctl`
  and `plutil`, but against a scratch label and path, which is where the reinstall fix is proven.
- **No change to what the three commands expose.** Same subcommands, same output, no new flags.
- **The four pre-existing `--noUnusedLocals` warnings** in `pool.ts`, `writeMoments.ts`,
  `claim.ts` and `rebuild.ts` are untouched: unrelated files, and that flag is not part of the
  project's `tsconfig.json`.

## Owner steps

1. Merge whenever; nothing else depends on it.
2. **Worth knowing:** `ctxd service status` on this machine reports the real `dev.ctxd.server`
   agent installed and loaded with `last exit 256`, which is wait-status for exit code 1. That
   predates this change and is untouched by it, but the installed server does appear to be
   failing; `~/Library/Logs/ctxd/server.err.log` is where to look.
3. If you installed a schedule before this lands and later changed its interval, reinstall it once
   after merging: the earlier reinstall did not take effect.
