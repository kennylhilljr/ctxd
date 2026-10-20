# Spec v10 draft

Working notes collected while the completion kickoff ([docs/build/completion-kickoff-v1.md](../build/completion-kickoff-v1.md)) runs. M7 slice 8 folds this into the numbered Spec v10; until then each workstream appends its own section here instead of editing Spec v9 directly.

## W3: sync observability

Closes section 12's "last sync age" bullet and the gap `src/cli/status.ts`'s own comment used to describe: POST /v1/pull was stateless on the serving side, so this node had no way to answer "how far behind is each peer" or "how many of my events are peers still missing."

- **`peer_watermarks`** (schema v20): a new table, the served-side mirror of `sync_state`. Per `(peer_id, origin_node)`, the highest `origin_seq` this node has served that peer. `src/server/sync.ts`'s POST /v1/pull handler writes it (`recordServedThrough`) right after `servePull`, taking the max against any existing value so a retried or out-of-order page never regresses it.
- **`ctxd doctor`'s peer reachability check** now reports each peer's real last-sync age from `peers.last_synced_at` (already recorded per peer by a successful pull; the gap was that nothing used it), and warns past `sync.stale_hours` (new config field, default 24). A peer that has never synced uses its `created_at` so a freshly added peer is not immediately flagged stale.
- **`ctxd status`/`ctxd statusline`**'s `unsynced` count is real now: for each origin, the slowest active peer's served watermark against the highest `origin_seq` this node actually holds, summed across origins. `StatusInfo.unsynced` is `number`, no longer `number | null`.
- Verified in a real two-node test (`test/conformance/sync.test.ts`): after B's real pull from A, A's own `ctxd status` reports `0 unsynced` and `ctxd doctor` reports a real (non-placeholder) sync age for B, never "not tracked yet".
- No new feature flag: this is reporting only, under the existing `sync` flag, as the kickoff plan specifies.
