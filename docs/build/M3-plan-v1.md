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
| 3 | Conflict policies, siblings, review | `m3/sync-conflicts` | `m3/sync-protocol` | Spec 7.4; per-part conflict policies for the "Concurrent" row of 7.3's table (status, and content for every kind: lww for status/brief, conflicted for the rest); `entry_siblings`; `conflicted` status; surfacing both in `ctxd review`; missing-parent events, and `claim`/`meta` events, remain deferred to slices 4 and 5 |
| 4 | Purge propagation | `m3/sync-purge` | `m3/sync-conflicts` | Spec 7.6.6; purge (`meta`/`purge`) events now fast-forward unconditionally when received via sync, closing the gap that `decide` previously deferred every `meta` event; step 3's strip-on-receipt for any event (of any op) arriving for an already-purged entry |
| 5 | Claims across nodes | `m3/sync-claims` | `m3/sync-purge` | Spec 7.4's claim rows; tentative claims while offline; deterministic earliest-claim_hlc tie-break (loser recorded as a lost `entry_siblings` row, not a `leases.state`); local- and sync-origin overlap detection into `claim_overlaps` |
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

## Slice 3: conflict policies

**Where the detection lives.** `src/store/materialize.ts`'s `applyEvent` (already shared by the
live write path and `ctxd rebuild`) gained a third caller-contract: an optional `parentRevs` on
`EventForMaterialize`. Every existing call site (the live write path, `ctxd review`'s resolve)
omits it, since both already know they are building the next revision from a head they just read,
by construction; their behavior is unchanged. `ctxd rebuild` and `src/sync/apply.ts` both supply
it, since both can legitimately receive a concurrent event, and both need to resolve it exactly
the same way for the convergence property (Spec 7.4: "every node that has applied the same set of
events reaches identical materialized state") to hold through a rebuild as well as through live
sync. Putting the check inside `materialize.ts` itself, rather than in `sync/apply.ts` alone, is
why this works: a conflict resolution is computed once and reused, not reimplemented per caller.

**Status (all kinds).** A human-client event wins outright; otherwise the later HLC wins. The
loser is recorded in `entry_siblings` with reason `lww`.

**Content, by kind.** `status` and `brief`: last-writer-wins by HLC, loser recorded with reason
`lww`, status untouched (`ctxd review`'s `auto_resolved`). Every other mutable kind (`convention`,
`fact`, `lesson`, `note`, `task`, plus `preference` and `skill`, which the spec table does not
name explicitly: treated the same as the conservative, surface-for-review bucket rather than
guessing they are safe to auto-merge): the entry moves to `status = 'conflicted'` directly (not
its own replicated event: every node that applies the same two concurrent content events computes
`conflicted` independently and identically, the same way `entry_siblings` rows themselves are
derived, not replicated); both revisions are kept, head is the higher HLC. Clearing a `conflicted`
status reuses the existing `ctxd review --approve` path (`resolveEntry`, built in M2 for
`proposed`), rather than building a separate merge-resolve mechanism for a "resolve event whose
parent_revs lists both" that nothing yet needs in practice.

**Decide, in `src/sync/apply.ts`.** Extended from a boolean fast-forward check into a four-way
decision (`fast-forward` / `concurrent` / `missing-parent` / `deferred`): `concurrent` now flows
through `materializeEvent` with `parentRevs` attached instead of being deferred; `missing-parent`
(the entry does not exist locally at all yet) and `deferred` (`claim`/`meta` events) are unchanged
from slice 2. `ctxd sync`'s output gained a third count: `N applied, M resolved by conflict
policy, K deferred`.

**A real bug found by testing this, fixed, not merely noted:** `makeRev` (`src/core/ids.ts`) took
a ULID's first 10 characters for a revision's suffix. Those 10 characters are a millisecond
timestamp, not random, so two events minted in the same millisecond, exactly what two concurrent
updates racing to the same version number are, produced the identical rev string, and the new
conflict lookup (`eventHoldingRev`, keyed on rev) could not tell them apart. Fixed to take the
*last* 10 characters instead, inside the ULID's random suffix; nothing in the codebase parses the
suffix's meaning, only compares it for equality, so this needed no migration. `test/unit/ids.test.ts`
is the regression test.

**Tests:** `test/unit/sync-conflicts.test.ts`, built directly on `src/sync/apply.ts`'s
`applyEvent` rather than through spawned CLI processes (deterministic, no port/timing dependence):
content conflict resolution for both the lww and conflicted buckets, status conflict resolution
for both the human-override and later-HLC cases, order-independence (the same two concurrent
events applied in either order reach the same final state), `ctxd review`'s `conflicted` and
`auto_resolved` categories populated from real data, and `ctxd review --approve` clearing a
conflict. `test/unit/ids.test.ts` for the `makeRev` fix.

## Slice 4: purge propagation

**A gap the plan did not originally name.** Slices 2 and 3 both deferred every `meta`-part event
(the only op on that part is `purge`) alongside `claim` events, treating both as needing their own
later slice. That was right for `claim` (real cross-node tie-break semantics, slice 5) but wrong
for `purge`: the handler (`src/store/materialize.ts`, M1) is already an idempotent UPSERT, order-
and retry-tolerant by construction. `src/sync/apply.ts`'s `decide` now lets every `meta`/`purge`
event through instead of only logging it, so a purge done on one node now actually erases the
entry on a peer that syncs it, which (checked while writing this slice) it previously never did
at all. `decide` does not treat this as a plain, unconditional fast-forward, though: see the
concurrent-purge case below, which is also a `meta` event but is resolved, not just passed
through.

**Step 3, stripping late arrivals.** `decide` checks `entries.purged_at` before anything else: if
the target entry is already purged locally and the incoming event is *not itself a purge event*,
it is stored with `payload` replaced by `{"purged": true}` and `prev` cleared to `NULL`, the exact
shape a *local* purge rewrites every other stored event to (`store/purge.ts`), and is never
materialized. This covers a genuinely late content/status edit from an offline peer.

**Concurrent purges of the same entry, found by `/code-review`.** Two nodes can each purge the
same entry independently while partitioned, each from their own unsynced content, producing two
purge events with two different fingerprints. The first version of this slice stripped the second
one outright (treating it like any other late arrival for an already-purged entry), so whichever
purge event a given node happened to apply first won there permanently: different nodes could
converge on different `purge_fingerprint` values for the same entry, and the losing fingerprint's
reinsertion block (step 4) was lost. Fixed: `decide` lets a second purge event through instead of
stripping it, and `materialize.ts`'s purge handler itself now compares the incoming event's HLC
against the row's current `updated_hlc`; an older-or-equal HLC is a no-op for the row (its own
event payload is still stored with its real fingerprint, just never promoted to `purge_fingerprint`),
a later HLC overwrites it. Every node converges on the same, highest-HLC purge's metadata
regardless of arrival order. The reinsertion-block gap for the non-winning fingerprint is narrower
now (only a concurrent purge's losing side, not every out-of-order arrival) but still open; closing
it fully would mean retaining more than one fingerprint per entry, deferred rather than designed
under this slice.

**Tests:** `test/unit/sync-purge.test.ts`: a purge event fast-forwards and reconstructs the stub
row with no prior create materialized locally; the same purge event applied twice is
`already-known` the second time; a late content update for an already-purged entry is stored
stripped and never un-erases the entry; two independent purge events for the same entry converge
on the later-HLC one's fingerprint whichever order they are applied in, including the case of a
strictly earlier-HLC second purge arriving after the row is already settled.

## Slice 5: claims across nodes

**Claim events now carry a real parent.** Before this slice, a `claim` event's `parent_revs`
column was always the literal `'[]'`, and `src/sync/apply.ts`'s `decide` fast-forwarded every
`claim`/`release` event unconditionally, deferring the actual cross-node semantics entirely.
`claim.ts` now sets `parentRevs` to the prior active lease's `claim_hlc` for a renewal or
take-over, `[]` only for a genuinely fresh claim; `decide` compares that against the task's
current active `claim_hlc` (`leases`' head for the claim part, parallel to `*_rev` for
content/status) through the exact same fast-forward/concurrent fork those parts already use.

**Concurrent claims on one task (Spec 7.4).** Two nodes can each claim the same task
independently while partitioned, each unaware of the other, each writing `parentRevs: []`. When
the second one syncs, its parent no longer matches the live lease: `decide` returns
`"concurrent"`, routing it to a new `applyClaimConflict` in `src/store/materialize.ts`, which
mirrors the existing content/status conflict shape (`resolveConflict`) instead of inventing its
own. The earliest `claim_hlc` wins regardless of which claim a given node applies first (the
convergence property, 7.3); the other claim never becomes active and is recorded as a lost
`entry_siblings` row (`part` widened to allow `'claim'`) instead of needing the single `leases`
row to represent two outcomes at once.

**A stale release is a no-op, not a crash.** A release's `parentRevs` names the exact claim it
targets; if that claim has since been superseded (a take-over, a newer claim, or an earlier
duplicate release), `decide` still routes it to the conflict-checking path, and
`applyReplicatedEvent`'s release branch finds the mismatch and does nothing, instead of
clobbering whatever claim is actually active now.

**Write-intent overlaps across tasks (Spec 7.4's other row).** A new `src/claims/overlap.ts`
holds `scanOverlappingLeases` and `persistOverlaps`, shared by `claim.ts`'s local, synchronous
overlap check (origin `claim`, closing a gap `claim_overlaps` left unused since M1/M2: the schema
allowed it but nothing ever wrote to it) and `materialize.ts`'s replicated path (origin `sync`,
this slice's own named requirement). Sharing one helper, called from both the live-local and the
replicated path, is what makes `ctxd rebuild` -- which always replays through the replicated path,
whatever an event's true origin was -- reproduce the exact same rows a live claim already wrote,
instead of creating new ones a live system never had or skipping ones it did.

**Tentative claims.** `isTentative` (`claim.ts`) flags a claim when this node has a peer at all
and none has completed a successful pull in the last 10 minutes (`peers.last_synced_at`, set by
`src/sync/pull.ts` on every completed pull); a node with no peers is exempt, so a non-sync
install's claims behave exactly as before this slice.

**A real bug in `rebuild.ts`, found while writing this slice's tests.** It hardcoded `parentRevs`
to `[]` for every op except `update`/`status`, an optimization from before claims needed a real
parent. Once they did, every claim/release event silently lost its parent during a rebuild,
making every take-over look like a fresh claim and every release look stale (never applying).
Fixed by adding `claim`/`release` to the ops it bothers to parse `parent_revs` for.

**Found by `/code-review` after the redesign, all fixed:** `persistOverlaps` wrote the same
`{mine, theirs}`-oriented pattern pairs into both directions' rows, so the reverse row's own
"mine" named the other task's pattern instead of its own; fixed by swapping orientation for the
second row. `decide`'s claim branch returned `"missing-parent"` (deferred forever) for a release
whose target claim had already left `'active'`, rather than the `"concurrent"` path that already
handles it correctly; fixed, reasoning from `pull.ts`'s per-origin ordering guarantee that a
release can never genuinely outrace its own claim, so this case is always "already resolved," not
"still arriving." The same branch also didn't check `op`, so a future `suspend`/`resume` claim
event (not yet reachable; quarantine-driven claim suspension isn't wired up yet) would have been
misclassified as concurrent; fixed. `applyClaimConflict` recorded the losing claim's
`entry_siblings.rev` as an HLC on one side of the race and a `makeRev` revision string on the
other; fixed to use the HLC consistently on both sides. The now-dead `"deferred"` `Decision`
value (its only producer was removed by this slice's own redesign) was removed along with the
dead branch checking for it.

**Deliberately out of scope, named rather than guessed at:**
- Taken-over and lost claims still don't surface a brief notice ("your claim on T was taken over
  by..."); SPEC 7.5.4 names the exact wording, but `src/brief/assemble.ts`'s notices section
  doesn't implement any claim-state notice yet, a gap predating this slice (M2).
- Under a scope's `strict` intent policy, a sync-detected overlap doesn't additionally flag the
  later claim for review (Spec 7.4's last sentence); it is recorded in `claim_overlaps` but not
  otherwise acted on. Doing so means synthesizing a system-raised `flag` event, a large enough
  addition to warrant its own slice rather than folding into this one.
- A from-scratch `ctxd rebuild` can record a locally-originated overlap's `claim_overlaps.origin`
  as `'sync'` instead of `'claim'` (every event replays through the replicated path regardless of
  where it first came from). An incremental rebuild of an already-populated database never hits
  this, since the ON CONFLICT clause never overwrites an existing row's origin. Closing the
  from-scratch case fully means threading the event's own `origin_node` through every trusted
  `applyEvent` call site across the codebase (write.ts, flag.ts, review.ts, purge.ts, hygiene.ts),
  well beyond this slice's files; nothing reads `claim_overlaps.origin` yet, so this is named here
  rather than fixed speculatively.

## Slices 6 and 7

Each slice's own PR restates its piece of the bullet list in
`docs/build/M3-M6-kickoff-v1.md` section 1 in the same level of detail as slices 1 to 5 above,
written at the start of that slice's branch rather than all up front here, since slices 6 and 7
depend on decisions earlier slices make along the way. This document is updated with a row in the
table above, not rewritten, as each slice's branch opens.
