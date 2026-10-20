# W3 handoff v1

## Commits

- `53e225b` `W3: sync observability`

Branch `done/w3-sync-observability`, one commit on top of `main` at `d0fe584`. Nothing was pushed and no pull request was opened; that is the owner's step per the kickoff plan.

## Delivered

`peer_watermarks` (schema v20) records, per peer and origin, the highest `origin_seq` this node has served that peer: the served-side mirror of `sync_state`, which already tracked the pulling side. `src/server/sync.ts`'s POST /v1/pull handler writes it right after `servePull`, taking the max against any existing value.

`ctxd doctor`'s peer reachability check now reports each peer's real last-sync age from `peers.last_synced_at` (already recorded by a successful pull; nothing had used it for this), warning past a configurable `sync.stale_hours` (new config field, default 24 hours). A peer with no `last_synced_at` yet uses its `created_at`, so a freshly added peer is not immediately flagged stale.

`ctxd status`/`ctxd statusline`'s `unsynced` count is a real number now: for each origin, the slowest active peer's served watermark against the highest `origin_seq` this node actually holds, summed across origins. `StatusInfo.unsynced` is `number`, no longer `number | null`; the "not tracked yet" placeholder text is gone.

No feature flag was added: this is reporting only, under the existing `sync` flag, as the kickoff plan specifies.

Spec changes are in [docs/spec/SPEC-v10-draft.md](../spec/SPEC-v10-draft.md), which M7 slice 8 folds into the numbered Spec v10.

## Verification

`npm run typecheck` and `npm test`: 748 of 748 tests passing across 66 files.

- The existing convergence property test (`test/unit/sync-partition-property.test.ts`) still passes unchanged: it calls `servePull` directly, bypassing the HTTP layer where the new watermark recording lives, so its signature never changed.
- New `test/unit/sync-observability.test.ts` covers `recordServedThrough` and `countUnsynced` after a partition (the peer stops pulling, the count grows, then catches up to zero once it pulls again), a restart (the watermark survives closing and reopening the database), and a purge (the purge event itself is new and unserved until the next pull; purging never corrupts or resets the watermark). Also covers `peerSyncAges`: a never-synced peer uses `created_at` and is not immediately stale, a long-unsynced peer is, and a revoked peer is excluded.
- `test/unit/doctor.test.ts` and `test/unit/status.test.ts` updated for the new real values and new tests added for the stale-threshold warning and the never-synced case.
- `test/conformance/sync.test.ts` (two real `ctxd` processes, a real HTTP sync listener): a new case asserts the exit criterion directly — after B's real pull from A, A's own `ctxd status` reports `0 unsynced` and `ctxd doctor` reports a real (non-placeholder) answer for peer B, never "not tracked yet". B's own listener is never started in this test file's existing design, so B's peer-reachability line is correctly "unreachable" on A's side; that is pre-existing test scope, not something this slice changed.

## What was not done and why

Nothing from W3's scope was skipped. The task described two possible storage shapes ("a column on `sync_state` or a new table"); a new table (`peer_watermarks`) was used, since the served and pulled directions are keyed differently (`peer_id` vs. the peer's name) and mixing both into one table's rows would have made `sync_state`'s existing meaning ambiguous.

## Owner steps

- Merge this branch (owner's step, per the kickoff plan's section 0).
- `sync.stale_hours` defaults to 24; adjust it in `config.toml` under `[sync]` if a different warning threshold is wanted.
- This branch and `done/w5-correctness-gaps` (already a separate open PR) both bump `SCHEMA_VERSION` to 20 independently, each from `main`'s own current value of 19, exactly as the kickoff plan's section 0 anticipates ("If two workstreams both change the schema, the second to merge renumbers"). Whichever merges second needs its migration renumbered to 21 against the other's 20 before that merge, including bumping the version number inside its own migration block in `src/store/db.ts` and `src/store/schema.ts`'s comment.
