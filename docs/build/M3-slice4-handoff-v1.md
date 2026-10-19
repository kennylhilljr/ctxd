# M3 slice 4 handoff: purge propagation

Branch `m3/sync-purge`, off `m3/sync-conflicts` (PR #32, M3 slice 3, not yet merged at the time
this branched; a stacked PR like M2's sequential chain and slice 3's own stack on slice 2).
Implements the "Purge propagation" row of [M3-plan-v1](M3-plan-v1.md): Spec 7.6.6's two
remaining open items from M1, both of which turn out to be sync concerns, closed now that sync
exists.

## What landed

- **`src/sync/apply.ts`'s `decide()` gained a `purged` branch, checked first.** A non-purge event
  for an entry already purged locally is stripped to `{"purged": true}` before it is even stored
  (Spec 7.6.6 step 3), whatever kind of event it is and whatever decision it would otherwise have
  reached. A second purge event for an already-purged entry is let through instead (see below).
- **Purge (`meta`/`purge`) events are let through via sync, closing the gap that every `meta`
  event was previously only logged.** `purgeEntry`'s handler (`src/store/materialize.ts`) is an
  idempotent UPSERT keyed on `scope_id`/`kind`/`slug` carried in the event's own payload, so a
  purge received via sync reconstructs the same stub row whether or not the entry's `create` was
  materialized first. Two *independent* purges of the same entry (found during `/code-review`,
  see below) are not simply "no concurrent case to resolve", though: the handler now compares the
  incoming purge event's HLC against the row's `updated_hlc` and only lets a later HLC overwrite
  an already-purged row, so every node converges on the same purge's metadata regardless of
  arrival order.
- **`PullOutcome` gained a `purged` count**, reported separately from `deferred` in `ctxd sync`'s
  output line, so stripped late arrivals are visible instead of folding into one of the other
  buckets.
- `src/store/purge.ts`'s doc comment updated: the "strip late arrivals" scope note that used to
  say "no replication in M1" now points at `decide()` and this slice.

## Verification

- `npm run typecheck` / `npm run build`: clean.
- `npm test`: 512/512 (run with `CTXD_BYPASS` unset; 510 before the code-review fix below added
  two more).
- `test/unit/sync-purge.test.ts` (new): a purge event fast-forwards even with no prior `create`
  materialized locally, reconstructing the stub row from the payload alone; a duplicate purge
  event is `already-known` on replay; a late content update for an already-purged entry is
  stored with `{"purged": true}`, never its real content, and the entry stays purged; two
  independent purge events for the same entry converge on the later-HLC one's fingerprint
  whichever order they are applied in (added for the code-review fix below).
- `/simplify` (combined review of the slice's diff, small enough for one pass): no reuse or
  simplification issues; one efficiency finding, applied — `decide()` was running two separate
  `SELECT ... FROM entries WHERE entry_id = ?` queries (one for `purged_at`, one for the head
  rev) for every event. Merged into a single `loadEntryState()` query returning both, with an
  `EntryState` interface and `HEAD_REV_COLUMN` retyped to the three real column names so the
  head-rev lookup can index directly into that one row.
- `/code-review`: three findings, two fixed, one documented as a known remaining gap.
  1. **Fixed, real correctness bug.** Two nodes independently purging the same entry while
     partitioned (each from their own unsynced content) produce two distinct purge events with
     two different fingerprints. The first cut of this slice stripped the second one outright,
     the same as any other late arrival for an already-purged entry, so whichever purge event a
     given node happened to apply first won there permanently, letting different nodes converge
     on different `purge_fingerprint` values for the same `entry_id` (a convergence violation,
     Spec 7.3). Fixed: `decide()` now lets a second purge event through instead of stripping it,
     and `materialize.ts`'s purge handler compares the incoming event's HLC against the row's
     current `updated_hlc`: an older-or-equal HLC is a no-op for the row (its own stored event
     keeps its real fingerprint, just never promoted to `purge_fingerprint`), a later HLC
     overwrites it. Every node now converges on the same, highest-HLC purge's metadata regardless
     of arrival order. The one-time erasure side effects (FTS row delete, relations, open flags,
     rewriting every other stored event) only run on the entry's first purge; replaying them for a
     later "winning" purge against an already-erased row corrupted the FTS index (`database disk
     image is malformed`), caught by the new tests below.
  2. **Fixed, missing test coverage.** AGENTS.md requires property tests for convergence on every
     sync/apply change; this slice's rewrite of `decide()`/`applyEvent()` had none. Added three
     tests to `test/unit/sync-purge.test.ts` covering the concurrent-purge fix: an earlier-HLC
     second purge is a no-op for the row; a later-HLC second purge overwrites the fingerprint; and
     an explicit forward/backward convergence test (same pattern as slice 3's conflict-order test)
     confirming both application orders settle on the same fingerprint.
  3. **Fixed, inaccurate doc wording.** `M3-plan-v1.md`'s slice 4 write-up claimed `decide()` "now
     returns fast-forward for every meta event unconditionally," which was already wrong even
     before the fix above (a second event for an already-purged entry returned `"purged"`, not
     `"fast-forward"`). Corrected to describe the actual precedence, including the concurrent-purge
     case.
  - Not fully closed: the reinsertion block (step 4) still only covers whichever fingerprint's
    HLC won a concurrent purge; the losing side's content could still be re-created elsewhere
    without being blocked, since `purge_fingerprint` is a single column per entry. Closing that
    fully means retaining more than one fingerprint per purge lineage, which is a real design
    decision (storage shape, lookup cost) rather than a one-line fix, so it is left open and
    named here rather than guessed at under this slice.

## Owner steps / open items

- Review and merge PR #32 (slice 3) before this one, then this one before slice 5 branches from it.
- `claim` events are still only logged, not materialized (slice 5: claims across nodes).
- Named project scopes still don't share a `scope_id` across nodes (slice 6); only `_me` purges
  can be exercised identically on two independently initialized nodes today.
