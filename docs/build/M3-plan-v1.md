# M3 plan v1

Written per `docs/build/M3-M6-kickoff-v1.md` section 1, in M3's first PR. Covers feature flags
(one slice) and replication (seven slices), each its own branch and PR, each branched from the
previous one in the same way M2's sequential chain was (`docs/build/M2-handoff-v1.md`): these
slices touch a shared, small set of files (config, hook core, the write path, the server) and
conflict risk outweighs parallelism.

## Slices

| # | Slice | Branch | Base | What it closes |
|---|---|---|---|---|
| 1 | Feature flags | `m3/feature-flags` | `main` | PRD-feature-flags-v1 in full; Spec v8; retrofits every M1/M2 flag; `hooks.prompt_search` plus a minimal R7 handler |
| 2 | Sync listener and pull protocol | `m3/sync-protocol` | `m3/feature-flags` | Spec 7.1; `127.0.0.1:7412`, peer tokens, `/v1/pull`, `/v1/notify`, watermarks, `ctxd node add-peer\|revoke`, `ctxd sync`, flags `sync`/`sync.serve` |
| 3 | Policy filter and apply | `m3/sync-apply` | `m3/sync-protocol` | Spec 7.2, 7.3; replication policy (`all`/`home`/`local`); fast-forward, already-known, pending-parent and conflict-policy apply |
| 4 | Conflict policies, siblings, review | `m3/sync-conflicts` | `m3/sync-apply` | Spec 7.4; per-part conflict policies; `entry_siblings`; `conflicted` status; surfacing both in `ctxd review` |
| 5 | Purge propagation | `m3/sync-purge` | `m3/sync-conflicts` | Spec 7.6.6 step 3; stripping late arrivals for an already-purged entry on receipt |
| 6 | Claims across nodes | `m3/sync-claims` | `m3/sync-purge` | Spec 7.4's claim rows; tentative claims while offline; deterministic tie-break; `lost` leases; sync-origin overlap detection |
| 7 | ACL and scope metadata as events | `m3/sync-acl-events` | `m3/sync-claims` | Spec 7.2; review rules, grants and pool changes travel as `acl`/scope-metadata events in `_system` instead of direct table writes (closes the M2 handoff gap in `src/cli/grant.ts`, `src/cli/pool.ts`, `src/store/review.ts`) |
| 8 | Freshness and property tests | `m3/sync-freshness` | `m3/sync-acl-events` | Spec 10.2; sync freshness in brief headers, the stale-sync notice; the N-node partition property suite; two real servers converging end to end |

Slice 1 is this PR. Slices 2 to 8 follow in order; each is the stated milestone exit criterion's
own piece, so M3 is not done until slice 8's property suite and two-server convergence test both
pass. The integration branch `integration/m3` combines all eight once slice 8 lands, the same way
`integration/m1-m2` did.

## Slice 1: feature flags

**Registry** (`src/config/flags.ts`): one array of flag definitions (name, default, milestone,
description, off-behavior, optional parent), covering every M1/M2 flag in
[PRD-feature-flags-v1](../prd/components/PRD-feature-flags-v1.md) section 4 plus
`hooks.prompt_search`. `sync` and `sync.serve` are **not** added here; they are registered in
slice 2 when sync itself lands, so the registry only ever lists flags whose feature already
exists. `hooks.prompt_search` is the one exception, and a narrow one: unlike `sync` (an entire
protocol, listener and conflict-resolution subsystem that does not exist in any form until slice
2), R7 was already fully specified in PRD-hooks-v5 section 7.2 and Spec v7's hooks table since M1;
the only things missing were the flag and the ~15 lines wiring the existing FTS search
(`src/search/fts.ts`, already used by `context_search` and the SessionStart brief) to
UserPromptSubmit. Adding the flag with no handler behind it would fail FF-8's "turning it back on
resumes correctly" test, so this slice finishes R7 rather than leaving the flag inert.

**Resolution.** Three layers (registry default, `[features]` in `config.toml`, then
`CTXD_FEATURE_<NAME>` with dots as underscores, `0`/`1`): last one wins. Parent flags
(`hooks.*` under `hooks`) are ANDed with their parent's own resolved value. `resolveFlags` returns
a plain `Map<string, boolean>` for hot-path checks; `resolveFlagsDetailed` additionally reports
which layer won, for `ctxd features`.

**Live reload.** Hooks already load `config.toml` fresh on every invocation (a new process per
call), so flag resolution there is live by construction. The long-running server re-stats
`config.toml` once per incoming request and only re-parses and re-validates it when the mtime has
actually changed, so a
flag flip takes effect on the next tool call with no restart and no file watcher.

**Retrofit.** Each M1/M2 flag gates exactly the behavior PRD-feature-flags-v1 section 4 describes
for it, at the narrowest call site that behavior lives at, not at the whole-event level, since
several flags share one event (`hooks.crash_sweep` and `hooks.session_start` both act inside the
SessionStart handler; `claims.mechanical_release` acts inside SessionEnd's handler alongside
`hooks.session_end`, independently of it):

- `hooks` (master): checked once in `ctxd hook`'s entry point, before the database opens, exactly
  where `CTXD_BYPASS` is already checked today.
- `hooks.session_start`: the SessionStart and SubagentStart brief.
- `hooks.crash_sweep`: the crash sweep call inside SessionStart.
- `hooks.nudge`: the Stop hook's block decision only (its checkpoint write is unconditional).
- `hooks.checkpoint`: PreCompact's checkpoint write only (Stop's own checkpoint write is a separate
  call site and stays unconditional, matching the PRD's off-behavior text for each flag).
- `hooks.commit_journal`: PostToolUse's commit-journal write (W4), whole handler.
- `hooks.session_end`: SessionEnd's journal entry and mechanical release, whole handler.
- `hooks.path_guard`: PreToolUse's block check.
- `hooks.prompt_search`: a new R7 handler on UserPromptSubmit (FTS search on the prompt, up to 3
  titles, additionalContext, skip silently on any failure), since a flag with nothing behind it
  cannot pass FF-8's "turning it back on resumes correctly" test.
- `claims.mechanical_release`: SessionEnd's `releaseCommittedLeases` call specifically.
- `review.remembered_rules`: `write.ts`'s `reviewedStatus` lookup; off means every rule is
  ignored and the kind/significance default status applies instead.
- `metering`: `server/mcp.ts`'s `tool_metrics` insert.

**`ctxd features`** (new CLI command, human-only by construction: a local file edit, reachable
only from the terminal, never from an MCP tool): no arguments lists every flag with its effective
value, source and description; `set <name> on|off` writes `[features]` in `config.toml` after
validating the name against the registry.

**NOT_ALLOWED primitive.** FF-7 needs a generic `requireFlag(flags, name)` that throws
`NOT_ALLOWED` with the exact hint text. No M1/M2 flag in this slice actually refuses a tool call
(each one changes behavior instead, which is what its off-behavior text says), so this slice adds
the helper and a unit test for its shape, and the first real call site arrives with `sync` in
slice 2.

**Tests:** every flag's off path inert (hooks exit 0 or skip exactly the documented behavior, with
the server down for the hooks that do not need it); `hooks` off makes zero database calls; flag
flipped back on resumes normally; `tools/list` byte-identical with every flag off; env overrides
config overrides default; parent cascade; `ctxd features set` round-trips through a real
`config.toml`.

## Slices 2 to 8

Each slice's own PR restates its piece of the bullet list in
`docs/build/M3-M6-kickoff-v1.md` section 1 in the same level of detail as slice 1 above, written
at the start of that slice's branch rather than all up front here, since slices 2 to 8 depend on
decisions slice 1 and each other make along the way (for example, slice 2 decides the exact
`sync_state` watermark shape that slices 3 to 8 all build on). This document is updated with a row
in the table above, not rewritten, as each slice's branch opens.
