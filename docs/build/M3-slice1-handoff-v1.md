# M3 slice 1 handoff: feature flags

Branch `m3/feature-flags`, off `main`. Implements [Feature flags v1](../prd/components/PRD-feature-flags-v1.md)
in full and writes [Spec v8](../spec/SPEC-v8.md), per [M3-plan-v1](M3-plan-v1.md).

## What landed

- `src/config/flags.ts`: the flag registry (12 M1/M2 flags plus `hooks.prompt_search`),
  three-layer resolution (default, `[features]`, environment, last one wins), parent cascade,
  `isFlagOn`, `requireFlag` (FF-7's `NOT_ALLOWED` primitive, not yet called from a tool handler
  since no M1/M2 flag needs to refuse a call outright).
- Retrofit: `hooks` (master, checked in `ctxd hook`'s entry point before the database opens),
  `hooks.session_start`, `hooks.crash_sweep`, `hooks.nudge`, `hooks.checkpoint`,
  `hooks.commit_journal`, `hooks.session_end`, `hooks.path_guard`, `claims.mechanical_release`,
  `review.remembered_rules`, `metering`.
- `hooks.prompt_search` (default off): a new R7 handler (`promptSearchHandler` in
  `src/hooks/readMoments.ts`) reusing the existing FTS search engine, since a flag with no
  feature behind it can't pass FF-8's "turning it back on resumes" test. `docs/build/M3-plan-v1.md`
  states why this is a narrower exception than deferring `sync` to slice 2.
- `ctxd features` / `ctxd features set <name> on|off` (`src/cli/features.ts`).
- The server reloads `config.toml` live, but only re-parses and re-validates it when the file's
  mtime has actually changed (`src/server/mcp.ts`'s `currentFlags`), not on every request.

## Verification

- `npm run typecheck`, `npm run build`: clean.
- `npm test` (vitest): 493/493 pass. **Run with `CTXD_BYPASS` unset** (`env -u CTXD_BYPASS npx vitest run`):
  this sandbox's ambient shell sets `CTXD_BYPASS=1`, which makes the conformance suite's spawned
  `ctxd hook` subprocesses bypass every hook and fail for the wrong reason. Not a code issue; the
  conformance test's own `run()` helper now explicitly clears `CTXD_BYPASS` before spawning, so
  `npm test` is unaffected by the ambient variable going forward either way.
- `/simplify`: four parallel reviews (reuse, simplification, efficiency, altitude). Applied:
  `ctxd features` now calls `loadConfig` instead of reimplementing it; `offMeans` is now printed
  by `ctxd features` instead of being a dead field; `flags` is no longer threaded as a redundant
  parameter through `dispatch`/`dispatchWithDb` (it's derived from `config`, which was already
  being passed); five copy-pasted flag ternaries in `handlers.ts` collapsed into one `gated()`
  helper; `mcp.ts`'s per-request config reload now skips the full parse/validate when the file
  hasn't changed. Skipped, with reasons noted inline: making `flags` required (not optional) on
  the three context types would touch ~20+ pre-existing test fixture files outside this diff; a
  typed `FlagName` union for compile-time typo-safety on flag names, deferred as a minor nit.
- `/code-review`: one finding, fixed — `docs/spec/SPEC-v8.md` had carried the owner's real GitHub
  username into a new file from `SPEC-v7.md`'s copy, violating AGENTS.md's no-real-names rule.
  Fixed in the new file. **Not fixed, flagged for a separate hygiene pass**: the same real
  username appears, pre-existing, in `docs/spec/SPEC-v3.md` through `SPEC-v7.md`,
  `docs/prd/components/PRD-hooks-v2.md`, `PRD-hooks-v3.md`, `src/store/schema.ts`,
  `test/unit/scope.test.ts`, `test/unit/redact.test.ts` and `tools/claude-mods/ctxd-build/README.md`.
  AGENTS.md's sanitization override lets past spec versions be edited for exactly this, but
  touching eight files across M1 through M3's history is its own slice, not something to fold
  silently into a feature-flags PR.

## Owner steps / open items

- Review and merge this PR before slice 2 (sync protocol) branches from it.
- Consider the real-name hygiene pass above as its own small PR.
- A separate session named "M3-M6 kickoff plan" was seen idle in this same repo while this slice
  was built; worth checking it isn't duplicate work on the same milestone before both land PRs.
