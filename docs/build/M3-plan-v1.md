# M3 plan v1

Written per `docs/build/M3-M6-kickoff-v1.md` section 1, in M3's first PR. Covers feature flags
(one slice) and replication (seven slices), each its own branch and PR, each branched from the
previous one in the same way M2's sequential chain was (`docs/build/M2-handoff-v1.md`): these
slices touch a shared, small set of files (config, hook core, the write path, the server) and
conflict risk outweighs parallelism.

## Slices

Slices 2 and 3 from this document's first version (sync listener/protocol, and policy
filter/apply) are merged into one "sync core" slice below: the serving-side replication filter
(7.2) is inseparable from `servePull` itself (7.1 says the server's response is "filtered by the
replication policy for the requesting node"), and no meaningful test of the protocol exists
without both serving and a puller that can apply what it receives. The remaining six slices are
unchanged, renumbered.

| # | Slice | Branch | Base | What it closes |
|---|---|---|---|---|
| 1 | Feature flags | `m3/feature-flags` | `main` | PRD-feature-flags-v1 in full; Spec v8; retrofits every M1/M2 flag; `hooks.prompt_search` plus a minimal R7 handler |
| 2 | Sync core | `m3/sync-protocol` | `main` (slice 1 merged as PR #26 before this branched) | Spec 7.1, 7.2, 7.3 (fast-forward and already-known only); `127.0.0.1:7412`, peer tokens, `/v1/pull`, `/v1/notify`, watermarks, `ctxd node add-peer\|revoke`, `ctxd sync`, flags `sync`/`sync.serve`; the new `peers` table |
| 3 | Conflict policies, siblings, review | `m3/sync-conflicts` | `m3/sync-protocol` | Spec 7.4; per-part conflict policies (the concurrent and missing-parent rows of 7.3's table, deferred by slice 2); `entry_siblings`; `conflicted` status; surfacing both in `ctxd review` |
| 4 | Purge propagation | `m3/sync-purge` | `m3/sync-conflicts` | Spec 7.6.6 step 3; stripping late arrivals for an already-purged entry on receipt |
| 5 | Claims across nodes | `m3/sync-claims` | `m3/sync-purge` | Spec 7.4's claim rows; tentative claims while offline; deterministic tie-break; `lost` leases; sync-origin overlap detection |
| 6 | ACL and scope metadata as events | `m3/sync-acl-events` | `m3/sync-claims` | Spec 7.2; review rules, grants, pool changes and scope creation itself travel as `acl`/scope-metadata events in `_system` instead of direct table writes (closes the M2 handoff gap in `src/cli/grant.ts`, `src/cli/pool.ts`, `src/store/review.ts`, and the gap slice 2 found: named project scopes created independently on two nodes do not share a `scope_id` yet, so only `_me` converges until this slice lands) |
| 7 | Freshness and property tests | `m3/sync-freshness` | `m3/sync-acl-events` | Spec 10.2; sync freshness in brief headers, the stale-sync notice; the N-node partition property suite |

Slice 1 is PR #26, merged. Slice 2 is this PR. Slices 3 to 7 follow in order; each is the stated
milestone exit criterion's own piece, so M3 is not done until slice 7's property suite passes (the
two-real-servers-converge exit criterion is already demonstrated end to end in slice 2, for the
single-peer, no-conflict case; slice 7 extends it to N nodes and partitions). The integration
branch `integration/m3` combines all seven once slice 7 lands, the same way `integration/m1-m2`
did.

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

## Slice 2: sync core

**Peer identity and auth** (`src/store/schema.ts`'s new `peers` table, replacing the unused
`nodes.peer_token_hash`; `nodes` stays exactly-one-row, since many existing call sites do
`SELECT node_id FROM nodes LIMIT 1`). Each peer relationship needs two tokens, one per direction,
bootstrapped in three `ctxd node add-peer` calls since each side's token can only exist once the
other side has generated it (A adds B with no token; B adds A, supplying A's just-printed token;
A re-runs add-peer for B, supplying B's just-printed token; the third call updates only
`outgoing_token`, never regenerating the already-issued `incoming_token_hash`). `src/cli/node.ts`
and `src/server/auth.ts`'s `resolvePeerAuth` implement this.

**The sync listener** (`src/server/sync.ts`, a second HTTP server on `sync.listen`, separate from
the MCP server, loopback-only via the same `assertLoopback` ADR 0003 check): `POST /v1/pull`
(`src/sync/pull.ts`'s `servePull`, reusing `src/security/policy.ts`'s existing `mayReplicate` for
the 7.2 filter rather than re-implementing it) and `POST /v1/notify` (a per-peer 5-second debounce
before triggering one immediate `pullFromPeer`).

**The puller** (`pullFromPeer` in the same file): loops `/v1/pull` while `more` is true, applies
each event via `src/sync/apply.ts`'s `applyEvent`, and persists `through` into the existing
`sync_state` table after every page. `applyEvent` implements only the fast-forward and
already-known rows of Spec 7.3's table, plus relations (which never conflict per 7.4, so they
always apply once their entry exists): a missing-parent or genuinely concurrent content/status
event, and every `claim`/`meta` event, are still recorded in the event log (so a future
`ctxd rebuild`, once slices 3 and 5 land, can retroactively materialize them) but are not
materialized yet. `ctxd sync`'s output reports both counts (`N applied, M deferred`) rather than
hiding the gap.

**`sync` / `sync.serve`**: `sync` is the master switch for this machine's own participation
(pulling and, by nesting, serving: PRD-feature-flags-v1's own off-text for `sync` says "neither
pulls from nor serves peers"); `sync.serve` only narrows serving specifically, for a node that
wants to keep pulling updates without letting anyone pull from it. There is deliberately no flag
combination for "serve but never pull": a server with no peer configured to pull from has nothing
for its own interval loop to do, so no separate control is needed.

**`ME_SCOPE_ID` fix** (`src/core/kinds.ts`, used by `src/cli/init.ts`): found while writing the
end-to-end test. `_me`'s `scope_id` was `newId()` (random) per node, so two independently
initialized machines could never converge on personal-scope entries at all, the PRD's primary
motivating use case. It is now the fixed constant `"_me"` on every node. Named project scopes are
unaffected by this fix and do not converge yet; that is slice 6's job (see the table above).

**Deviations from the spec text, each one narrower than what it replaces, not silently done
differently:** "on reconnect" triggering is approximated by the scheduled interval's own retry on
its next tick, since detecting a reachability *change* (as opposed to periodically retrying)
needs a persistent connection or active probing this slice does not add.

**Tests:** `test/conformance/sync.test.ts`: two real `ctxd` processes, a real HTTP listener, real
peer-token auth; a local write pulled and applied; a second sync with nothing new applying zero
events; a pull with no bearer token rejected with 401. `test/unit/` additions for `servePull`'s
vector/through/filter arithmetic are deferred to the same pass as slice 3's conflict-policy tests,
since the two are easiest to test together against the same fixture data (SPEC v8 14 is updated
when that lands, not claimed early here).

## Slices 3 to 7

Each slice's own PR restates its piece of the bullet list in
`docs/build/M3-M6-kickoff-v1.md` section 1 in the same level of detail as slices 1 and 2 above,
written at the start of that slice's branch rather than all up front here, since slices 3 to 7
depend on decisions earlier slices make along the way. This document is updated with a row in the
table above, not rewritten, as each slice's branch opens.
