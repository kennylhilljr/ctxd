# M3 slice 3 handoff: conflict policies

Branch `m3/sync-conflicts`, off `m3/sync-protocol` (PR #28, M3 slice 2, not yet merged at the
time this branched; a stacked PR like M2's sequential chain). Implements the "Conflict policies,
siblings, review" row of [M3-plan-v1](M3-plan-v1.md): Spec 7.4's policies for a genuinely
concurrent sync arrival, closing the "Concurrent" row of 7.3's apply table that slice 2 deferred.

## What landed

- **Conflict detection and resolution live in `src/store/materialize.ts`**, not in sync alone:
  `applyEvent` (trusted fast-forward, used by the write path and `ctxd review`'s resolve) and a
  new `applyReplicatedEvent` (checks `parentRevs` against the current head; used by `ctxd rebuild`
  and sync's puller) are two entry points over one shared core, so a conflict resolves identically
  whichever one encounters it, and the convergence property holds through a rebuild too.
- **Status (all kinds)**: a human-client event wins outright; otherwise later HLC wins. Loser to
  `entry_siblings` (reason `lww`).
- **Content**: `status`/`brief` kinds are last-writer-wins (reason `lww`, `ctxd review`'s
  `auto_resolved`); every other mutable kind (`convention`, `fact`, `lesson`, `note`, `task`,
  plus `preference`/`skill`, not named in the spec table but put in the conservative bucket
  rather than guessed safe) moves to `status = 'conflicted'` (reason `conflict`, `ctxd review`'s
  `conflicted`), both revisions kept, head at the higher HLC. Clearing it reuses the existing
  `ctxd review --approve` path from M2.
- `src/sync/apply.ts`'s `decide()` is now a 4-way classification (fast-forward / concurrent /
  missing-parent / deferred); `ctxd sync`'s output reports all three real outcomes.
- A real bug found and fixed while testing this: `makeRev` (`src/core/ids.ts`) took a ULID's
  first 10 characters (a timestamp, not random) for a revision's suffix, so two events minted in
  the same millisecond, exactly what two concurrent updates racing to the same version are,
  produced an identical rev string. Now takes the last 10 (inside the random suffix).

## Verification

- `npm run typecheck` / `npm run build`: clean.
- `npm test`: 505/505 (run with `CTXD_BYPASS` unset).
- `test/unit/sync-conflicts.test.ts`: content conflict resolution (both lww and conflicted
  buckets), order-independence, status conflict resolution (human-override and later-HLC cases),
  `ctxd review`'s categories populated from real data, `ctxd review --approve` clearing a
  conflict. `test/unit/ids.test.ts`: regression test for the `makeRev` fix.
- `/simplify` (4 parallel reviews). Applied: `isHumanClient` now calls the existing `loadClient`
  instead of a raw query that skipped the revoked-client check (a real gap: a revoked human's old
  event could otherwise still win by vendor tiebreak); extracted a shared `mergeAndUpdateContent`
  that the plain content-update handler and the conflict-winner path both now call, instead of
  two copies of the same merge-and-UPDATE SQL; `recordSibling` exported and reused in
  `hygiene.ts`, which had its own inline copy of the same insert predating this slice;
  `LWW_CONTENT_KINDS` moved to `core/kinds.ts` alongside `IMMUTABLE_KINDS`/`ALWAYS_REVIEWED_KINDS`;
  a `recordLoser`-shaped `resolveConflict` helper collapsing the status/content conflict
  functions' shared "record the loser, maybe apply the winner" skeleton; `apply.ts` no longer
  passes `parentRevs` through for an already-confirmed fast-forward event, so `materialize.ts`
  doesn't re-run the query `decide()` already paid for; `rebuild.ts` only parses `parent_revs`
  JSON for `update`/`status` events, not every event in the log; a new `events(entry_id, rev)`
  index backs the new lookup (schema bumped to 9); the optional `parentRevs?` field that made
  "trusted" vs. "needs a conflict check" an implicit runtime branch was replaced by two separate
  exported entry points, so a future caller's intent is a compile-time fact.
- `/code-review`: two findings, both fixed. (1) A winning conflict resolution never called
  `closeOpenFlags`, unlike every ordinary content update (SPEC 7.6.1: "Edit... also closes open
  flags"), so a flag on an entry that was just resolved by sync stayed open indefinitely; fixed,
  with a regression test. (2) A comment in `src/sync/apply.ts` claimed the concurrent branch
  avoided a redundant query that `decide()` already paid for; actually only the fast-forward
  branch does, since the concurrent branch's conflict resolution genuinely needs its own lookup
  (the matching `events` row, not just the rev string); comment corrected.

## Owner steps / open items

- Review and merge PR #28 (slice 2) before this one, then this one before slice 4 branches from it.
- Missing-parent events and every `claim`/`meta` event are still only logged, not materialized
  (slices 4 and 5).
- Named project scopes still don't share a `scope_id` across nodes (slice 6); only `_me` can
  reach a real content/status conflict today, since that's the only scope two independently
  initialized nodes agree on.
