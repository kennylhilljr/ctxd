# M3 slice 7 handoff: sync freshness and the N-node partition property suite

Branch `m3/sync-freshness`, off `m3/sync-acl-events` (PR #39, M3 slice 6, not yet merged at the
time this branched). Implements the "Freshness and property tests" row of
[M3-plan-v1](M3-plan-v1.md#slices): Spec 11.1's sync-freshness header and stale-sync notice, and
the N-node partition property suite that is M3's own stated exit criterion.

## What landed

- **`src/sync/freshness.ts` (new):** `syncFreshness(db)` reports `{hasPeers, lastSyncedAt, stale}`
  from `peers.last_synced_at` (no peer at all is not "stale"; `stale` is true past 10 minutes
  since the last successful pull). Shared by `store/claim.ts`'s tentative-claim check (slice 5)
  and the brief's own header/notice.
- **`context_brief`'s `sync` field** is no longer hardcoded `null`: `null` with no peers, else
  `{last_synced_at, stale}`; a stale-sync notice is added to the brief when `stale` is true.
- **The N-node partition property suite** (`test/unit/sync-partition-property.test.ts`, new): three
  in-process SQLite nodes exchange `WireEvent`s through the real `servePull`/`applyEvent`
  functions (no HTTP), under random partitions, heals and delivery orders, asserting every node
  converges to the same materialized state and loses no event. It replaces direct HTTP calls with
  direct function calls so the whole matrix runs fast in-process; `test/conformance/sync.test.ts`
  still covers the transport itself with two real servers. A hand-written scripted test and a
  `fast-check` property test (50 random op sequences per run) both exercise it; the property test
  found six real, independent convergence bugs during this slice, each now a permanent regression
  test of its own (below).

## Real bugs found and fixed

All six were found by the property suite, not written to match a known gap; each is a genuine way
two correctly-partition-tolerant nodes could converge on different materialized state, not a
contrived edge case:

1. **A released-and-reclaimed claim lineage was invisible to its own conflict check.**
   `currentClaimHeadFor`/`currentClaimHead` only compared an incoming claim/release against the
   current lease when it was `active`; once released, a cross-origin claim or release naming that
   same claim as its parent fell through "head === null" and was treated as a brand-new, uncontested
   lineage (or silently dropped, for a release). Fixed: both now report the row's `claim_hlc`
   regardless of `state`, and `store/claim.ts`'s `claimTask` now sets a new claim's parentRevs to
   whatever local row already exists (active or closed), not only when active -- so a claim or
   release that actually continues what this node knows still matches, and one made in total
   ignorance of the task's history still falls through to the real conflict check.
2. **`earliest_claim_hlc` (new `leases` column):** a straggler claim racing an already-closed-and-
   reclaimed epoch needs comparing against the task's true earliest claimant across every epoch,
   not whichever claim happens to be active or most recently closed right now. Tracked as a
   monotonic minimum (never resets: two nodes resetting at different points, because per-origin
   pull batching does not guarantee cross-origin causal order, would disagree about what a late
   claim is even being compared against).
3. **A purged entry could be revived by a local update on the node that purged it.** `write.ts`'s
   update path never checked `purged_at` before accepting an `id` + `expected_rev` write, so the
   purging node's own next local edit materialized new content while every synced peer correctly
   refused the identical event (`sync/apply.ts`'s `purged_at` guard) -- a real, permanent split.
   Fixed: a purged entry is now treated as not found for updates, the same as a missing one.
4. **Cross-origin events could arrive out of causal order and get stuck or misjudged.**
   `servePull` pages events ordered by `(origin_node, origin_seq)` (Spec 7.1): that preserves each
   origin's own order but not causal order *across* origins. A dependent event (an update whose
   parent is another origin's edit, or a release whose target is another origin's claim) could
   arrive before what it depends on, and the old code either dropped it as "already resolved" or
   misjudged a clean, non-forking chain as a real content conflict. Fixed with a new
   `events.materialized` column and `retryPendingFor` (`src/sync/apply.ts`): a "missing-parent"
   event is stored but not materialized, and retried every time another event for the same entry
   successfully materializes, until its own parent actually arrives. `decide`'s mismatch handling
   for content/status (`revEverRecorded`) and releases (`claimHlcEverRecorded`) now also
   distinguishes "this parent was never recorded at all" (defer) from "this parent was recorded
   and is provably superseded" (resolve now) -- both checks require `materialized = 1`, not just a
   stored row, so a parent that is itself still pending is never mistaken for one that has arrived
   (found during `/code-review`).
5. **Two independent releases of the same still-active claim raced on arrival order, not HLC.**
   A human client can release a claim it never held (`releaseTask`'s override), so two different
   holders can each release the same claim while partitioned, both naming the same `claim_hlc` as
   parent. The release handler applied whichever one a node happened to process last, unconditionally
   overwriting `released_at`/`changed_files`/`drift`. Fixed with the same HLC-guarded-upsert
   pattern purge (slice 4) already uses (now shared as `isStaleByHlc`): once a lease is closed, a
   second release of the same epoch only overwrites when its own hlc is at least as new as what is
   already recorded.
6. **Schema version was not bumped for the two new columns** (`events.materialized`,
   `leases.earliest_claim_hlc`) added in this slice (found during `/code-review`): a pre-existing
   database at the prior version would have skipped `SCHEMA_SQL` entirely and failed with a raw
   SQLite error on the next claim or sync, instead of the intended clear version-mismatch error.
   Fixed: bumped to 12.

## Deliberately out of scope, named rather than guessed at

`test/unit/sync-partition-property.test.ts`'s random fuzzer deliberately excludes `release`: a
claim made in total isolation that happens to reference its own prior claim as parent (a renewal
or a proven reclaim, both legitimate) is indistinguishable at the wire-event level from the same
claim racing a cross-origin release of that exact lineage it never saw. `servePull`'s per-origin
ordering guarantee ("a claim always arrives before its own later release from the same origin")
does not cover a release issued by a *different* origin than the claim it targets (the human
override above), so which side a given node happens to apply first can still decide the outcome in
that specific, three-way confluence (the original claimant, a different node's human-override
release of it, and the original claimant's own independent reclaim, all before any of the three
ever sync with each other). The six hand-written regression tests above cover every release
scenario this suite does reliably converge on; the fuzzer's comment (just above its `opArb`) names
this gap so it is not silently narrowed by accident later. Closing it fully needs the claim/release
wire events to carry proof of what they observed (e.g. a causal reference beyond a bare parent
hlc), not a targeted patch, so it is named here rather than attempted under this slice.

## Verification

- `npm run typecheck` / `npm run build`: clean.
- `npm test` (`CTXD_BYPASS` unset): 550/550, run clean 8+ consecutive times in a row (the property
  test is randomized; this is the confidence bar that mattered here, not a single green run).
- `test/unit/sync-partition-property.test.ts`: the scripted mixed-operation test (forward and
  reverse heal order converge to the same semantic state, compared by title/role rather than raw
  id since each order calls `setupNodes` independently); the random property test (50 runs, its
  own 20s timeout since a long deferred-event chain can occasionally run past vitest's 5s
  default); six hand-reduced regression tests, one per bug above.
- `test/unit/brief.test.ts`: three new tests for the `sync` header field and stale-sync notice (no
  peers, a recent peer, a stale peer).
- `test/unit/sync-claims.test.ts`: two pre-existing tests updated for the new, more precise
  `decide` outcomes for a stale release (now `"conflict-resolved"`, resolved immediately since the
  target claim was recorded) and a duplicate release of an already-released claim (now
  `"fast-forward"`, since `release` never changes `claim_hlc` so a second release naming the same
  parent matches directly).

## `/simplify`

Four parallel reviewers found, and all were applied:

1. `src/sync/apply.ts`'s `pendingRowToWireEvent`/`PendingRow` duplicated `src/sync/pull.ts`'s own
   row-to-`WireEvent` mapper field for field. Moved the mapper (renamed `toWireEvent`/`EventRow`)
   into `apply.ts` and exported it; `pull.ts` (which already imports `WireEvent` from `apply.ts`,
   so no import cycle) now reuses it, adding only the one extra column its own replication filter
   needs via an intersection type.
2. `materialize.ts`'s claim-release branch ran two separate `SELECT`s against the same `leases`
   row (`currentClaimHeadFor`, then a second query for `state`/`last_activity_hlc`). Folded the
   extra columns into `ClaimHead`/`currentClaimHeadFor`'s one query.
3. The new racing-release guard duplicated the existing stale-by-HLC comparison the purge handler
   already used. Extracted a shared `isStaleByHlc` helper, used by both.
4. The eight hand-written regression tests repeated an identical four-line setup/heal/assert
   sequence. Extracted `runScript(ops)`. (Also caught, in the process: two of the eight tests
   covered the exact same two-independent-releases bug; removed the duplicate.)

Skipped: `retryPendingFor`'s per-pass full re-query of `events WHERE materialized = 0` is not
narrowed to an in-memory set of previously-blocked rows (flagged as a possible O(n^2) cost over a
long deferred chain) -- this is a cold path (most entries never have a deferred event at all), and
narrowing it would add real complexity for a case the property suite's own timing shows is not
currently a practical problem.

## `/code-review`

Two findings, both real, both fixed:

1. `SCHEMA_VERSION` was not bumped despite two new columns (see bug 6 above).
2. `revEverRecorded`/`claimHlcEverRecorded` (bug 4 above) did not filter on `materialized = 1`,
   so a parent event that was itself still deferred (stored but not yet applied) was wrongly
   treated as proof its target had already arrived. A three-hop cross-origin chain where the
   middle link is still pending could resolve the third link against the wrong head and
   permanently mark it materialized, with no second chance once the real chain caught up. Fixed:
   both checks now also require `materialized = 1`.

No AGENTS.md rule violations found (loopback, hooks-exit-0, event-log-as-truth, default-deny,
no real names, purge-is-the-only-rewrite, feature-flag rule).

## Owner steps / open items

- Review and merge PR #34 (slice 4), #38 (slice 5) and #39 (slice 6) in order before this one.
- M3-plan-v1's slice 7 table row cited Spec section 10.2 for sync freshness; the actual spec
  section is 11.1 (brief assembly), which already named the header/notice fields this slice fills
  in. Corrected in this update.
- See "Deliberately out of scope" above for the one named gap (release vs. a concurrent claim's
  own reclaim, in a specific three-way confluence the random fuzzer no longer exercises).
- Once this merges, `integration/m3` combines all seven slices, the same way `integration/m1-m2`
  was done.
