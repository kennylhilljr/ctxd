# W5 handoff v1

## Commits

- `b0271dd` `W5 slice 1: approval timestamps`
- `d26b927` `W5 slice 2: crash sweep release`
- `446c67b` `W5 slice 3: list mode ordering`
- `42ddebf` `W5 slice 4: automatic skill sync`
- `b3a8b1d` `W5 slice 5: confirm Codex's skills folder`

Branch `done/w5-correctness-gaps`, five commits on top of `main` at `5b4063f`. Nothing was pushed and no pull request was opened; that is the owner's step per the kickoff plan.

## Delivered

**Slice 1 (M5 handoff gap).** `entries.approved_by`/`approved_hlc` are now set on the review path (`ctxd review --approve`) and at creation for an auto-accept review rule match; a write that was never under review (human direct, or a kind whose unreviewed default is already `active`) leaves both NULL, since there was no approval to record. The weekly digest's "decisions made" section reads `approved_hlc`, falling back to `created_hlc` for a decision that was active from creation.

**Slice 2 (M2/M4 handoff gap).** `sessions.cwd` (schema v20) is recorded once at SessionStart and kept for the session's life. The crash sweep now runs the same mechanical journal entry and claim release a real SessionEnd runs, for a finalized session that has a recorded `cwd` and scope, gated behind the existing `claims.mechanical_release` flag. A session with no recorded `cwd` (a pre-slice row) or no scope is only finalized, exactly as before.

**Slice 3 (M5 handoff gap).** `query: "*"` (list mode) now lists strictly by time whatever the `importance` flag says. The SQL already ordered by time; the bug was a later JS re-sort by `_score`, which equaled the entry's importance in list mode. List-mode rows now get `_score = 0`, so the sort is a no-op and the SQL's time order survives. The scope fan-out multipliers and the flagged-entry penalty are relevance adjustments and now apply only to scored (non-`"*"`) search.

**Slice 4 (M5 handoff gap).** A write to a skill entry (`context_write`) or an approval of a proposed one (`ctxd review --approve`) schedules a native skill sync, when `skills.native_sync` is on, through the same ticket-plus-detached-worker mechanism SessionEnd uses: a `skill-sync` ticket under `sessions/`, picked up by `ctxd worker` or, if left behind, the next crash sweep. The actual folder write never runs inline in the write path or inside a hook's time budget. The trigger fires on the entry's kind alone, not on its resulting status, since the sync itself only ever selects `active` skills.

**Slice 5 (M5 handoff gap, Spec open issue 16, PRD Q10).** Codex's personal skills folder is confirmed: `~/.agents/skills` (`$HOME/.agents/skills`), read directly from the `openai/codex` source at the pinned minimum version `rust-v0.145.0` (`codex-rs/core-skills/src/loader.rs`: the user-scoped skill root is `home_dir.join(".agents").join("skills")`). SKILL.md there needs just `name` and `description` frontmatter, matching ctxd's own requirement exactly, so no format change was needed. `clientSkillsDir("codex", ...)` no longer returns null; `ctxd skills sync --client codex` and `ctxd skills import --from codex` both work now. [PRD-skills-v2.md](../prd/components/PRD-skills-v2.md) records this.

**Accepted limitation, no work.** PreCompact still cannot record a phase or last-request summary: neither Claude Code's nor Codex's documented PreCompact payload carries one, only `session_id`/`cwd`/`trigger`. Noted once in [Spec v10 draft](../spec/SPEC-v10.md) rather than every milestone's handoff.

Spec changes for all five slices are in [docs/spec/SPEC-v10-draft.md](../spec/SPEC-v10.md), which M7 slice 8 folds into the numbered Spec v10.

## Verification

Each slice ran `npm run typecheck` and `npm test` before its commit. The final run on this branch: typecheck clean, 754 of 754 tests passing across 66 files (macOS; the `plutil` checks the kickoff plan's "known at the start" section flagged are part of this count and pass here). New or rewritten tests per slice:

- Slice 1: `test/unit/review.test.ts` (resolve path and auto-accept path both set `approved_by`/`approved_hlc`; a plain unreviewed write leaves both NULL), `test/unit/digest.test.ts` (rewritten: list mode by `approved_hlc`, fallback to `created_hlc`, excludes an approval outside the week).
- Slice 2: `test/unit/db.test.ts` (migrates a version-19 database by adding `sessions.cwd`), `test/unit/hooks-core.test.ts` (records `cwd` at SessionStart, keeps it across later events), `test/unit/crash-sweep.test.ts` (mechanical journal entry and release for a crashed session, the off state, no recorded `cwd`, no scope).
- Slice 3: `test/unit/search-importance.test.ts` (rewritten: list mode strictly by time in both `importance` flag states).
- Slice 4: `test/unit/tools-write.test.ts` (new: the trigger, the off state, a non-skill write), `test/unit/skills.test.ts` (`scheduleSkillSync`, `runSkillSyncTicket` on and off), `test/unit/review.test.ts` (`resolveEntry` returns `kind`).
- Slice 5: `test/unit/skills.test.ts` (`clientSkillsDir`, `syncSkillsForClient` and `importSkillsFrom` all exercised for `codex`; the old "codex is unsupported" test removed since it asserted the now-fixed behavior).

Not run: a live Codex CLI session actually reading from `~/.agents/skills` (no Codex installation in this environment); that is the owner's first real-machine confirmation, same caveat the kickoff plan's section 3 already carries for other native integrations.

## What was not done and why

Nothing from W5's five listed slices was skipped. The one explicitly accepted limitation (PreCompact) is documented above and in the Spec v10 draft, not built, by the kickoff plan's own instruction.

## Owner steps

- Merge this branch (owner's step, per the kickoff plan's section 0).
- No new feature flag was added; slices 2 and 4 reuse `claims.mechanical_release` and `skills.native_sync`, both already registered. Nothing needs enabling for these fixes to take effect, since both flags already default the way the kickoff plan's tracking expects.
- First real confirmation that Codex actually reads skills from `~/.agents/skills` on the owner's machine, once Codex is installed there (W5.5 is confirmed from the `openai/codex` source, not from running Codex itself).
